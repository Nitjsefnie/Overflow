import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { encryptToken } from "@/lib/security/token-cipher";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const key = Buffer.alloc(32, 31).toString("base64url");

describe("repository publication fencing", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "fencing", user: "fencing", password: "fencing" });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  // Defect: identity UPDATE uses the work pool after its coordination session died.
  it("does not let a reclaimed worker's older identity overwrite the successor", async () => {
    const { repositoryId } = await fixture();
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const olderStore = new PostgresFoldStore(sql, key, coordination);
    const newerStore = new PostgresFoldStore(sql, key);
    const entered = signal();
    const release = signal();
    const olderGithub = gateway(`older/repo-${repositoryId}`);
    const verify = olderGithub.getRepositoryById;
    olderGithub.getRepositoryById = async (id) => {
      entered.resolve();
      await release.promise;
      return verify(id);
    };
    await olderStore.enqueueReconciliationJob(repositoryId, "SWEEP");
    const older = runNextReconciliationJob({
      store: olderStore,
      reconcile: (id, options) => reconcileRepository({ store: olderStore, github: olderGithub }, id, options),
    });
    try {
      await entered.promise;
      await loseSession(repositoryId);
      await coordination`select 1`;
      await sql`update repository_reconciliation_jobs set lease_expires_at = now() - interval '1 second'
        where repository_id = ${repositoryId}`;
      expect(await runNextReconciliationJob({
        store: newerStore,
        reconcile: (id, options) => reconcileRepository({
          store: newerStore, github: gateway(`newer/repo-${repositoryId}`),
        }, id, options),
      })).toBe("RECONCILED");
      expect((await repositoryState(repositoryId)).owner_name).toBe(`newer/repo-${repositoryId}`);
      release.resolve();
      await older;
      expect((await repositoryState(repositoryId)).owner_name).toBe(`newer/repo-${repositoryId}`);
      expect(await sql`select error_message from reconciliation_runs
        where repository_id = ${repositoryId} and status = 'FAILED'`)
        .toEqual([{ error_message: "Reconciliation failed." }]);
    } finally {
      release.resolve();
      await coordination.end({ timeout: 0 });
      await Promise.allSettled([older]);
    }
  });

  // Defect: an obsolete empty snapshot deletes the newer fold's derived facts.
  it("does not let a lost session remove a newer materialization", async () => {
    const { repositoryId, fold } = await fixture();
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const olderStore = new PostgresFoldStore(sql, key, coordination);
    const newerStore = new PostgresFoldStore(sql, key);
    const entered = signal();
    const release = signal();
    const github = gateway(`materialization/repo-${repositoryId}`);
    github.listIssues = async () => { entered.resolve(); await release.promise; return []; };
    const older = reconcileRepository({ store: olderStore, github }, repositoryId);
    const settledOlder = Promise.allSettled([older]);
    try {
      await entered.promise;
      await loseSession(repositoryId);
      await coordination`select 1`;
      await newerStore.withRepositoryReconciliation(repositoryId, async () => {
        const runId = await newerStore.beginRun(repositoryId);
        await newerStore.materialize({ repositoryId, runId, fold: {
          ...fold,
          issues: fold.issues.map((issue) => ({ ...issue, title: "Successor publication" })),
          settlements: fold.settlements.map((settlement) => ({ ...settlement, credits: 7, settledPoints: 7 })),
        } });
      });
      const before = await materializationState(repositoryId);
      expect(before.issues).toHaveLength(3);
      expect(before.settlements).toMatchObject([{ credits: 7 }]);
      release.resolve();
      await settledOlder;
      expect(await materializationState(repositoryId)).toEqual(before);
    } finally {
      release.resolve();
      await coordination.end({ timeout: 0 });
      await settledOlder;
    }
  });

  it.each(["identity", "materialization", "unavailable", "cooldown set", "cooldown clear"] as const)(
    "rejects %s after session loss even without a successor",
    async (publication) => {
      const { repositoryId, fold } = await fixture();
      const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
      const store = new PostgresFoldStore(sql, key, coordination);
      const notBefore = new Date("2030-01-01T00:00:00Z");
      await sql`update registered_repositories set reconciliation_not_before = ${notBefore}
        where id = ${repositoryId}`;
      const before = await repositoryState(repositoryId);
      const materializedBefore = await materializationState(repositoryId);
      try {
        await expect(store.withRepositoryReconciliation(repositoryId, async () => {
          await loseSession(repositoryId);
          // Reopen the same pool slot. A reserved JS handle is not a server-session identity.
          await coordination`select 1`;
          if (publication === "identity") await store.recordVerifiedRepositoryIdentity({
            repositoryId, ownerName: `lost/repo-${repositoryId}`, visibility: "PUBLIC",
          });
          if (publication === "unavailable") await store.markRepositoryUnavailable({
            repositoryId, reason: "NOT_FOUND", at: new Date(),
          });
          if (publication.startsWith("cooldown")) await store.setReconciliationCooldown(
            repositoryId, publication === "cooldown clear" ? null : new Date("2031-01-01T00:00:00Z"),
          );
          if (publication === "materialization") await store.materialize({
            repositoryId, runId: await store.beginRun(repositoryId), fold: {
              ...fold, issues: [], pullRequests: [], settlements: [], selfWorkCalibrations: [], unwritableClosures: [],
            },
          });
        })).rejects.toThrow();
        expect(await repositoryState(repositoryId)).toEqual(before);
        expect(await materializationState(repositoryId)).toEqual(materializedBefore);
      } finally {
        await coordination.end({ timeout: 0 });
      }
    },
  );

  it("refuses missing, different-repository, and detached expired authority", async () => {
    const { repositoryId } = await fixture();
    const other = await fixture();
    const store = new PostgresFoldStore(sql, key);
    const before = await repositoryState(repositoryId);
    const publish = () => store.recordVerifiedRepositoryIdentity({
      repositoryId, ownerName: `detached/repo-${repositoryId}`, visibility: "PUBLIC",
    });
    await expect(publish()).rejects.toThrow();
    await store.withRepositoryReconciliation(other.repositoryId, async () => {
      await expect(publish()).rejects.toThrow();
    });
    const release = signal();
    let detached!: Promise<unknown>;
    await store.withRepositoryReconciliation(repositoryId, async () => {
      detached = release.promise.then(publish);
    });
    const refusal = expect(detached).rejects.toThrow();
    release.resolve();
    await refusal;
    expect(await repositoryState(repositoryId)).toEqual(before);
  });

  it("keeps concurrent repository scopes independent on one store", async () => {
    const first = await fixture();
    const second = await fixture();
    const store = new PostgresFoldStore(sql, key);
    const firstEntered = signal();
    const releaseFirst = signal();
    const firstRun = store.withRepositoryReconciliation(first.repositoryId, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
      await store.recordVerifiedRepositoryIdentity({
        repositoryId: first.repositoryId, ownerName: `first/${first.repositoryId}`, visibility: "PUBLIC",
      });
    });
    try {
      await firstEntered.promise;
      await store.withRepositoryReconciliation(second.repositoryId, async () => {
        await store.recordVerifiedRepositoryIdentity({
          repositoryId: second.repositoryId, ownerName: `second/${second.repositoryId}`, visibility: "PUBLIC",
        });
      });
      releaseFirst.resolve();
      await firstRun;
      expect((await repositoryState(first.repositoryId)).owner_name).toBe(`first/${first.repositoryId}`);
      expect((await repositoryState(second.repositoryId)).owner_name).toBe(`second/${second.repositoryId}`);
    } finally {
      releaseFirst.resolve();
      await firstRun;
    }
  });

  it.each([false, true])("retains coordination through detached COMMIT when callback failure is %s", async (failCallback) => {
    const { repositoryId } = await fixture();
    const before = await repositoryState(repositoryId);
    const work = postgres(process.env.DATABASE_URL!, { connection: { application_name: "fence-detached-commit" } });
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const reserve = coordination.reserve.bind(coordination);
    let connection!: Awaited<ReturnType<Sql["reserve"]>>;
    coordination.reserve = async () => { connection = await reserve(); return connection; };
    const store = new PostgresFoldStore(work, key, coordination);
    await sql.unsafe(`create function fence_scope_exit_probe() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(210321984); return new; end $$`);
    await sql.unsafe(`create constraint trigger fence_scope_exit_probe
      after update on registered_repositories deferrable initially deferred
      for each row execute function fence_scope_exit_probe()`);
    const locked = signal();
    const release = signal();
    const callbackReturning = signal();
    let blockerPid!: number;
    const blocker = sql.begin(async (transaction) => {
      const [backend] = await transaction`select pg_backend_pid() as pid`;
      blockerPid = backend.pid;
      await transaction`select pg_advisory_xact_lock(210321984)`;
      locked.resolve();
      await release.promise;
    });
    let publication: Promise<unknown> | undefined;
    let scope: Promise<unknown> | undefined;
    let scopeSettled = false;
    try {
      await locked.promise;
      scope = store.withRepositoryReconciliation(repositoryId, async () => {
        publication = store.recordVerifiedRepositoryIdentity({
          repositoryId, ownerName: `after-scope/${repositoryId}`, visibility: "PUBLIC",
        });
        void publication.catch(() => undefined);
        await expect.poll(() => blockingPids("fence-detached-commit")).toContain(blockerPid);
        expect(await sql`select query from pg_stat_activity
          where application_name = 'fence-detached-commit' and wait_event_type = 'Lock'`)
          .toEqual([{ query: "commit" }]);
        callbackReturning.resolve();
        if (failCallback) throw new Error("Callback failed while publication commits.");
      });
      const outcome = scope.then(
        () => { scopeSettled = true; return "fulfilled"; },
        () => { scopeSettled = true; return "rejected"; },
      );
      await Promise.race([callbackReturning.promise, scope]);
      // Let callback-return microtasks run, then queue a real statement on the
      // same session. Any premature unlock must complete before this barrier.
      await nextTurn();
      await connection`select 1`;
      expect(await repositoryState(repositoryId)).toEqual(before);
      expect(await sql`select pid from pg_locks where locktype = 'advisory' and granted
        and database = (select oid from pg_database where datname = current_database())
        and classid = ((hashtextextended(${repositoryId}, 684029183) >> 32) & 4294967295)::oid
        and objid = (hashtextextended(${repositoryId}, 684029183) & 4294967295)::oid
        and objsubid = 1 and mode = 'ExclusiveLock'`).toHaveLength(1);
      expect(scopeSettled).toBe(false);
      release.resolve();
      await blocker;
      expect(await outcome).toBe(failCallback ? "rejected" : "fulfilled");
      expect((await repositoryState(repositoryId)).owner_name).toBe(`after-scope/${repositoryId}`);
      await publication;
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, publication, scope]);
      await sql.unsafe("drop trigger fence_scope_exit_probe on registered_repositories");
      await sql.unsafe("drop function fence_scope_exit_probe()");
      await Promise.all([work.end(), coordination.end()]);
    }
  });

  // Blocking the first snapshot read must also block a successor's identity
  // UPDATE. Checking ownership before acquiring the repository row fails here.
  it("holds the repository row before snapshot reads and orders an admitted fold before its successor", async () => {
    const { repositoryId, fold } = await fixture();
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const oldSql = postgres(process.env.DATABASE_URL!, { connection: { application_name: "fence-admitted" } });
    const newSql = postgres(process.env.DATABASE_URL!, { connection: { application_name: "fence-successor" } });
    const oldStore = new PostgresFoldStore(oldSql, key, coordination);
    const newStore = new PostgresFoldStore(newSql, key);
    const locked = signal();
    const release = signal();
    const blocker = sql.begin(async (transaction) => {
      await transaction`lock table settlements in access exclusive mode`;
      locked.resolve();
      await release.promise;
    });
    let older: Promise<unknown> | undefined;
    let newer: Promise<unknown> | undefined;
    try {
      await locked.promise;
      older = oldStore.withRepositoryReconciliation(repositoryId, async () => {
        await oldStore.materialize({ repositoryId, runId: await oldStore.beginRun(repositoryId), fold: {
          ...fold, issues: [], pullRequests: [], settlements: [], selfWorkCalibrations: [], unwritableClosures: [],
        } });
      });
      const oldOutcome = Promise.allSettled([older]);
      await expect.poll(() => blockingPids("fence-admitted")).toSatisfy((pids: number[]) => pids.length > 0);
      const [{ pid: oldPid }] = await sql`select pid from pg_stat_activity
        where application_name = 'fence-admitted' and wait_event_type = 'Lock'`;
      await loseSession(repositoryId);
      await coordination`select 1`;
      newer = newStore.withRepositoryReconciliation(repositoryId, async () => {
        await newStore.recordVerifiedRepositoryIdentity({
          repositoryId, ownerName: `ordered/${repositoryId}`, visibility: "PUBLIC",
        });
        await newStore.materialize({ repositoryId, runId: await newStore.beginRun(repositoryId), fold });
      });
      await expect.poll(() => blockingPids("fence-successor")).toContain(oldPid);
      release.resolve();
      await blocker;
      await oldOutcome;
      await newer;
      expect((await repositoryState(repositoryId)).owner_name).toBe(`ordered/${repositoryId}`);
      expect((await materializationState(repositoryId)).issues).toHaveLength(3);
      expect((await materializationState(repositoryId)).settlements).toMatchObject([{ credits: 6 }]);
      expect(await sql`select status from reconciliation_runs where repository_id = ${repositoryId}`)
        .toEqual([{ status: "COMPLETED" }, { status: "COMPLETED" }, { status: "COMPLETED" }]);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, older, newer]);
      await Promise.all([coordination.end({ timeout: 0 }), oldSql.end(), newSql.end()]);
    }
  });

  it("readmits the unique-name fallback after rollback and refuses it if the session was lost", async () => {
    const { repositoryId } = await fixture();
    const holder = await fixture();
    const target = `collision/${repositoryId}`;
    await sql`update registered_repositories set visibility = 'PRIVATE', unavailable_reason = 'NOT_FOUND',
      unavailable_since = now() where id = ${repositoryId}`;
    const before = await repositoryState(repositoryId);
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const work = postgres(process.env.DATABASE_URL!, { connection: { application_name: "fence-collision" } });
    const store = new PostgresFoldStore(work, key, coordination);
    const locked = signal();
    const release = signal();
    const blocker = sql.begin(async (transaction) => {
      await transaction`update registered_repositories set owner_name = ${target} where id = ${holder.repositoryId}`;
      locked.resolve();
      await release.promise;
    });
    let publication: Promise<unknown> | undefined;
    try {
      await locked.promise;
      publication = store.withRepositoryReconciliation(repositoryId, () => store.recordVerifiedRepositoryIdentity({
        repositoryId, ownerName: target, visibility: "PUBLIC",
      }));
      const refusal = expect(publication).rejects.toThrow();
      await expect.poll(() => blockingPids("fence-collision")).toSatisfy((pids: number[]) => pids.length > 0);
      await loseSession(repositoryId);
      await coordination`select 1`;
      release.resolve();
      await blocker;
      await refusal;
      expect(await repositoryState(repositoryId)).toEqual(before);
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, publication]);
      await Promise.all([coordination.end({ timeout: 0 }), work.end()]);
    }
  });

  it("proves ownership with a non-superuser application role on both pools", async () => {
    const { repositoryId } = await fixture();
    await sql`create role fencing_app login password 'fencing-app'`;
    await sql`grant usage on schema public to fencing_app`;
    await sql`grant select, insert, update, delete on all tables in schema public to fencing_app`;
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "fencing_app";
    url.password = "fencing-app";
    const work = postgres(url.toString());
    const coordination = postgres(url.toString(), { connection: { TimeZone: "Pacific/Chatham" } });
    const store = new PostgresFoldStore(work, key, coordination);
    try {
      await store.withRepositoryReconciliation(repositoryId, () => store.recordVerifiedRepositoryIdentity({
        repositoryId, ownerName: `application/${repositoryId}`, visibility: "PUBLIC",
      }));
      expect((await repositoryState(repositoryId)).owner_name).toBe(`application/${repositoryId}`);
    } finally {
      await Promise.all([work.end(), coordination.end()]);
    }
  });

  it.each(["different key", "shared mode"])("refuses a live backend holding only a lock with %s", async (replacement) => {
    const { repositoryId } = await fixture();
    const before = await repositoryState(repositoryId);
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const reserve = coordination.reserve.bind(coordination);
    let connection!: Awaited<ReturnType<Sql["reserve"]>>;
    coordination.reserve = async () => { connection = await reserve(); return connection; };
    const store = new PostgresFoldStore(sql, key, coordination);
    try {
      await expect(store.withRepositoryReconciliation(repositoryId, async () => {
        await connection`select pg_advisory_unlock(hashtextextended(${repositoryId}, 684029183))`;
        if (replacement === "shared mode") {
          await connection`select pg_advisory_lock_shared(hashtextextended(${repositoryId}, 684029183))`;
        } else {
          await connection`select pg_advisory_lock(hashtextextended('another-repository', 684029183))`;
        }
        await store.recordVerifiedRepositoryIdentity({
          repositoryId, ownerName: `wrong-lock/${repositoryId}`, visibility: "PUBLIC",
        });
      })).rejects.toThrow();
      expect(await repositoryState(repositoryId)).toEqual(before);
    } finally {
      await coordination.end();
    }
  });

  // A coordination session that died mid-hold leaves its connection to the pool, and the pool
  // hands that connection to the next reservation. The dead coordinator's reclaim must then run
  // on nothing at all: its lock died with its session, and `pg_advisory_unlock_all()` on the
  // surviving session would release whatever that session now holds for somebody else.
  it("does not let a dead coordination session's reclaim release a successor's lock", async () => {
    const { repositoryId } = await fixture();
    const { repositoryId: successorId } = await fixture();
    const coordination = postgres(process.env.DATABASE_URL!, { max: 1 });
    const store = new PostgresFoldStore(sql, key, coordination);
    const olderEntered = signal();
    const olderRelease = signal();
    const successorEntered = signal();
    const successorRelease = signal();
    let older: Promise<unknown> | undefined;
    let newer: Promise<unknown> | undefined;
    try {
      older = store.withRepositoryReconciliation(repositoryId, async () => {
        olderEntered.resolve();
        await olderRelease.promise;
      });
      await olderEntered.promise;
      await loseSession(repositoryId);
      newer = store.withRepositoryReconciliation(successorId, async () => {
        successorEntered.resolve();
        await successorRelease.promise;
        await store.recordVerifiedRepositoryIdentity({
          repositoryId: successorId, ownerName: `successor ${successorId}`, visibility: "PUBLIC",
        });
      });
      await successorEntered.promise;
      olderRelease.resolve();
      // The dead coordinator's scope exits here, while the successor holds its own repository's
      // lock on the very session the pool re-handed out. Its unlock must recognise the session
      // change and leave the successor's lock alone.
      await expect(older).rejects.toThrow();
      successorRelease.resolve();
      await newer;
      expect((await repositoryState(successorId)).owner_name).toBe(`successor ${successorId}`);
    } finally {
      olderRelease.resolve();
      successorRelease.resolve();
      await Promise.allSettled([older, newer]);
      await coordination.end({ timeout: 0 });
    }
  });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function gateway(ownerName: string): ReconciliationGateway {
  return {
    getRepositoryById: verifiedRepositoryAt(ownerName),
    getIssue: async () => null,
    getPullRequestClosingIssues: async () => [],
    listIssues: async () => [],
    getPullRequestReviews: async () => [],
    getPullRequestDiff: async () => "",
  };
}

async function fixture() {
  const result = await materializeRepositoryFixture(sql);
  await sql`update users set encrypted_oauth_token = ${Buffer.from(encryptToken("fencing-token", key))}
    where id = (select sponsor_id from registered_repositories where id = ${result.repositoryId})`;
  return result;
}

async function loseSession(repositoryId: string) {
  const locks = await sql<{ pid: number }[]>`
    select pid from pg_locks where locktype = 'advisory' and granted
      and database = (select oid from pg_database where datname = current_database())
      and classid = ((hashtextextended(${repositoryId}, 684029183) >> 32) & 4294967295)::oid
      and objid = (hashtextextended(${repositoryId}, 684029183) & 4294967295)::oid
      and objsubid = 1 and mode = 'ExclusiveLock'
  `;
  expect(locks).toHaveLength(1);
  const [{ terminated }] = await sql`select pg_terminate_backend(${locks[0].pid}, 5000) as terminated`;
  expect(terminated).toBe(true);
  expect(await sql`select pid from pg_locks where pid = ${locks[0].pid}`).toEqual([]);
}

async function repositoryState(repositoryId: string) {
  const [row] = await sql`select owner_name, visibility, unavailable_reason, reconciliation_not_before
    from registered_repositories where id = ${repositoryId}`;
  return row;
}

async function blockingPids(applicationName: string): Promise<number[]> {
  const rows = await sql<{ blockers: number[] }[]>`select pg_blocking_pids(pid) as blockers from pg_stat_activity
    where application_name = ${applicationName}`;
  return rows.flatMap((row) => row.blockers);
}

async function materializationState(repositoryId: string) {
  const issues = await sql`select * from issues where repository_id = ${repositoryId} order by id`;
  const settlements = await sql`select * from settlements where issue_id in
    (select id from issues where repository_id = ${repositoryId}) order by id`;
  const changes = await sql`select * from reconciliation_changes where reconciliation_run_id in
    (select id from reconciliation_runs where repository_id = ${repositoryId}) order by id`;
  return { issues, settlements, changes };
}
