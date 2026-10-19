import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { sweepReconciliations } from "@/lib/fold/sweep";
import { PostgresSweepRoundStore } from "@/lib/fold/sweep-round-store";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
const next = new Date("2030-01-01T06:00:00Z");
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "sweep", user: "sweep", password: randomUUID() });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});
beforeEach(async () => { await sql`delete from reconciliation_sweep_round`; });
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original;
});

describe("durable sweep round", () => {
  it("offers every repository within six hours at the production 15-second poll cadence", async () => {
    const store = new PostgresSweepRoundStore(sql);
    const ids = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0"));
    const offered: string[] = [];
    for (let elapsed = 0; elapsed < 6 * 60 * 60_000; elapsed += 15_000) {
      const now = new Date(at.getTime() + elapsed);
      const summary = await sweepReconciliations({
        round: store, now: () => now, listActiveRepositoryIds: async () => ids,
        enqueue: async (id) => { offered.push(id); },
      });
      expect(summary.enqueued).toBeLessThanOrEqual(1);
      if (summary.enqueued === 1) {
        await store.spend(now, 3000);
        await store.spend(now, 3000);
      }
    }
    expect(offered).toEqual(ids);
    expect(await sql`select spent from reconciliation_sweep_round`).toEqual([{ spent: 200 }]);
  });

  it("restarts the deadline chain after a long outage without emitting a catch-up burst", async () => {
    const store = new PostgresSweepRoundStore(sql);
    const ids = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0"));
    const offered: string[] = [];
    const offer = async (id: string) => { offered.push(id); };
    await store.enqueueNext(ids, at, 3000, offer);
    const resumedAt = new Date(at.getTime() + 900_000);
    expect(await store.enqueueNext(ids, resumedAt, 3000, offer)).toBe("001");
    expect(await store.enqueueNext(ids, resumedAt, 3000, offer)).toBeNull();
    expect(await store.enqueueNext(ids, new Date(at.getTime() + 915_000), 3000, offer)).toBeNull();
    expect(await store.enqueueNext(ids, new Date(at.getTime() + 1_110_000), 3000, offer)).toBeNull();
    expect(await store.enqueueNext(ids, new Date(at.getTime() + 1_125_000), 3000, offer)).toBe("002");
    expect(await sql`select next_enqueue_at from reconciliation_sweep_round`)
      .toEqual([{ next_enqueue_at: new Date(at.getTime() + 1_332_000) }]);
    expect(offered).toEqual(["000", "001", "002"]);
  });

  it("retries the same durable slot after the production sweep reports an enqueue failure", async () => {
    const store = new PostgresSweepRoundStore(sql);
    const attempted: string[] = [];
    const failures: string[] = [];
    let reject = true;
    const tick = (now: Date) => sweepReconciliations({
      round: store, now: () => now, listActiveRepositoryIds: async () => ["a", "b"],
      enqueue: async (id) => { attempted.push(id); if (reject) throw new Error("queue unavailable"); },
      onFailure: (id) => { failures.push(id); },
    });
    expect(await tick(at)).toEqual({ attempted: 1, enqueued: 0, failed: 1 });
    reject = false;
    expect(await tick(new Date(at.getTime() + 15_000))).toEqual({ attempted: 1, enqueued: 1, failed: 0 });
    expect(attempted).toEqual(["a", "a"]);
    expect(failures).toEqual(["a"]);
    expect(await sql`select rotation_cursor from reconciliation_sweep_round`).toEqual([{ rotation_cursor: "a" }]);
  });

  it("atomically admits exactly the ceiling under concurrent stores and survives restart", async () => {
    const stores = Array.from({ length: 16 }, () => new PostgresSweepRoundStore(sql));
    const holds = await Promise.all(Array.from({ length: 64 }, (_, index) => stores[index % 16]!.spend(at, 17)));
    expect(holds.filter((hold) => hold === null)).toHaveLength(17);
    expect(holds.filter((hold) => hold?.getTime() === next.getTime())).toHaveLength(47);
    expect(await new PostgresSweepRoundStore(sql).spend(at, 17)).toEqual(next);
    expect(await new PostgresSweepRoundStore(sql).spend(next, 17)).toBeNull();
    expect(await sql`select spent from reconciliation_sweep_round`).toEqual([{ spent: 1 }]);
  });
  it("paces one repository per slot, resumes on startup, stops when spent, and rotates next window", async () => {
    let store = new PostgresSweepRoundStore(sql);
    const queued: string[] = [];
    const offer = async (id: string) => { queued.push(id); };
    expect(await store.enqueueNext(["c", "a", "b"], at, 2, offer)).toBe("a");
    store = new PostgresSweepRoundStore(sql);
    expect(await store.enqueueNext(["c", "a", "b"], at, 2, offer)).toBeNull();
    await store.spend(at, 2);
    expect(await store.enqueueNext(["c", "a", "b"], new Date("2030-01-01T02:00:00Z"), 2, offer)).toBe("b");
    await store.spend(at, 2);
    expect(await store.enqueueNext(["c", "a", "b"], new Date("2030-01-01T04:00:00Z"), 2, offer)).toBeNull();
    expect(await store.enqueueNext(["c", "a", "b"], next, 2, offer)).toBe("c");
    expect(await store.enqueueNext(["c", "a", "b"], new Date("2030-01-01T08:00:00Z"), 2, offer)).toBe("a");
    expect(queued).toEqual(["a", "b", "c", "a"]);
  });
  it("does not lose a slot if enqueue fails and handles empty and changing lists", async () => {
    const store = new PostgresSweepRoundStore(sql);
    expect(await store.enqueueNext([], at, 3000, async () => {})).toBeNull();
    await expect(store.enqueueNext(["a"], at, 3000, async () => { throw new Error("queue unavailable"); })).rejects.toThrow();
    expect(await store.enqueueNext(["a"], at, 3000, async () => {})).toBe("a");
    expect(await store.enqueueNext(["a"], new Date("2030-01-01T05:59:59Z"), 3000, async () => {})).toBeNull();
    expect(await store.enqueueNext(["b"], next, 3000, async () => {})).toBe("b");
  });
});
