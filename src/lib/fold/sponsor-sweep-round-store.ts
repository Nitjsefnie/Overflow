import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { SWEEP_WINDOW_MS } from "@/lib/fold/sweep-request-budget";

type Round = { window_start: Date; spent: number; rotation_cursor: string | null; next_enqueue_at: Date };

/**
 * The sweep's durable round, one row per sponsor: the singleton store's
 * window anchor, spend ceiling and rotation pacing, keyed by sponsor.
 */
export class PostgresSponsorSweepRoundStore {
  public constructor(private readonly connection?: SqlClient) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  private async round(transaction: TransactionClient, sponsorId: string, now: Date): Promise<Round> {
    // First touch anchors the sponsor's window at its first sweep, from zero;
    // a restart keeps the anchor, spend and cursor across whole windows.
    await transaction`insert into reconciliation_sweep_rounds (sponsor_id, window_start, next_enqueue_at)
      values (${sponsorId}, ${now}, ${now}) on conflict do nothing`;
    const [row] = await transaction<Round[]>`select * from reconciliation_sweep_rounds
      where sponsor_id = ${sponsorId} for update`;
    if (now.getTime() >= row!.window_start.getTime() + SWEEP_WINDOW_MS) {
      const start = new Date(row!.window_start.getTime()
        + Math.floor((now.getTime() - row!.window_start.getTime()) / SWEEP_WINDOW_MS) * SWEEP_WINDOW_MS);
      const [fresh] = await transaction<Round[]>`update reconciliation_sweep_rounds
        set window_start = ${start}, spent = 0, next_enqueue_at = ${start}
        where sponsor_id = ${sponsorId} returning *`;
      return fresh!;
    }
    return row!;
  }

  /** Admits one fold, or returns when the sponsor's window resets. */
  public async spend(sponsorId: string, now: Date, limit: number): Promise<Date | null> {
    return this.sql.begin(async (transaction) => {
      const round = await this.round(transaction, sponsorId, now);
      const rows = await transaction`update reconciliation_sweep_rounds set spent = spent + 1
        where sponsor_id = ${sponsorId} and spent < ${limit} returning spent`;
      return rows.length === 1 ? null : new Date(round.window_start.getTime() + SWEEP_WINDOW_MS);
    }) as Promise<Date | null>;
  }

  public async enqueueNext(
    sponsorId: string,
    repositoryIds: readonly string[],
    now: Date,
    limit: number,
    enqueue: (repositoryId: string) => Promise<unknown>,
  ): Promise<string | null> {
    return this.sql.begin(async (transaction) => {
      const round = await this.round(transaction, sponsorId, now);
      const ids = [...new Set(repositoryIds)].sort();
      if (ids.length === 0 || round.spent >= limit || now < round.next_enqueue_at) return null;
      const next = ids.find((id) => round.rotation_cursor === null || id > round.rotation_cursor) ?? ids[0]!;
      // An explicit unsuccessful enqueue retains this slot for the next poll.
      if (await enqueue(next) === false) return null;
      const interval = Math.max(15_000, Math.floor(SWEEP_WINDOW_MS / ids.length));
      // Preserve fractional poll timing; after a long outage restart from this
      // admission instead of replaying missed slots in a catch-up burst.
      const deadline = round.next_enqueue_at.getTime();
      const anchor = now.getTime() - deadline > interval ? now.getTime() : deadline;
      await transaction`update reconciliation_sweep_rounds set rotation_cursor = ${next},
        next_enqueue_at = ${new Date(anchor + interval)} where sponsor_id = ${sponsorId}`;
      return next;
    }) as Promise<string | null>;
  }
}
