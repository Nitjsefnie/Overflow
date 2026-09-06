import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";
import { RECONCILIATION_LEASE_MINUTES } from "@/lib/fold/reconciliation-worker";

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

async function jobsFor(repositoryId: string): Promise<JobSnapshot[]> {
  return sql<JobSnapshot[]>`
    select id, repository_id, reason, state::text as state, attempt_count, run_after,
           lease_token::text as lease_token, lease_expires_at, last_failure_at,
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
           lease_token::text as lease_token, lease_expires_at, last_failure_at,
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

    await claimOrFail();

    // Read as an interval the database computes, so the only slack is the clock
    // between the claim and this query rather than anything waited on here.
    const [row] = await sql<{ minutes: number }[]>`
      select (extract(epoch from (lease_expires_at - now())) / 60)::float8 as minutes
      from repository_reconciliation_jobs
      where repository_id = ${repositoryId}
    `;
    expect(row.minutes).toBeGreaterThan(RECONCILIATION_LEASE_MINUTES - 1);
    expect(row.minutes).toBeLessThanOrEqual(RECONCILIATION_LEASE_MINUTES);
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
