import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";

export type CatchupAdvance = {
  /** The repository whose catch-up was claimed, or null. */
  enqueued: string | null;
  completed: string | null;
  failed: string | null;
  requeued: number;
};

/** One durable catch-up row per repository, advanced in one transaction per sponsor tick. */
export class PostgresSweepCatchupStore {
  public constructor(private readonly connection?: SqlClient) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  /** Terminal rows the evidence check may re-queue. */
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
      // One writer per sponsor: this lock serializes concurrent ticks.
      await transaction`select from users where id = ${input.sponsorId} for update`;

      const outcome: CatchupAdvance = { enqueued: null, completed: null, failed: null, requeued: 0 };

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

      // Re-queue: terminal rows the tick found unsafe (evidence format or fold revision moved).
      if (input.requeueRepositoryIds.length > 0) {
        const rows = await transaction`
          update reconciliation_sweep_catchups set state = 'pending', updated_at = ${input.now}
          where sponsor_id = ${input.sponsorId} and state in ('completed', 'failed')
            and repository_id = any(${transaction.array([...input.requeueRepositoryIds])}::uuid[])
          returning repository_id`;
        outcome.requeued = rows.length;
      }

      // End detection: absent job row = completed (the claim and the job insert commit
      // together), FAILED = failed, PENDING non-SWEEP = the completed fold's follow-up.
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

      // The claim: smallest pending catch-up (size asc, ties by id), enqueued and
      // marked in flight in this transaction — the enqueue failing rolls the claim back.
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
