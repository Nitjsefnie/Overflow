import { readEnv } from "@/lib/env";
import { repositoryLockNamespace } from "@/lib/fold/repository-coordination";
import { randomUUID } from "node:crypto";
import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import type { DirtyReconciliationSubject } from "@/lib/fold/reconciliation-evidence";
import { readSweepPassPageCeiling, type SweepPass, type SweepPassInput } from "@/lib/fold/sweep-pass";
import { isDirtySubjects } from "@/lib/fold/staged-pass-data";

type PassRow = { pass_id: string; scan_started_at: Date; dirty_subjects: DirtyReconciliationSubject[]; walk_anchors: unknown };
type WalkAnchors = Record<string, { updatedAt: Date; key: number }>;

function parseWalkAnchors(value: unknown): WalkAnchors {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, point]) => {
    if (point === null || typeof point !== "object" || typeof point.updated_at !== "string"
      || !Number.isSafeInteger(point.key)) return [];
    const updatedAt = new Date(point.updated_at);
    return Number.isFinite(updatedAt.getTime()) ? [[name, { updatedAt, key: point.key }]] : [];
  }));
}
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

  /** Reading the row FOR SHARE waits out an in-flight unregistration; discardIfIdle only tries the advisory lock, so it never waits while the row is held. */
  public async discardIfInactive(repositoryId: string): Promise<void> {
    await this.sql.begin(async (transaction) => {
      const [row] = await transaction<{ active: boolean }[]>`select active from registered_repositories
        where id = ${repositoryId} for share`;
      if (row?.active !== true) await this.discardIfIdle(repositoryId, transaction);
    });
  }

  public async open(input: SweepPassInput): Promise<SweepPass> {
    let pageCount = 0;
    let writes = Promise.resolve();
    const row = await this.sql.begin(async (transaction) => {
      // The fold's repository lock serializes opens. A changed evidence version
      // means an incremental publication superseded this snapshot; restart it.
      await transaction`delete from reconciliation_sweep_passes where repository_id = ${input.repositoryId}
        and evidence_version is distinct from ${input.evidenceVersion}`;
      // The open caller has no pass to discard yet, so a pass whose own dirty subjects are unreadable is restarted here.
      const [stored] = await transaction<{ dirty_subjects: unknown }[]>`select dirty_subjects
        from reconciliation_sweep_passes where repository_id = ${input.repositoryId}`;
      if (stored !== undefined && !isDirtySubjects(stored.dirty_subjects)) {
        await transaction`delete from reconciliation_sweep_passes where repository_id = ${input.repositoryId}`;
      }
      await transaction`insert into reconciliation_sweep_passes
        (repository_id, pass_id, scan_started_at, evidence_version, dirty_subjects)
        values (${input.repositoryId}, ${randomUUID()}, ${input.scanStartedAt}, ${input.evidenceVersion}, ${transaction.json(input.dirtySubjects)})
        on conflict (repository_id) do nothing`;
      const [row] = await transaction<PassRow[]>`select pass_id, scan_started_at, dirty_subjects, walk_anchors
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
    let anchors = parseWalkAnchors(row.walk_anchors);
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
      walkAnchors: () => anchors,
      stage: async (input) => {
        const committed = await this.sql.begin(async (transaction) => {
          // Text binding preserves JSON null and avoids a second client-side JSON encoding.
          await transaction`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
            values (${row.pass_id}, ${input.kind}, ${input.subjectKey}, ${input.updatedAt},
              ${JSON.stringify(input.payload)}::text::jsonb)
            on conflict (pass_id, kind, subject_key) do update
              set updated_at = excluded.updated_at, payload = excluded.payload`;
          // Concurrent staging inserts already hold FK key-share locks on this pass.
          const [pass] = await transaction<{ walk_anchors: unknown }[]>`select walk_anchors
            from reconciliation_sweep_passes where pass_id = ${row.pass_id} for no key update`;
          let next = parseWalkAnchors(pass!.walk_anchors);
          const previous = Object.hasOwn(next, input.anchor) ? next[input.anchor] : undefined;
          if (previous === undefined || input.updatedAt.getTime() > previous.updatedAt.getTime()
            || (input.updatedAt.getTime() === previous.updatedAt.getTime() && input.subjectKey > previous.key)) {
            next = { ...next, [input.anchor]: { updatedAt: input.updatedAt, key: input.subjectKey } };
            const stored = Object.fromEntries(Object.entries(next).map(([name, point]) =>
              [name, { updated_at: point.updatedAt.toISOString(), key: point.key }]));
            await transaction`update reconciliation_sweep_passes set walk_anchors = ${transaction.json(stored)}
              where pass_id = ${row.pass_id}`;
          }
          return next;
        });
        anchors = committed as unknown as WalkAnchors;
      },
      readStaged: async () => {
        const subjects = await this.sql<{ kind: "issue" | "pull_request"; subject_key: number | string; updated_at: Date; payload: unknown }[]>`
          select kind, subject_key, updated_at, payload from reconciliation_sweep_walk_subjects
          where pass_id = ${row.pass_id} order by kind, subject_key`;
        return subjects.map((subject) => ({ kind: subject.kind, subjectKey: Number(subject.subject_key),
          updatedAt: subject.updated_at, payload: subject.payload }));
      },
      deleteStaged: async (keys) => {
        if (keys.length === 0) return;
        await this.sql`delete from reconciliation_sweep_walk_subjects where pass_id = ${row.pass_id}
          and (kind, subject_key) in (select kind, "subjectKey" from
            jsonb_to_recordset(${this.sql.json([...keys])}) as requested(kind text, "subjectKey" bigint))`;
      },
      complete: async () => { await this.sql`delete from reconciliation_sweep_passes where pass_id = ${row.pass_id}`; },
    };
  }
}
