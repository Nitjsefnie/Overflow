import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { sweepReconciliations } from "@/lib/fold/sweep";
import { PostgresSponsorSweepRoundStore } from "@/lib/fold/sponsor-sweep-round-store";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
const next = new Date("2030-01-01T06:00:00Z");
let externalId = 8_000_000;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "sweep", user: "sweep", password: randomUUID() });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});
beforeEach(async () => {
  await sql`delete from reconciliation_sweep_round`;
  await sql`delete from reconciliation_sweep_rounds`;
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

async function insertSponsor(): Promise<string> {
  const githubUserId = 5_000_000 + (externalId += 1);
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`sponsor-${externalId}`}) returning id`;
  return row.id;
}

describe("per-sponsor durable sweep rounds", () => {
  it("holds a sponsor at its own limit while the other sponsor's sweep keeps enqueueing and folding", async () => {
    const store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorA = await insertSponsor();
    const sponsorB = await insertSponsor();
    const offered: string[] = [];
    const offer = async (id: string) => { offered.push(id); };

    // Sponsor A spends its whole window: two folds admitted, then held.
    expect(await store.spend(sponsorA, at, 2)).toBeNull();
    expect(await store.spend(sponsorA, at, 2)).toBeNull();
    expect(await store.spend(sponsorA, at, 2)).toEqual(next);

    // A's budget is spent, so A's rotation stops; B's own budget is untouched.
    expect(await store.enqueueNext(sponsorA, ["a1", "a2"], at, 2, offer)).toBeNull();
    expect(await store.enqueueNext(sponsorB, ["b1", "b2"], at, 2, offer)).toBe("b1");
    expect(await store.enqueueNext(sponsorB, ["b1", "b2"], at, 2, offer)).toBeNull();
    expect(await store.spend(sponsorB, at, 2)).toBeNull();

    // A is held for the rest of its window, including at another poll in it.
    expect(await store.enqueueNext(sponsorA, ["a1", "a2"], new Date(at.getTime() + 3_600_000), 2, offer)).toBeNull();

    // At A's own window reset A's rotation resumes and B's cursor is its own.
    expect(await store.enqueueNext(sponsorA, ["a1", "a2"], next, 2, offer)).toBe("a1");
    expect(await store.enqueueNext(sponsorB, ["b1", "b2"], next, 2, offer)).toBe("b2");
    expect(offered).toEqual(["b1", "a1", "b2"]);
    expect(await sql`select * from reconciliation_sweep_round`).toEqual([]);
  });

  it("anchors a sponsor's window at its first touch, starting from zero", async () => {
    const store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    expect(await store.spend(sponsorId, at, 3000)).toBeNull();
    const [row] = await sql<{ window_start: Date; spent: number; next_enqueue_at: Date }[]>`
      select window_start, spent, next_enqueue_at from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`;
    expect(row).toEqual({ window_start: at, spent: 1, next_enqueue_at: at });
  });

  it("offers every repository of a sponsor within six hours at the production 15-second poll cadence", async () => {
    const store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    const ids = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0"));
    const offered: string[] = [];
    for (let elapsed = 0; elapsed < 6 * 60 * 60_000; elapsed += 15_000) {
      const now = new Date(at.getTime() + elapsed);
      const summary = await sweepReconciliations({
        round: store, now: () => now, listActiveRepositorySponsors: async () => ids.map((id) => ({ repositoryId: id, sponsorId })),
        enqueue: async (id) => { offered.push(id); },
      });
      expect(summary.enqueued).toBeLessThanOrEqual(1);
      if (summary.enqueued === 1) {
        await store.spend(sponsorId, now, 3000);
        await store.spend(sponsorId, now, 3000);
      }
    }
    expect(offered).toEqual(ids);
    expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`).toEqual([{ spent: 200 }]);
  });

  it("restarts the deadline chain after a long outage without emitting a catch-up burst", async () => {
    const store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    const ids = Array.from({ length: 100 }, (_, index) => String(index).padStart(3, "0"));
    const offered: string[] = [];
    const offer = async (id: string) => { offered.push(id); };
    await store.enqueueNext(sponsorId, ids, at, 3000, offer);
    const resumedAt = new Date(at.getTime() + 900_000);
    expect(await store.enqueueNext(sponsorId, ids, resumedAt, 3000, offer)).toBe("001");
    expect(await store.enqueueNext(sponsorId, ids, resumedAt, 3000, offer)).toBeNull();
    expect(await store.enqueueNext(sponsorId, ids, new Date(at.getTime() + 915_000), 3000, offer)).toBeNull();
    expect(await store.enqueueNext(sponsorId, ids, new Date(at.getTime() + 1_110_000), 3000, offer)).toBeNull();
    expect(await store.enqueueNext(sponsorId, ids, new Date(at.getTime() + 1_125_000), 3000, offer)).toBe("002");
    expect(await sql`select next_enqueue_at from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`)
      .toEqual([{ next_enqueue_at: new Date(at.getTime() + 1_332_000) }]);
    expect(offered).toEqual(["000", "001", "002"]);
  });

  it("retries the same durable slot after the production sweep reports an enqueue failure", async () => {
    const store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    const attempted: string[] = [];
    const failures: string[] = [];
    let reject = true;
    const tick = (now: Date) => sweepReconciliations({
      round: store, now: () => now,
      listActiveRepositorySponsors: async () => ["a", "b"].map((id) => ({ repositoryId: id, sponsorId })),
      enqueue: async (id) => { attempted.push(id); if (reject) throw new Error("queue unavailable"); },
      onFailure: (id) => { failures.push(id); },
    });
    expect(await tick(at)).toEqual({ attempted: 1, enqueued: 0, failed: 1 });
    reject = false;
    expect(await tick(new Date(at.getTime() + 15_000))).toEqual({ attempted: 1, enqueued: 1, failed: 0 });
    expect(attempted).toEqual(["a", "a"]);
    expect(failures).toEqual(["a"]);
    expect(await sql`select rotation_cursor from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`)
      .toEqual([{ rotation_cursor: "a" }]);
  });

  it("atomically admits exactly the ceiling under concurrent stores and survives restart", async () => {
    const store = () => new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    const stores = Array.from({ length: 16 }, store);
    const holds = await Promise.all(Array.from({ length: 64 }, (_, index) => stores[index % 16]!.spend(sponsorId, at, 17)));
    expect(holds.filter((hold) => hold === null)).toHaveLength(17);
    expect(holds.filter((hold) => hold?.getTime() === next.getTime())).toHaveLength(47);
    expect(await store().spend(sponsorId, at, 17)).toEqual(next);
    expect(await store().spend(sponsorId, next, 17)).toBeNull();
    expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`).toEqual([{ spent: 1 }]);
  });

  it("paces one repository per slot, resumes on startup, stops when spent, and rotates next window", async () => {
    let store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    const queued: string[] = [];
    const offer = async (id: string) => { queued.push(id); };
    expect(await store.enqueueNext(sponsorId, ["c", "a", "b"], at, 2, offer)).toBe("a");
    store = new PostgresSponsorSweepRoundStore(sql);
    expect(await store.enqueueNext(sponsorId, ["c", "a", "b"], at, 2, offer)).toBeNull();
    await store.spend(sponsorId, at, 2);
    expect(await store.enqueueNext(sponsorId, ["c", "a", "b"], new Date("2030-01-01T02:00:00Z"), 2, offer)).toBe("b");
    await store.spend(sponsorId, at, 2);
    expect(await store.enqueueNext(sponsorId, ["c", "a", "b"], new Date("2030-01-01T04:00:00Z"), 2, offer)).toBeNull();
    expect(await store.enqueueNext(sponsorId, ["c", "a", "b"], next, 2, offer)).toBe("c");
    expect(await store.enqueueNext(sponsorId, ["c", "a", "b"], new Date("2030-01-01T08:00:00Z"), 2, offer)).toBe("a");
    expect(queued).toEqual(["a", "b", "c", "a"]);
  });

  it("does not lose a slot if enqueue fails and handles empty and changing lists", async () => {
    const store = new PostgresSponsorSweepRoundStore(sql);
    const sponsorId = await insertSponsor();
    expect(await store.enqueueNext(sponsorId, [], at, 3000, async () => {})).toBeNull();
    await expect(store.enqueueNext(sponsorId, ["a"], at, 3000, async () => { throw new Error("queue unavailable"); })).rejects.toThrow();
    expect(await store.enqueueNext(sponsorId, ["a"], at, 3000, async () => {})).toBe("a");
    expect(await store.enqueueNext(sponsorId, ["a"], new Date("2030-01-01T05:59:59Z"), 3000, async () => {})).toBeNull();
    expect(await store.enqueueNext(sponsorId, ["b"], next, 3000, async () => {})).toBe("b");
  });

  it("migrates a singleton row at the limit to an empty per-sponsor table whose rows start from zero", async () => {
    const databaseUrl = process.env.OVERFLOW_DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `sweep_round_upgrade_${(externalId += 1)}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.OVERFLOW_DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "067_reconciliation_sweep_round.sql" });
      // The pre-deploy database: the singleton round holds a spent window.
      await upgradeSql`insert into reconciliation_sweep_round (window_start, spent, next_enqueue_at)
        values (${at}, 3000, ${at})`;

      await runMigrations();

      // Nothing is carried: the per-sponsor table starts empty and the old
      // table's row is untouched. Each sponsor's window anchors at its first
      // sweep, so the singleton's spent never becomes any sponsor's debt.
      expect(await upgradeSql`select * from reconciliation_sweep_rounds`).toEqual([]);
      expect(await upgradeSql`select window_start, spent from reconciliation_sweep_round`)
        .toEqual([{ window_start: at, spent: 3000 }]);

      // First touch after deploy: the sponsor's row starts from zero and the
      // first fold's spend admits at once, charging one. The sponsor row and
      // every statement here go through the upgrade pool, never the closed one.
      const githubUserId = 5_000_000 + (externalId += 1);
      const [sponsor] = await upgradeSql<{ id: string }[]>`
        insert into users (github_user_id, github_login)
        values (${githubUserId}, ${`sponsor-${githubUserId}`}) returning id`;
      const store = new PostgresSponsorSweepRoundStore(upgradeSql);
      expect(await store.spend(sponsor.id, next, 3000)).toBeNull();
      const [row] = await upgradeSql<{ window_start: Date; spent: number; next_enqueue_at: Date }[]>`
        select window_start, spent, next_enqueue_at from reconciliation_sweep_rounds where sponsor_id = ${sponsor.id}`;
      expect(row).toEqual({ window_start: next, spent: 1, next_enqueue_at: next });
    } finally {
      await closeSql();
      process.env.OVERFLOW_DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });
});
