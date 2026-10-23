import { readEnv } from "@/lib/env";
import { repositoryLockNamespace } from "@/lib/fold/repository-coordination";
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import type { DirtyReconciliationSubject } from "@/lib/fold/reconciliation-evidence";
import { readSweepPassPageCeiling, type SweepPass, type SweepPassInput } from "@/lib/fold/sweep-pass";

type PassRow = { pass_id: string; scan_started_at: Date; dirty_subjects: DirtyReconciliationSubject[] };
export class PostgresSweepPassStore {
  public constructor(
    private readonly connection?: SqlClient,
    private readonly pageCeiling: number = readSweepPassPageCeiling({
      RECONCILIATION_SWEEP_PAGE_CEILING: readEnv("RECONCILIATION_SWEEP_PAGE_CEILING"),
    }),
  ) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  /** The caller holds repository coordination; deletion cascades staged pages. */
  public async discardByRepository(repositoryId: string, transaction?: TransactionClient): Promise<void> {
    const sql = transaction ?? this.sql;
    await sql`delete from reconciliation_sweep_passes where repository_id = ${repositoryId}`;
  }

  /** Unregistration owns its row transaction; take coordination without waiting on a live fold. */
  public async discardIfIdle(repositoryId: string, transaction: TransactionClient): Promise<void> {
    const [lock] = await transaction<{ acquired: boolean }[]>`select
      pg_try_advisory_xact_lock(hashtextextended(${repositoryId}, ${repositoryLockNamespace})) as acquired`;
    if (lock?.acquired === true) await this.discardByRepository(repositoryId, transaction);
  }

  public async open(input: SweepPassInput): Promise<SweepPass> {
    let pageCount = 0;
    let writes = Promise.resolve();
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
      const [pages] = await transaction<{ count: number }[]>`select count(*)::int as count
        from reconciliation_sweep_pages where pass_id = ${row!.pass_id}`;
      pageCount = pages!.count;
      if (pageCount > this.pageCeiling) {
        await transaction`delete from reconciliation_sweep_pages where pass_id = ${row!.pass_id}`;
        pageCount = 0;
      }
      return row!;
    }) as unknown as PassRow;
    return {
      id: row.pass_id, scanStartedAt: row.scan_started_at, dirtySubjects: row.dirty_subjects,
      read: async (key) => {
        const [page] = await this.sql<{ payload: unknown }[]>`select payload from reconciliation_sweep_pages
          where pass_id = ${row.pass_id} and request_key = ${key}`;
        return page?.payload;
      },
      write: (key, payload, cursor) => {
        const write = writes.then(async () => {
          if (pageCount >= this.pageCeiling) return;
          const stored = await this.sql.begin(async (transaction) => {
            const inserted = await transaction`insert into reconciliation_sweep_pages (pass_id, request_key, payload)
              values (${row.pass_id}, ${key}, ${transaction.json(payload as Parameters<SqlClient["json"]>[0])})
              on conflict do nothing returning request_key`;
            if (inserted.length === 0) return false;
            if (cursor !== undefined) await transaction`update reconciliation_sweep_passes
              set walk_cursor = ${cursor} where pass_id = ${row.pass_id}`;
            return true;
          });
          if (stored) pageCount++;
        });
        writes = write.catch(() => {});
        return write;
      },
      complete: async () => { await this.sql`delete from reconciliation_sweep_passes where pass_id = ${row.pass_id}`; },
    };
  }
}
