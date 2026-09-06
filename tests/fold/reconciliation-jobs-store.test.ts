import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";
import { RECONCILIATION_LEASE_MS } from "@/lib/fold/reconciliation-worker";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresFoldStore;
let externalId = 70_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

type JobSnapshot = {
  id: string;
  repository_id: string;
  reason: string;
  state: string;
  attempt_count: number;
  run_after: Date;
  lease_token: string | null;
  lease_expires_at: Date | null;
  lease_duration_ms: number | null;
  last_failure_at: Date | null;
  follow_up_requested: boolean;
  /** Computed in the database so the assertion never compares two machines' clocks. */
  due_now: boolean;
};

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

async function insertRepository(): Promise<string> {
  const githubUserId = nextExternalId();
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`member-${githubUserId}`})
    returning id
  `;
  const githubRepositoryId = nextExternalId();
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${githubRepositoryId}, ${`example/repository-${githubRepositoryId}`}, ${sponsor.id}, ${"PUBLIC"},
      ${nextExternalId()}, ${sql.json(validDifficultyScheme())}
    )
    returning id
  `;
  return repository.id;
}

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/**
 * Waits until some transaction is queued behind a row lock in this database.
 *
 * Bound to a lock the database reports rather than to a stretch of clock, and it
 * throws rather than spinning forever: a completion that never reaches the row
 * is a defect this case has to name, not a wait to sit through.
 */
async function waitUntilBlockedOnJobRow(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [waiter] = await sql<{ waiting: boolean }[]>`
      select exists (
        select 1 from pg_stat_activity
        where datname = current_database()
          and pid <> pg_backend_pid()
          and wait_event_type = 'Lock'
      ) as waiting
    `;
    if (waiter.waiting) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No transaction ever queued behind the reconciliation job row lock.");
}

async function jobsFor(repositoryId: string): Promise<JobSnapshot[]> {
  return sql<JobSnapshot[]>`
    select id, repository_id, reason, state::text as state, attempt_count, run_after,
           lease_token::text as lease_token, lease_expires_at, lease_duration_ms, last_failure_at,
           follow_up_requested, run_after <= now() as due_now
    from repository_reconciliation_jobs
    where repository_id = ${repositoryId}
    order by created_at
  `;
}

async function onlyJobFor(repositoryId: string): Promise<JobSnapshot> {
  const rows = await jobsFor(repositoryId);
  expect(rows).toHaveLength(1);
  return rows[0];
}

async function jobById(jobId: string): Promise<JobSnapshot | undefined> {
  const [row] = await sql<JobSnapshot[]>`
    select id, repository_id, reason, state::text as state, attempt_count, run_after,
           lease_token::text as lease_token, lease_expires_at, lease_duration_ms, last_failure_at,
           follow_up_requested, run_after <= now() as due_now
    from repository_reconciliation_jobs
    where id = ${jobId}
  `;
  return row;
}

async function claimOrFail(): Promise<ClaimedReconciliationJob> {
  const claimed = await store.claimNextReconciliationJob();
  if (claimed === null) {
    throw new Error("Expected a reconciliation job to be claimable.");
  }
  return claimed;
}

async function expireLease(jobId: string): Promise<void> {
  await sql`
    update repository_reconciliation_jobs
    set lease_expires_at = now() - interval '1 minute'
    where id = ${jobId}
  `;
}

describe("PostgreSQL reconciliation job queue", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_reconciliation_jobs_test",
      user: "overflow_reconciliation_jobs_test",
      password: "overflow_reconciliation_jobs_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    store = new PostgresFoldStore(sql);
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  beforeEach(async () => {
    // Claims read the whole queue, so a job left behind by an earlier case would
    // be picked up by a later one and decide its verdict.
    await sql`delete from repository_reconciliation_jobs`;
  });

  it("collapses a burst of enqueues for one repository onto a single job", async () => {
    const repositoryId = await insertRepository();

    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("PENDING");
    expect(job.attempt_count).toBe(0);

    expect(await claimOrFail()).toMatchObject({ repositoryId });
    expect(await store.claimNextReconciliationJob()).toBeNull();
  });

  it("leaves a backing-off job's run_after where the retry put it", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    const backoffUntil = new Date(Date.now() + 3_600_000);
    expect(await store.retryReconciliationJob(claimed.id, claimed.leaseToken, backoffUntil)).toBe(true);

    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("PENDING");
    expect(job.run_after.toISOString()).toBe(backoffUntil.toISOString());
    expect(job.due_now).toBe(false);
    expect(job.attempt_count).toBe(1);
    expect(await store.claimNextReconciliationJob()).toBeNull();
  });

  it("revives a FAILED job as a due PENDING job with attempts reset, keeping the failure evidence", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    expect(await store.failReconciliationJob(claimed.id, claimed.leaseToken)).toBe(true);
    // A job that backed off before its last attempt keeps that future run_after
    // through the failure, so a revive that does not reset it leaves the sweep's
    // repair waiting an hour. Without this the row is already due and the reset
    // is indistinguishable from its absence.
    await sql`
      update repository_reconciliation_jobs
      set run_after = now() + interval '1 hour'
      where repository_id = ${repositoryId}
    `;
    const failed = await onlyJobFor(repositoryId);
    expect(failed.state).toBe("FAILED");
    expect(failed.last_failure_at).not.toBeNull();
    expect(failed.due_now).toBe(false);

    await store.enqueueReconciliationJob(repositoryId, "SWEEP");

    const revived = await onlyJobFor(repositoryId);
    expect(revived.id).toBe(failed.id);
    expect(revived.state).toBe("PENDING");
    expect(revived.attempt_count).toBe(0);
    expect(revived.due_now).toBe(true);
    expect(revived.run_after.toISOString()).not.toBe(failed.run_after.toISOString());
    expect(revived.last_failure_at?.toISOString()).toBe(failed.last_failure_at?.toISOString());
  });

  it("records an enqueue that arrives mid-fold on the running job, lease intact", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    const running = await onlyJobFor(repositoryId);

    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("RUNNING");
    expect(job.follow_up_requested).toBe(true);
    expect(job.lease_token).toBe(claimed.leaseToken);
    expect(job.lease_expires_at?.toISOString()).toBe(running.lease_expires_at?.toISOString());
    expect(job.attempt_count).toBe(running.attempt_count);
  });

  it("keeps the reason the repository first entered the queue with", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "REGISTRATION");

    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    expect((await onlyJobFor(repositoryId)).reason).toBe("REGISTRATION");
  });

  it("returns null when the queue is empty", async () => {
    expect(await store.claimNextReconciliationJob()).toBeNull();
  });

  it("returns null when the only job is not due yet", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    await store.deferReconciliationJob(claimed.id, claimed.leaseToken, new Date(Date.now() + 3_600_000));

    expect(await store.claimNextReconciliationJob()).toBeNull();
  });

  it("leases the oldest due job, counting the attempt it starts", async () => {
    const olderRepositoryId = await insertRepository();
    const newerRepositoryId = await insertRepository();
    await store.enqueueReconciliationJob(olderRepositoryId, "REGISTRATION");
    await sql`
      update repository_reconciliation_jobs
      set run_after = now() - interval '1 hour'
      where repository_id = ${olderRepositoryId}
    `;
    await store.enqueueReconciliationJob(newerRepositoryId, "WEBHOOK");

    const claimed = await claimOrFail();

    expect(claimed.repositoryId).toBe(olderRepositoryId);
    expect(claimed.reason).toBe("REGISTRATION");
    expect(claimed.attemptCount).toBe(1);
    const job = await onlyJobFor(olderRepositoryId);
    expect(job.state).toBe("RUNNING");
    expect(job.lease_token).toBe(claimed.leaseToken);
    expect(job.lease_expires_at).not.toBeNull();
    expect(job.attempt_count).toBe(1);
    expect((await claimOrFail()).repositoryId).toBe(newerRepositoryId);
  });

  it("leases a claimed job for the window the worker documents", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    // now() is fixed throughout this transaction: assert the written window,
    // without a wall-clock margin between the claim and the read.
    await sql.begin(async (transaction) => {
      await new PostgresFoldStore(transaction as unknown as Sql).claimNextReconciliationJob();
      const [row] = await transaction<{ milliseconds: number }[]>`
        select (extract(epoch from (lease_expires_at - now())) * 1000)::float8 as milliseconds
        from repository_reconciliation_jobs
        where repository_id = ${repositoryId}
      `;
      expect(row.milliseconds).toBe(20_000);
      expect(row.milliseconds).toBe(RECONCILIATION_LEASE_MS);
    });
  });

  it.each(["fresh", "renewed"])("preserves a current %s lease", async (kind) => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    if (kind === "renewed") {
      expect(await store.renewReconciliationJobLease(claimed.id, claimed.leaseToken, new Date("2100-01-01"))).toBe(true);
    }
    const before = await onlyJobFor(repositoryId);
    expect(await store.claimNextReconciliationJob()).toBeNull();
    expect(await onlyJobFor(repositoryId)).toEqual(before);
    const [row] = await sql<{ lease_duration_ms: number }[]>`
      select lease_duration_ms from repository_reconciliation_jobs where id = ${claimed.id}
    `;
    expect(row.lease_duration_ms).toBe(20_000);
  });

  it("refuses a renewal queued before its deadline but executed after it", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    await expireLease(claimed.id);
    const before = await onlyJobFor(repositoryId);
    const pool = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    const held = await pool.reserve();
    let released = false;
    const release = () => {
      if (!released) { released = true; held.release(); }
    };
    let renewal: Promise<boolean> | undefined;
    try {
      const [clock] = await held<{ deadline: Date }[]>`
        select clock_timestamp() + interval '1 second' as deadline
      `;
      const queue = new PostgresFoldStore(pool);
      renewal = queue.renewReconciliationJobLease(claimed.id, claimed.leaseToken, clock.deadline);
      // Observe the database crossing the deadline while the sole pool connection
      // is reserved. No sleep or elapsed-duration assertion determines completion.
      let crossed = false;
      while (!crossed) {
        const [observed] = await held<{ crossed: boolean }[]>`
          select clock_timestamp() >= ${clock.deadline} as crossed
        `;
        crossed = observed.crossed;
      }
      release();
      const renewed = await renewal;
      expect(await onlyJobFor(repositoryId)).toEqual(before);
      expect(renewed).toBe(false);
      const reclaimed = await store.claimNextReconciliationJob();
      expect(reclaimed?.id).toBe(claimed.id);
      expect(reclaimed?.leaseToken).not.toBe(claimed.leaseToken);
    } finally {
      release();
      await renewal;
      await pool.end();
    }
  });

  it("renews the matching running lease for the documented window", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    // A different claiming build's recorded window must survive renewal.
    await sql`update repository_reconciliation_jobs set lease_duration_ms = 30000 where id = ${claimed.id}`;
    await expireLease(claimed.id);
    const before = await onlyJobFor(repositoryId);

    await sql.begin(async (transaction) => {
      const renewingStore = new PostgresFoldStore(transaction as unknown as Sql);
      expect(await renewingStore.renewReconciliationJobLease(claimed.id, claimed.leaseToken, new Date("2100-01-01"))).toBe(true);
      const [row] = await transaction<{ milliseconds: number }[]>`
        select (extract(epoch from (lease_expires_at - now())) * 1000)::float8 as milliseconds
        from repository_reconciliation_jobs where id = ${claimed.id}
      `;
      expect(row.milliseconds).toBe(20_000);
      expect(row.milliseconds).toBe(RECONCILIATION_LEASE_MS);
      expect(await renewingStore.claimNextReconciliationJob()).toBeNull();
    });
    const after = await onlyJobFor(repositoryId);
    expect(after.lease_expires_at!.getTime()).toBeGreaterThan(before.lease_expires_at!.getTime());
    expect(after).toEqual({ ...before, lease_expires_at: after.lease_expires_at });
  });

  it("does not renew a different job or a stale lease token", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    const before = await jobById(claimed.id);

    expect(await store.renewReconciliationJobLease(randomUUID(), claimed.leaseToken, new Date("2100-01-01"))).toBe(false);
    expect(await store.renewReconciliationJobLease(claimed.id, randomUUID(), new Date("2100-01-01"))).toBe(false);
    expect(await jobById(claimed.id)).toEqual(before);
  });

  it.each(["PENDING", "FAILED"])("does not renew a %s job", async (state) => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    if (state === "FAILED") {
      await store.failReconciliationJob(claimed.id, claimed.leaseToken);
    } else {
      await store.deferReconciliationJob(claimed.id, claimed.leaseToken, new Date());
    }
    const before = await jobById(claimed.id);

    expect(await store.renewReconciliationJobLease(claimed.id, claimed.leaseToken, new Date("2100-01-01"))).toBe(false);
    expect(await jobById(claimed.id)).toEqual(before);
  });

  it("keeps a mid-fold event whose enqueue is still uncommitted when the fold completes", async () => {
    // The interleaving this queue exists to survive: a delivery arrives while the
    // fold is running and its enqueue has not committed yet when the worker asks
    // whether a follow-up is needed. Reading the row without locking it answers
    // from before the enqueue, and the delete that follows then drops the event.
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();

    // A second connection, so the enqueue is genuinely concurrent rather than
    // nested inside the completion's own transaction.
    const other = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    const enqueued = signal();
    const release = signal();
    const enqueueing = other.begin(async (transaction) => {
      await new PostgresFoldStore(transaction as unknown as Sql).enqueueReconciliationJob(repositoryId, "WEBHOOK");
      enqueued.resolve();
      await release.promise;
    });

    try {
      await enqueued.promise;
      const completing = store.completeReconciliationJob(claimed.id, claimed.leaseToken);
      // The completion must reach the row and wait there rather than decide from
      // a snapshot taken before the enqueue. Waited on as a lock the database
      // reports, not as an interval.
      await waitUntilBlockedOnJobRow();
      release.resolve();
      await enqueueing;

      await expect(completing).resolves.toBe(true);
      const job = await onlyJobFor(repositoryId);
      expect(job.state).toBe("PENDING");
      expect(job.follow_up_requested).toBe(false);
      expect(job.attempt_count).toBe(0);
      expect(job.due_now).toBe(true);
    } finally {
      release.resolve();
      await enqueueing.catch(() => undefined);
      await other.end();
    }
  });

  it("claims a job whose row another transaction holds by skipping over it", async () => {
    // Two workers poll the same queue. The claim skips a row somebody else has
    // locked instead of queueing behind it, so one slow claim cannot stall every
    // other repository's fold.
    const lockedRepositoryId = await insertRepository();
    const freeRepositoryId = await insertRepository();
    await store.enqueueReconciliationJob(lockedRepositoryId, "WEBHOOK");
    // Older, so an unskipped claim would take this row first and wait on it.
    await sql`
      update repository_reconciliation_jobs
      set run_after = now() - interval '1 hour'
      where repository_id = ${lockedRepositoryId}
    `;
    await store.enqueueReconciliationJob(freeRepositoryId, "WEBHOOK");

    const other = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    const locked = signal();
    const release = signal();
    const holding = other.begin(async (transaction) => {
      await transaction`
        select id from repository_reconciliation_jobs
        where repository_id = ${lockedRepositoryId}
        for update
      `;
      locked.resolve();
      await release.promise;
    });

    try {
      await locked.promise;
      const claimed = await claimOrFail();
      expect(claimed.repositoryId).toBe(freeRepositoryId);
    } finally {
      release.resolve();
      await holding.catch(() => undefined);
      await other.end();
    }
  });

  it("breaks a run_after tie on the job that entered the queue first", async () => {
    const firstInsertedId = await insertRepository();
    const secondInsertedId = await insertRepository();
    await store.enqueueReconciliationJob(firstInsertedId, "WEBHOOK");
    await store.enqueueReconciliationJob(secondInsertedId, "SWEEP");
    // One statement, so both rows land on the same run_after and only the
    // tiebreak can order them.
    await sql`
      update repository_reconciliation_jobs
      set run_after = now() - interval '5 minutes'
      where repository_id in (${firstInsertedId}, ${secondInsertedId})
    `;
    // The row enqueued second is made the older one, so insertion order alone
    // cannot produce the expected answer.
    await sql`
      update repository_reconciliation_jobs
      set created_at = now() - interval '1 hour'
      where repository_id = ${secondInsertedId}
    `;

    expect((await claimOrFail()).repositoryId).toBe(secondInsertedId);
    expect((await claimOrFail()).repositoryId).toBe(firstInsertedId);
  });

  it("reclaims a RUNNING job whose lease has expired", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const first = await claimOrFail();
    expect(await store.claimNextReconciliationJob()).toBeNull();

    await expireLease(first.id);
    const second = await claimOrFail();

    expect(second.id).toBe(first.id);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(second.attemptCount).toBe(2);
    expect(await store.completeReconciliationJob(first.id, first.leaseToken)).toBe(false);
  });

  it("keeps a mid-fold enqueue's follow-up across a reclaimed lease", async () => {
    // The event arrived while the first worker held the job and that worker then
    // died. Clearing the flag on the reclaim would lose the event outright: the
    // fold it belongs to never finished, and the reclaimed attempt is the run
    // that has to answer for it.
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const first = await claimOrFail();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    await expireLease(first.id);
    const second = await claimOrFail();

    expect(second.id).toBe(first.id);
    expect((await onlyJobFor(repositoryId)).follow_up_requested).toBe(true);

    expect(await store.completeReconciliationJob(second.id, second.leaseToken)).toBe(true);

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("PENDING");
    expect(job.follow_up_requested).toBe(false);
    expect(job.due_now).toBe(true);
    expect((await claimOrFail()).id).toBe(job.id);
  });

  it("deletes the row a completed job leaves behind", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();

    expect(await store.completeReconciliationJob(claimed.id, claimed.leaseToken)).toBe(true);

    expect(await jobsFor(repositoryId)).toHaveLength(0);
  });

  it("leaves a fresh PENDING job behind when the completed fold took a follow-up", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    await store.retryReconciliationJob(claimed.id, claimed.leaseToken, new Date(Date.now() - 1_000));
    const reclaimed = await claimOrFail();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

    expect(await store.completeReconciliationJob(reclaimed.id, reclaimed.leaseToken)).toBe(true);

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("PENDING");
    expect(job.attempt_count).toBe(0);
    expect(job.due_now).toBe(true);
    expect(job.last_failure_at).toBeNull();
    expect(job.follow_up_requested).toBe(false);
    expect(job.lease_token).toBeNull();
    expect(job.lease_expires_at).toBeNull();
    expect((await claimOrFail()).id).toBe(job.id);
  });

  it("returns a deferred job to PENDING at the given time and gives back the claim's attempt", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    const runAfter = new Date(Date.now() + 600_000);

    expect(await store.deferReconciliationJob(claimed.id, claimed.leaseToken, runAfter)).toBe(true);

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("PENDING");
    expect(job.run_after.toISOString()).toBe(runAfter.toISOString());
    expect(job.attempt_count).toBe(0);
    expect(job.lease_token).toBeNull();
    expect(job.lease_expires_at).toBeNull();
    expect(job.last_failure_at).toBeNull();
  });

  it("returns a retried job to PENDING at the given time, keeping the attempt and recording the failure", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    const runAfter = new Date(Date.now() + 600_000);

    expect(await store.retryReconciliationJob(claimed.id, claimed.leaseToken, runAfter)).toBe(true);

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("PENDING");
    expect(job.run_after.toISOString()).toBe(runAfter.toISOString());
    expect(job.attempt_count).toBe(1);
    expect(job.lease_token).toBeNull();
    expect(job.lease_expires_at).toBeNull();
    expect(job.last_failure_at).not.toBeNull();
  });

  it("marks a failed job FAILED, clears its lease and records the failure", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();

    expect(await store.failReconciliationJob(claimed.id, claimed.leaseToken)).toBe(true);

    const job = await onlyJobFor(repositoryId);
    expect(job.state).toBe("FAILED");
    expect(job.attempt_count).toBe(1);
    expect(job.lease_token).toBeNull();
    expect(job.lease_expires_at).toBeNull();
    expect(job.last_failure_at).not.toBeNull();
    expect(await store.claimNextReconciliationJob()).toBeNull();
  });

  it("releases a job whose fold took a mid-flight enqueue, on every path out of RUNNING", async () => {
    const runAfter = new Date(Date.now() + 600_000);
    const releases = [
      {
        name: "defer",
        release: (job: ClaimedReconciliationJob) =>
          store.deferReconciliationJob(job.id, job.leaseToken, runAfter),
      },
      {
        name: "retry",
        release: (job: ClaimedReconciliationJob) =>
          store.retryReconciliationJob(job.id, job.leaseToken, runAfter),
      },
      {
        name: "fail",
        release: (job: ClaimedReconciliationJob) => store.failReconciliationJob(job.id, job.leaseToken),
      },
    ];

    for (const { name, release } of releases) {
      const repositoryId = await insertRepository();
      await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
      const claimed = await claimOrFail();
      await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");

      expect(await release(claimed), name).toBe(true);

      const job = await onlyJobFor(repositoryId);
      expect(job.follow_up_requested, name).toBe(false);
    }
  });

  it("changes nothing under a stale lease token, for every outcome writer", async () => {
    const repositoryId = await insertRepository();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    const claimed = await claimOrFail();
    const before = await jobById(claimed.id);
    const staleToken = randomUUID();
    const runAfter = new Date(Date.now() + 600_000);

    expect(await store.completeReconciliationJob(claimed.id, staleToken)).toBe(false);
    expect(await store.deferReconciliationJob(claimed.id, staleToken, runAfter)).toBe(false);
    expect(await store.retryReconciliationJob(claimed.id, staleToken, runAfter)).toBe(false);
    expect(await store.failReconciliationJob(claimed.id, staleToken)).toBe(false);

    expect(await jobById(claimed.id)).toEqual(before);
  });
});
