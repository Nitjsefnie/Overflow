import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresRepositorySizeStore } from "@/lib/fold/repository-size";
import { PostgresReconciliationJobStore } from "@/lib/fold/reconciliation-job-store";
import { PostgresSweepCatchupStore } from "@/lib/fold/sweep-catchup-store";
import {
  sweepReconciliationCatchups,
  type ReconciliationCatchupDependencies,
} from "@/lib/fold/sweep-catchup";
import {
  RECONCILIATION_EVIDENCE_FORMAT,
  type ReconciliationEvidence,
} from "@/lib/fold/reconciliation-evidence";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
// The threshold parser reads the unprefixed name (repository-size.ts), which is
// what sweepReconciliations feeds it; the tick reads process.env the same way.
const originalThreshold = process.env.RECONCILIATION_DIFF_ONLY_BACKLOG;
const at = new Date("2030-01-01T00:00:00Z");
let externalId = 9_000_000;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "catchup", user: "catchup", password: randomUUID() });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  process.env.RECONCILIATION_DIFF_ONLY_BACKLOG = "10";
  sql = getSql();
  await runMigrations();
});
beforeEach(async () => {
  await sql`delete from repository_reconciliation_jobs`;
  await sql`delete from reconciliation_sweep_catchups`;
  await sql`delete from repository_reconciliation_sizes`;
  await sql`delete from registered_repositories`;
  await sql`delete from users`;
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
  if (originalThreshold === undefined) delete process.env.RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.RECONCILIATION_DIFF_ONLY_BACKLOG = originalThreshold;
});

async function insertSponsor(): Promise<string> {
  const githubUserId = 7_000_000 + (externalId += 1);
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`sponsor-${externalId}`}) returning id`;
  return row.id;
}

async function insertRepository(sponsorId: string, repositoryId?: string): Promise<string> {
  const key = externalId += 1;
  const [row] = await sql<{ id: string }[]>`insert into registered_repositories
    (id, github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${repositoryId ?? randomUUID()}, ${key}, ${`owner/repo-${key}`}, ${sponsorId}, 'PUBLIC', ${key},
      ${sql.json(validDifficultyScheme())}) returning id`;
  return row.id;
}

async function storeSize(repositoryId: string, totalCount: number): Promise<void> {
  await new PostgresRepositorySizeStore(sql).store(repositoryId, totalCount, at);
}

function safeEvidence(overrides?: Partial<ReconciliationEvidence>): ReconciliationEvidence {
  return {
    version: 1, formatVersion: RECONCILIATION_EVIDENCE_FORMAT, checkpoint: at, lastFullPassAt: at,
    omittedOversizedFacts: 0, issues: [], pullRequests: [], ...overrides,
  };
}

type Harness = {
  deps: ReconciliationCatchupDependencies;
  offered: string[];
  evidence: { value: ReconciliationEvidence | null; belowRevision: boolean };
  now: { value: Date };
};

function harness(overrides?: Partial<ReconciliationCatchupDependencies>): Harness {
  const offered: string[] = [];
  const evidence = { value: safeEvidence(), belowRevision: false };
  const now = { value: at };
  const deps: ReconciliationCatchupDependencies = {
    listActiveRepositorySponsors: async () => {
      const rows = await sql<{ id: string; sponsor_id: string }[]>`
        select id::text, sponsor_id::text from registered_repositories where active`;
      return rows.map((row) => ({ repositoryId: row.id, sponsorId: row.sponsor_id }));
    },
    backlog: new PostgresRepositorySizeStore(sql),
    catchups: new PostgresSweepCatchupStore(sql),
    evidence: {
      getReconciliationEvidence: async () => evidence.value,
      hasDerivedRowsBelowFoldRevision: async () => evidence.belowRevision,
    },
    enqueue: async (repositoryId) => { offered.push(repositoryId); },
    now: () => now.value,
    ...overrides,
  };
  return { deps, offered, evidence, now };
}

/** Enqueues the catch-up the way production does: the real job store, on the transaction. */
function productionEnqueue(record: string[]) {
  return async (repositoryId: string, transaction: Parameters<ReconciliationCatchupDependencies["enqueue"]>[1]) => {
    record.push(repositoryId);
    await new PostgresReconciliationJobStore(transaction as unknown as Sql)
      .enqueueReconciliationJob(repositoryId, "SWEEP");
  };
}

describe("reconciliation sweep catch-ups", () => {
  it("creates pending rows the first tick a sponsor is over the threshold and none while under it", async () => {
    const sponsorId = await insertSponsor();
    const small = await insertRepository(sponsorId);
    const large = await insertRepository(sponsorId);
    await storeSize(small, 5);
    await storeSize(large, 5);
    const { deps } = harness();

    await sweepReconciliationCatchups(deps);
    let rows = await sql`select repository_id::text, state from reconciliation_sweep_catchups`;
    expect(rows).toEqual([]);

    await storeSize(large, 20);
    await sweepReconciliationCatchups(deps);
    rows = await sql`select repository_id::text as repository_id, state from reconciliation_sweep_catchups order by repository_id`;
    // Both rows are created and the smallest catch-up is claimed in the same tick.
    expect(rows.map((row) => row.repository_id).sort()).toEqual([small, large].sort());
    expect(rows.filter((row) => row.state === "in_flight").map((row) => row.repository_id)).toEqual([small]);
    expect(rows.filter((row) => row.state === "pending").map((row) => row.repository_id)).toEqual([large]);
  });

  it("runs one sponsor's catch-ups in ascending size order (ties by repository id), one at a time", async () => {
    const sponsorId = await insertSponsor();
    const [smallerTieId, largerTieId] = [randomUUID(), randomUUID()].sort();
    const tieLow = await insertRepository(sponsorId, smallerTieId);
    const tieHigh = await insertRepository(sponsorId, largerTieId);
    const smallest = await insertRepository(sponsorId);
    await storeSize(tieLow, 5);
    await storeSize(tieHigh, 5);
    await storeSize(smallest, 3);
    const h = harness();
    h.deps.enqueue = productionEnqueue(h.offered);

    // The smallest repository is enqueued as a SWEEP job and claimed in flight.
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([smallest]);
    let jobs = await sql`select repository_id::text as repository_id, reason, state from repository_reconciliation_jobs`;
    expect(jobs).toEqual([{ repository_id: smallest, reason: "SWEEP", state: "PENDING" }]);

    // A restart (a new store over the same database) finds the job queued and waits.
    await sweepReconciliationCatchups(harness({ enqueue: productionEnqueue(h.offered) }).deps);
    expect(h.offered).toEqual([smallest]);

    // The fold completed: the worker deleted the job row (no follow-up).
    await sql`delete from repository_reconciliation_jobs`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([smallest, tieLow]);

    await sql`delete from repository_reconciliation_jobs`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([smallest, tieLow, tieHigh]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${tieLow}`)
      .toEqual([{ state: "completed" }]);
  });

  it("never re-enqueues a completed or failed catch-up across a window rollover or a later measurement", async () => {
    const sponsorId = await insertSponsor();
    const done = await insertRepository(sponsorId);
    const failing = await insertRepository(sponsorId);
    await storeSize(done, 3);
    await storeSize(failing, 9);
    const h = harness();

    // The first catch-up completes (the recorder enqueue leaves no job row,
    // which is exactly the fold-completed shape the tracker reads); the tick
    // then claims the second repository.
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([done]);
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([done, failing]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${done}`)
      .toEqual([{ state: "completed" }]);

    // The second catch-up was claimed by that tick; its fold then fails after retries.
    await sql`insert into repository_reconciliation_jobs (repository_id, reason, state)
      values (${failing}, 'SWEEP', 'FAILED')`;
    await sweepReconciliationCatchups(h.deps);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${failing}`)
      .toEqual([{ state: "failed" }]);

    // Rollovers and re-measurements never re-enqueue either terminal state.
    h.now.value = new Date(at.getTime() + 6 * 60 * 60_000 + 1);
    await storeSize(done, 1);
    await storeSize(failing, 1);
    await sweepReconciliationCatchups(h.deps);
    h.now.value = new Date(at.getTime() + 30 * 24 * 60 * 60_000);
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([done, failing]);
  });

  it("re-queues a completed catch-up when the evidence is unsafe, but oversized-fact omissions alone stay completed", async () => {
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await storeSize(repositoryId, 30);
    const h = harness();

    await sweepReconciliationCatchups(h.deps);
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "completed" }]);

    // A later measurement with a format bump: the completed row rejoins the queue.
    h.evidence.value = safeEvidence({ formatVersion: RECONCILIATION_EVIDENCE_FORMAT + 1 });
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId, repositoryId]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "in_flight" }]);

    // Complete again, then null evidence is unsafe the same way.
    h.evidence.value = safeEvidence();
    await sweepReconciliationCatchups(h.deps);
    h.evidence.value = null;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId, repositoryId, repositoryId]);

    // Complete again: omitted oversized facts with a current format stay completed.
    h.evidence.value = safeEvidence();
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered.length).toBe(3);
    h.evidence.value = safeEvidence({ omittedOversizedFacts: 2 });
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered.length).toBe(3);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "completed" }]);
  });

  it("re-queues a completed catch-up when derived rows sit below the fold revision", async () => {
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await storeSize(repositoryId, 30);
    const h = harness();

    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "completed" }]);
    h.evidence.belowRevision = true;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered.length).toBe(2);
  });

  it("a restart over the same database resumes the in-flight repository's own job and enqueues no other first", async () => {
    const sponsorId = await insertSponsor();
    const [smallerTieId, largerTieId] = [randomUUID(), randomUUID()].sort();
    const first = await insertRepository(sponsorId, smallerTieId);
    const second = await insertRepository(sponsorId, largerTieId);
    await storeSize(first, 6);
    await storeSize(second, 6);
    const h = harness();
    h.deps.enqueue = productionEnqueue(h.offered);

    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([first]);
    const [queued] = await sql<{ id: string; state: string; reason: string; created_at: Date }[]>`
      select id::text, state, reason, created_at from repository_reconciliation_jobs
      where repository_id = ${first}`;

    // The restart: fresh store and tick over the same database.
    const restarted = harness();
    restarted.deps.enqueue = productionEnqueue(h.offered);
    await sweepReconciliationCatchups(restarted.deps);
    expect(h.offered).toEqual([first]);
    expect(await sql`select id::text, state, reason, created_at from repository_reconciliation_jobs where repository_id = ${first}`)
      .toEqual([{ id: queued.id, state: "PENDING", reason: "SWEEP", created_at: queued.created_at }]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${first}`)
      .toEqual([{ state: "in_flight" }]);

    // The resumed pass finishes: the job row disappears and only then does the
    // next catch-up of the sponsor start.
    await sql`delete from repository_reconciliation_jobs where repository_id = ${first}`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([first, second]);
  });

  it("re-enqueues the same repository after a claim transaction fails before any job existed", async () => {
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await storeSize(repositoryId, 30);
    let failing = true;
    const h = harness();
    h.deps.enqueue = async (repositoryId) => {
      if (failing) throw new Error("The queue write failed.");
      h.offered.push(repositoryId);
    };

    // The claim and its job insert are one transaction (creation rides in it
    // too), so the failure rolls everything back: no row at all, nothing in
    // flight, no job.
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([]);
    expect(await sql`select 1 from reconciliation_sweep_catchups`).toEqual([]);

    failing = false;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    expect(await sql`select repository_id::text as repository_id, state from reconciliation_sweep_catchups`)
      .toEqual([{ repository_id: repositoryId, state: "in_flight" }]);
  });

  it("re-queues a failed catch-up when the evidence is unsafe, but rollovers alone leave it failed", async () => {
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await storeSize(repositoryId, 30);
    const h = harness();

    // The catch-up is claimed and then its fold fails after retries.
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    await sql`insert into repository_reconciliation_jobs (repository_id, reason, state)
      values (${repositoryId}, 'SWEEP', 'FAILED')`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "failed" }]);

    // A window rollover with safe evidence leaves the failed row alone.
    h.now.value = new Date(at.getTime() + 6 * 60 * 60_000 + 1);
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "failed" }]);

    // An evidence-format bump sends the failed row back into the ordered queue.
    h.evidence.value = safeEvidence({ formatVersion: RECONCILIATION_EVIDENCE_FORMAT + 1 });
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([repositoryId, repositoryId]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
      .toEqual([{ state: "in_flight" }]);
  });

  it("resolves the documented OVERFLOW_-prefixed threshold variable through the production path", async () => {
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await storeSize(repositoryId, 6);
    const originalPrefixed = process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG;
    const originalUnprefixed = process.env.RECONCILIATION_DIFF_ONLY_BACKLOG;
    process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG = "5";
    delete process.env.RECONCILIATION_DIFF_ONLY_BACKLOG;
    try {
      const { deps, offered } = harness();
      await sweepReconciliationCatchups(deps);
      // The prefixed knob is the documented one: a backlog of 6 is over a
      // threshold of 5, so the row is created and the catch-up claimed.
      expect(offered).toEqual([repositoryId]);
      expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${repositoryId}`)
        .toEqual([{ state: "in_flight" }]);
    } finally {
      if (originalPrefixed === undefined) delete process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG = originalPrefixed;
      if (originalUnprefixed === undefined) delete process.env.RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.RECONCILIATION_DIFF_ONLY_BACKLOG = originalUnprefixed;
    }
  });

  it("ends an in-flight catch-up whose job was re-queued as a follow-up, and waits while the job is running or queued", async () => {
    const sponsorId = await insertSponsor();
    const first = await insertRepository(sponsorId);
    const second = await insertRepository(sponsorId);
    await storeSize(first, 3);
    await storeSize(second, 9);
    const h = harness();

    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([first]);

    // The fold is mid-run: a lease holds its job RUNNING, so the tick waits.
    await sql`insert into repository_reconciliation_jobs
      (repository_id, reason, state, lease_token, lease_expires_at)
      values (${first}, 'SWEEP', 'RUNNING', gen_random_uuid(), now() + interval '5 minutes')`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([first]);

    // The fold returned the job to the queue as a SWEEP re-run: still waiting.
    await sql`update repository_reconciliation_jobs
      set state = 'PENDING', lease_token = null, lease_expires_at = null
      where repository_id = ${first}`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([first]);

    // The finished SWEEP fold re-queued the job as a follow-up (WEBHOOK): the
    // catch-up is completed and only then does the sponsor's next one start.
    await sql`update repository_reconciliation_jobs set reason = 'WEBHOOK'
      where repository_id = ${first}`;
    await sweepReconciliationCatchups(h.deps);
    expect(h.offered).toEqual([first, second]);
    expect(await sql`select state from reconciliation_sweep_catchups where repository_id = ${first}`)
      .toEqual([{ state: "completed" }]);
  });

  it("serializes two concurrent advances per sponsor: the second blocks on the sponsor's own row", async () => {
    const sponsorId = await insertSponsor();
    const [lowerId, higherId] = [randomUUID(), randomUUID()].sort();
    const first = await insertRepository(sponsorId, lowerId);
    const second = await insertRepository(sponsorId, higherId);
    await storeSize(first, 6);
    await storeSize(second, 6);
    const store = new PostgresSweepCatchupStore(sql);
    const enqueued: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    // The first advance claims the smallest catch-up; its enqueue inserts the
    // job on the claim's transaction and then parks on the gate, holding the
    // transaction — and every lock it took — open.
    const advanceA = store.advance({
      sponsorId,
      activeRepositoryIds: [first, second],
      requeueRepositoryIds: [],
      now: at,
      enqueue: async (repositoryId, transaction) => {
        enqueued.push(repositoryId);
        await new PostgresReconciliationJobStore(transaction as unknown as Sql)
          .enqueueReconciliationJob(repositoryId, "SWEEP");
        await gate;
      },
    });
    await vi.waitFor(() => expect(enqueued).toEqual([first]));

    // The second advance starts while the first's transaction is open. The
    // sponsor's row is the first thing it locks, so the wait it lands in names
    // the serialization: the sponsor's row itself, not the claimed catch-up's.
    const advanceB = store.advance({
      sponsorId,
      activeRepositoryIds: [first, second],
      requeueRepositoryIds: [],
      now: at,
      enqueue: async (repositoryId) => { enqueued.push(repositoryId); },
    });
    let waitsOnSponsor = false;
    try {
      for (let poll = 0; poll < 600 && !waitsOnSponsor; poll += 1) {
        const rows = await sql<{ query: string }[]>`
          select activity.query as query
          from pg_stat_activity as activity
          join pg_locks as lock on lock.pid = activity.pid and not lock.granted
          where activity.wait_event_type = 'Lock'
            and activity.query like '%select from users where id = %for update%'
            and activity.pid <> pg_backend_pid()`;
        if (rows.length > 0) { waitsOnSponsor = true; break; }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(waitsOnSponsor).toBe(true);
    } finally {
      // The first advance parks on the gate with its transaction open; release
      // it even when the wait observation fails, or teardown hangs on the
      // connection it holds.
      release();
    }
    await advanceA;
    await advanceB;
    // The first catch-up is still in flight with its queued job, and the
    // second advance waited for it instead of claiming the next repository.
    expect(enqueued).toEqual([first]);
    expect(await sql`select repository_id::text as repository_id, state
      from reconciliation_sweep_catchups order by repository_id`).toEqual([
        { repository_id: first, state: "in_flight" },
        { repository_id: second, state: "pending" },
      ]);
  }, 30_000);

  it("pins the catch-up table shape: check constraint, timestamps and repository cascade", async () => {
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);

    await expect(sql`insert into reconciliation_sweep_catchups (repository_id, sponsor_id, state)
      values (${repositoryId}, ${sponsorId}, 'queued')`).rejects.toThrow();

    await sql`insert into reconciliation_sweep_catchups (repository_id, sponsor_id) values (${repositoryId}, ${sponsorId})`;
    const [row] = await sql<{ state: string; created_at: Date; updated_at: Date }[]>`
      select state, created_at, updated_at from reconciliation_sweep_catchups where repository_id = ${repositoryId}`;
    expect(row.state).toBe("pending");
    expect(Number.isFinite(row.created_at.getTime())).toBe(true);
    expect(Number.isFinite(row.updated_at.getTime())).toBe(true);

    await sql`delete from registered_repositories where id = ${repositoryId}`;
    expect(await sql`select 1 from reconciliation_sweep_catchups`).toEqual([]);
  });
});
