import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";

export type CatchupAdvance = {
  /** The repository whose catch-up was claimed, or null. */
  enqueued: string | null;
  completed: string | null;
  failed: string | null;
  requeued: number;
};

/**
 * The catch-up state machine's durable half (one row per repository).
 *
 * Everything happens inside `advance`'s one transaction per sponsor tick: the
 * rows' creation for a sponsor newly over the threshold, the bounded re-queue
 * of unsafe completed rows, the in-flight end detection and the claim of the
 * next catch-up together with its job insert.
 */
export class PostgresSweepCatchupStore {
  public constructor(private readonly connection?: SqlClient) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  /**
   * The sponsor's terminal rows (completed and failed), the only states the
   * evidence check reads: an unsafe-evidence bump sends either back to pending.
   */
  public async requeueCandidateIds(sponsorId: string): Promise<string[]> {
    const rows = await this.sql<{ repository_id: string }[]>`
      select repository_id::text as repository_id from reconciliation_sweep_catchups
      where sponsor_id = ${sponsorId} and state in ('completed', 'failed')`;
    return rows.map((row) => row.repository_id);
  }

  public async advance(input: {
    sponsorId: string;
    activeRepositoryIds: readonly string[];
    requeueRepositoryIds: readonly string[];
    now: Date;
    enqueue: (repositoryId: string, transaction: TransactionClient) => Promise<unknown>;
  }): Promise<CatchupAdvance> {
    return this.sql.begin(async (transaction) => {
      // One writer per sponsor: this row lock serializes concurrent ticks (a
      // second process's tick waits here and then sees the first's in-flight
      // row), which the per-sponsor one-at-a-time rule needs.
      await transaction`select from users where id = ${input.sponsorId} for update`;

      const outcome: CatchupAdvance = { enqueued: null, completed: null, failed: null, requeued: 0 };

      // Creation: the first tick over the threshold inserts every active
      // repository that has no row yet, pending.
      if (input.activeRepositoryIds.length > 0) {
        await transaction`
          insert into reconciliation_sweep_catchups (repository_id, sponsor_id, state)
          select r.id, r.sponsor_id, 'pending'
          from registered_repositories as r
          where r.sponsor_id = ${input.sponsorId} and r.active
            and r.id = any(${transaction.array([...input.activeRepositoryIds])}::uuid[])
            and not exists (
              select 1 from reconciliation_sweep_catchups as c where c.repository_id = r.id
            )
          on conflict do nothing`;
      }

      // Re-queue: bounded to terminal rows the tick found unsafe — a completed
      // or failed catch-up rejoins the queue when the evidence format changed
      // or the fold revision rose.
      if (input.requeueRepositoryIds.length > 0) {
        const rows = await transaction`
          update reconciliation_sweep_catchups set state = 'pending', updated_at = ${input.now}
          where sponsor_id = ${input.sponsorId} and state in ('completed', 'failed')
            and repository_id = any(${transaction.array([...input.requeueRepositoryIds])}::uuid[])
          returning repository_id`;
        outcome.requeued = rows.length;
      }

      // End detection. The mapping: no job row means the fold completed (the
      // completion deletes it) — never a claim crash, because the claim and the
      // job insert commit together below. FAILED is failed. PENDING with a
      // non-SWEEP reason is the follow-up a completed fold re-queued —
      // completed. Everything else is still in flight.
      const [flight] = await transaction<{ repository_id: string }[]>`
        select repository_id::text as repository_id from reconciliation_sweep_catchups
        where sponsor_id = ${input.sponsorId} and state = 'in_flight'
        limit 1`;
      if (flight !== undefined) {
        const [job] = await transaction<{ state: "PENDING" | "RUNNING" | "FAILED"; reason: string }[]>`
          select state::text as state, reason from repository_reconciliation_jobs
          where repository_id = ${flight.repository_id}`;
        const ended = job === undefined
          ? ("completed" as const)
          : job.state === "FAILED"
            ? ("failed" as const)
            : job.state === "PENDING" && job.reason !== "SWEEP"
              ? ("completed" as const)
              : null;
        if (ended === null) return outcome;
        await transaction`
          update reconciliation_sweep_catchups set state = ${ended}, updated_at = ${input.now}
          where repository_id = ${flight.repository_id}`;
        if (ended === "completed") outcome.completed = flight.repository_id;
        else outcome.failed = flight.repository_id;
      }

      // The claim: the smallest pending catch-up of the sponsor (size asc,
      // unmeasured counts zero; ties by repository id) is enqueued and marked
      // in flight inside this same transaction — the enqueue failing rolls the
      // claim back, so a crash can never leave in flight without a job row.
      const [next] = await transaction<{ repository_id: string }[]>`
        select c.repository_id::text as repository_id
        from reconciliation_sweep_catchups as c
        join registered_repositories as r on r.id = c.repository_id and r.active
        left join repository_reconciliation_sizes as s on s.repository_id = c.repository_id
        where c.sponsor_id = ${input.sponsorId} and c.state = 'pending'
        order by coalesce(s.total_count, 0), c.repository_id
        limit 1
        for update of c`;
      if (next === undefined) return outcome;
      await input.enqueue(next.repository_id, transaction);
      await transaction`
        update reconciliation_sweep_catchups set state = 'in_flight', updated_at = ${input.now}
        where repository_id = ${next.repository_id}`;
      outcome.enqueued = next.repository_id;
      return outcome;
    });
  }
}
