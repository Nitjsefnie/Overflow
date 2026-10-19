import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { SWEEP_WINDOW_MS } from "@/lib/fold/sweep-request-budget";

type Round = { window_start: Date; spent: number; rotation_cursor: string | null; next_enqueue_at: Date };

export class PostgresSweepRoundStore {
  public constructor(private readonly connection?: SqlClient) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  private async round(transaction: TransactionClient, now: Date): Promise<Round> {
    // Anchor six-hour windows to the first sweep. A restart retains the anchor,
    // spend and cursor; missed ticks advance whole windows rather than drifting.
    await transaction`insert into reconciliation_sweep_round (window_start, next_enqueue_at)
      values (${now}, ${now}) on conflict do nothing`;
    const [row] = await transaction<Round[]>`select * from reconciliation_sweep_round for update`;
    if (now.getTime() >= row!.window_start.getTime() + SWEEP_WINDOW_MS) {
      const start = new Date(row!.window_start.getTime()
        + Math.floor((now.getTime() - row!.window_start.getTime()) / SWEEP_WINDOW_MS) * SWEEP_WINDOW_MS);
      const [fresh] = await transaction<Round[]>`update reconciliation_sweep_round
        set window_start = ${start}, spent = 0, next_enqueue_at = ${start} returning *`;
      return fresh!;
    }
    return row!;
  }

  public async spend(now: Date, limit: number): Promise<Date | null> {
    return this.sql.begin(async (transaction) => {
      const round = await this.round(transaction, now);
      const rows = await transaction`update reconciliation_sweep_round set spent = spent + 1
        where singleton and spent < ${limit} returning spent`;
      return rows.length === 1 ? null : new Date(round.window_start.getTime() + SWEEP_WINDOW_MS);
    }) as Promise<Date | null>;
  }

  public async enqueueNext(
    repositoryIds: readonly string[], now: Date, limit: number,
    enqueue: (repositoryId: string) => Promise<unknown>,
  ): Promise<string | null> {
    return this.sql.begin(async (transaction) => {
      const round = await this.round(transaction, now);
      const ids = [...new Set(repositoryIds)].sort();
      if (ids.length === 0 || round.spent >= limit || now < round.next_enqueue_at) return null;
      const next = ids.find((id) => round.rotation_cursor === null || id > round.rotation_cursor) ?? ids[0]!;
      await enqueue(next);
      const interval = Math.max(15_000, Math.floor(SWEEP_WINDOW_MS / ids.length));
      await transaction`update reconciliation_sweep_round set rotation_cursor = ${next},
        next_enqueue_at = ${new Date(now.getTime() + interval)}`;
      return next;
    }) as Promise<string | null>;
  }
}
