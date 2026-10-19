import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type { DirtyReconciliationSubject } from "@/lib/fold/reconciliation-evidence";
import type { SweepPass, SweepPassInput } from "@/lib/fold/sweep-pass";

type PassRow = { pass_id: string; scan_started_at: Date; dirty_subjects: DirtyReconciliationSubject[] };
export class PostgresSweepPassStore {
  public constructor(private readonly connection?: SqlClient) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  public async open(input: SweepPassInput): Promise<SweepPass> {
    const row = await this.sql.begin(async (transaction) => {
      // The fold's repository lock serializes opens. A changed evidence version
      // means an incremental publication superseded this snapshot; restart it.
      await transaction`delete from reconciliation_sweep_passes where repository_id = ${input.repositoryId}
        and evidence_version is distinct from ${input.evidenceVersion}`;
      await transaction`insert into reconciliation_sweep_passes
        (repository_id, pass_id, scan_started_at, evidence_version, dirty_subjects)
        values (${input.repositoryId}, ${randomUUID()}, ${input.scanStartedAt}, ${input.evidenceVersion}, ${transaction.json(input.dirtySubjects)})
        on conflict (repository_id) do nothing`;
      const [row] = await transaction<PassRow[]>`select pass_id, scan_started_at, dirty_subjects
        from reconciliation_sweep_passes where repository_id = ${input.repositoryId}`;
      return row!;
    }) as unknown as PassRow;
    return {
      id: row.pass_id, scanStartedAt: row.scan_started_at, dirtySubjects: row.dirty_subjects,
      read: async (key) => {
        const [page] = await this.sql<{ payload: unknown }[]>`select payload from reconciliation_sweep_pages
          where pass_id = ${row.pass_id} and request_key = ${key}`;
        return page?.payload;
      },
      write: async (key, payload, cursor) => {
        await this.sql.begin(async (transaction) => {
          await transaction`insert into reconciliation_sweep_pages (pass_id, request_key, payload)
            values (${row.pass_id}, ${key}, ${transaction.json(payload as Parameters<SqlClient["json"]>[0])})
            on conflict do nothing`;
          if (cursor !== undefined) await transaction`update reconciliation_sweep_passes
            set walk_cursor = ${cursor} where pass_id = ${row.pass_id}`;
        });
      },
      complete: async () => { await this.sql`delete from reconciliation_sweep_passes where pass_id = ${row.pass_id}`; },
    };
  }
}
