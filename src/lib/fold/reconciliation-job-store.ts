import { randomUUID } from "node:crypto";
import type { SqlClient } from "@/lib/db/types";
import type {
  ClaimedReconciliationJob,
  ReconciliationJobReason,
} from "@/lib/fold/reconciliation-jobs";
import { RECONCILIATION_LEASE_MS } from "@/lib/fold/reconciliation-worker";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";

type ReconciliationJobLeaseRow = {
  id: string;
  repository_id: string;
  reason: ReconciliationJobReason;
  attempt_count: number;
  lease_token: string;
  rederivation_requested_at: Date | null;
  rederivation_generation: string;
};

export class PostgresReconciliationJobStore {
  public constructor(private readonly sql: SqlClient) {}

  public async enqueueReconciliationJob(
    repositoryId: string,
    reason: ReconciliationJobReason,
  ): Promise<void> {
    // A repository owns exactly one row, so a burst of events collapses onto it
    // rather than queueing one fold per event. A job that is merely backing off
    // keeps its `run_after`, which is what stops a webhook storm from walking a
    // failing repository's backoff forward and hammering GitHub past it; a FAILED job is revived as due now with its attempts
    // reset, which is what makes the sweep an autonomous repair path, and
    // `last_failure_at` survives that revival as the visible evidence that this
    // repository has been failing. An event arriving mid-fold leaves the RUNNING
    // job alone and records `follow_up_requested` instead, because the fold in
    // flight may have read GitHub before the event happened. The update never
    // touches the lease columns, so it cannot violate the lease check. `reason`
    // is left as first recorded: it says why the repository entered the queue.
    // The cast on the state arm is required: a `case` whose branches are both
    // bare literals resolves to text, which will not assign to an enum column.
    await this.sql`
      insert into repository_reconciliation_jobs (repository_id, reason)
      values (${repositoryId}, ${reason})
      on conflict (repository_id) do update
      set ${this.reconciliationJobConflictUpdate()}
    `;
  }

  public async enqueueWebhookReconciliation(repositoryId: string, delivery: GitHubWebhookDelivery): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [repository] = await transaction`select id from registered_repositories
        where id = ${repositoryId} and github_repository_id = ${delivery.repositoryGitHubId}`;
      if (repository === undefined) throw new Error("Webhook repository identity did not match.");
      const subject = delivery.subject;
      await transaction`insert into repository_reconciliation_dirty_subjects
        (repository_id, kind, github_subject_id, subject_number)
        values (${repositoryId}, ${subject.kind}, ${subject.id}, ${subject.number})
        on conflict (repository_id, kind, github_subject_id) do update
        set subject_number = excluded.subject_number, generation = excluded.generation`;
      await transaction`insert into repository_reconciliation_jobs (repository_id, reason)
        values (${repositoryId}, 'WEBHOOK') on conflict (repository_id) do update
        set ${this.reconciliationJobConflictUpdate()}`;
    });
  }

  public async requestRepositoryRederivation(repositoryId: string, at: Date): Promise<void> {
    // The generation names each request even when its informational timestamp
    // is equal to or earlier than an existing request's.
    await this.sql`
      insert into repository_reconciliation_jobs (repository_id, reason, rederivation_requested_at, rederivation_generation)
      values (${repositoryId}, 'REDERIVATION', ${at}, 1)
      on conflict (repository_id) do update
      set ${this.reconciliationJobConflictUpdate()},
          rederivation_requested_at = greatest(coalesce(repository_reconciliation_jobs.rederivation_requested_at, ${at}), ${at}),
          rederivation_generation = repository_reconciliation_jobs.rederivation_generation + 1
    `;
  }

  /** Shared lifecycle policy for ordinary events and explicit re-derivation requests. */
  private reconciliationJobConflictUpdate() {
    return this.sql`
      state = case when repository_reconciliation_jobs.state = 'RUNNING' then 'RUNNING' else 'PENDING' end::repository_reconciliation_job_state,
          follow_up_requested = case when repository_reconciliation_jobs.state = 'RUNNING' then true else repository_reconciliation_jobs.follow_up_requested end,
          attempt_count = case when repository_reconciliation_jobs.state = 'FAILED' then 0 else repository_reconciliation_jobs.attempt_count end,
          run_after = case when repository_reconciliation_jobs.state = 'FAILED' then now() else repository_reconciliation_jobs.run_after end
    `;
  }

  public async claimNextReconciliationJob(): Promise<ClaimedReconciliationJob | null> {
    const leaseToken = randomUUID();
    // The claim increments `attempt_count` so that a worker which dies mid-fold
    // still burns an attempt and the reclaim path cannot loop forever. Nothing
    // further is needed to keep two workers off one repository: a repository owns
    // one row, so a repository already being folded has no second row to claim.
    const rows = await this.sql<ReconciliationJobLeaseRow[]>`
      with due as (
        select job.id
        from repository_reconciliation_jobs as job
        where (
            (job.state = ${"PENDING"} and job.run_after <= now())
            or (job.state = ${"RUNNING"} and job.lease_expires_at <= now())
            -- A NULL duration identifies the current lease as an old build's,
            -- including after a rollback or mixed-version takeover. Claims bind
            -- their marker to the lease token; releases clear it, and the database
            -- clears an inherited marker when an old writer changes that token.
            or (job.state = ${"RUNNING"} and job.lease_duration_ms is null)
          )
        order by job.run_after, job.created_at
        limit 1
        for update skip locked
      )
      update repository_reconciliation_jobs
      set state = ${"RUNNING"},
          lease_token = ${leaseToken},
          lease_duration_ms = ${RECONCILIATION_LEASE_MS},
          lease_duration_token = ${leaseToken},
          lease_expires_at = now() + make_interval(secs => ${RECONCILIATION_LEASE_MS / 1000}),
          attempt_count = repository_reconciliation_jobs.attempt_count + 1
      from due
      where repository_reconciliation_jobs.id = due.id
      returning
        repository_reconciliation_jobs.id::text as id,
        repository_reconciliation_jobs.repository_id::text as repository_id,
        repository_reconciliation_jobs.reason,
        repository_reconciliation_jobs.attempt_count,
        repository_reconciliation_jobs.lease_token::text as lease_token,
        repository_reconciliation_jobs.rederivation_requested_at,
        repository_reconciliation_jobs.rederivation_generation
    `;
    const [row] = rows;
    return row === undefined
      ? null
      : {
          id: row.id,
          repositoryId: row.repository_id,
          reason: row.reason,
          attemptCount: row.attempt_count,
          leaseToken: row.lease_token,
          rederivationRequestedAt: row.rederivation_requested_at,
          rederivationGeneration: Number(row.rederivation_generation),
        };
  }

  public async renewReconciliationJobLease(jobId: string, leaseToken: string, renewalDeadline: Date): Promise<boolean> {
    // State is deliberate defence in depth: the lease check makes non-RUNNING
    // tokens null, so removing only the state predicate is unobservable under
    // the current schema; the token equality already excludes those rows.
    const rows = await this.sql<{ id: string }[]>`
      update repository_reconciliation_jobs
      set lease_expires_at = now() + make_interval(secs => ${RECONCILIATION_LEASE_MS / 1000})
      where id = ${jobId}
        and state = ${"RUNNING"}
        and lease_token = ${leaseToken}
        and now() < ${renewalDeadline}
      returning id
    `;
    return rows.length === 1;
  }

  public async completeReconciliationJob(
    jobId: string,
    leaseToken: string,
    rederivationGeneration: number,
  ): Promise<boolean> {
    // An event that arrived during the fold may not be reflected in it, so a job
    // that took a follow-up becomes a fresh PENDING job instead of disappearing.
    // The row is locked for the decision so that an enqueue cannot set the flag
    // between reading it and acting on it, which would drop that event silently.
    // Compare request generations under that same lock; timestamps are only
    // informational. Uncaptured work must survive both update and delete paths.
    return this.sql.begin(async (transaction) => {
      const [row] = await transaction<{ follow_up_requested: boolean; request_matches: boolean }[]>`
        select follow_up_requested,
               rederivation_generation = ${rederivationGeneration} as request_matches
        from repository_reconciliation_jobs
        where id = ${jobId}
          and state = ${"RUNNING"}
          and lease_token = ${leaseToken}
        for update
      `;
      if (row === undefined) {
        return false;
      }
      if (row.follow_up_requested || !row.request_matches) {
        await transaction`
          update repository_reconciliation_jobs
          set state = ${"PENDING"},
              attempt_count = 0,
              run_after = now(),
              last_failure_at = null,
              follow_up_requested = false,
              rederivation_requested_at = case when ${row.request_matches} then null else rederivation_requested_at end,
              lease_token = null,
              lease_duration_ms = null,
              lease_expires_at = null
          where id = ${jobId}
        `;
        return true;
      }
      await transaction`
        delete from repository_reconciliation_jobs where id = ${jobId}
      `;
      return true;
      // The driver types `begin` as returning its callback's result widened by the
      // transaction's own row type, so the boolean needs saying again here.
    }) as Promise<boolean>;
  }

  public async deferReconciliationJob(
    jobId: string,
    leaseToken: string,
    runAfter: Date,
  ): Promise<boolean> {
    // The reconciliation cooldown declined to fold, so the claim's increment is
    // given back: nothing was attempted and nothing failed.
    // This path and the two below clear `follow_up_requested`: each returns the
    // row to a state that will be worked again, so a mid-fold event is already
    // accounted for by that future run, and the flag keeps its single meaning —
    // a fold is in flight and an event arrived after it started.
    const rows = await this.sql<{ id: string }[]>`
      update repository_reconciliation_jobs
      set state = ${"PENDING"},
          run_after = ${runAfter},
          attempt_count = greatest(attempt_count - 1, 0),
          follow_up_requested = false,
          lease_token = null,
          lease_duration_ms = null,
          lease_expires_at = null
      where id = ${jobId}
        and state = ${"RUNNING"}
        and lease_token = ${leaseToken}
      returning id
    `;
    return rows.length === 1;
  }

  public async retryReconciliationJob(
    jobId: string,
    leaseToken: string,
    runAfter: Date,
  ): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update repository_reconciliation_jobs
      set state = ${"PENDING"},
          run_after = ${runAfter},
          last_failure_at = now(),
          follow_up_requested = false,
          lease_token = null,
          lease_duration_ms = null,
          lease_expires_at = null
      where id = ${jobId}
        and state = ${"RUNNING"}
        and lease_token = ${leaseToken}
      returning id
    `;
    return rows.length === 1;
  }

  public async failReconciliationJob(jobId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update repository_reconciliation_jobs
      set state = ${"FAILED"},
          last_failure_at = now(),
          follow_up_requested = false,
          lease_token = null,
          lease_duration_ms = null,
          lease_expires_at = null
      where id = ${jobId}
        and state = ${"RUNNING"}
        and lease_token = ${leaseToken}
      returning id
    `;
    return rows.length === 1;
  }
}
