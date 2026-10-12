import type { Row, Sql, TransactionSql } from "postgres";

type PlanNode = { [key: string]: unknown; Plans?: PlanNode[] };
export interface DeleteProbe { table: string; deleted: number; returned: number }
export interface FkProbe { deleted: number; seq: number; idx: number }
export interface SelectionProbe { table: string; examined: number }
export interface CandidateProbe { examined: number; deleteSharedHits: number; source: "delete" | "fetch" }

/** Observe actual statements/transactions while retaining the real postgres driver. */
export function observeRetentionSql(raw: Sql, options: {
  measureChanges?: boolean;
  observeRunFk?: boolean;
  observeSelections?: boolean;
  disableTransactionIndexes?: boolean;
} = {}): { client: Sql; deletes: DeleteProbe[]; fk: FkProbe[]; candidates: CandidateProbe[]; selections: SelectionProbe[] } {
  const deletes: DeleteProbe[] = [];
  const fk: FkProbe[] = [];
  const candidates: CandidateProbe[] = [];
  const selections: SelectionProbe[] = [];
  const wrap = <C extends Sql | TransactionSql>(target: C): C => new Proxy(target, {
    apply(callTarget, thisArg, args) {
      const fragments = args[0] as TemplateStringsArray | undefined;
      if (!Array.isArray(fragments?.raw)) return Reflect.apply(callTarget, thisArg, args);
      const selection = /^\s*select\s+id\s+from\s+(webhook_deliveries|reconciliation_runs)/i
        .exec(fragments!.join(" "))?.[1];
      if (selection && options.observeSelections) {
        return (async () => {
          const before = await readExaminedRows(target, selection);
          const rows = await Reflect.apply(callTarget, thisArg, args);
          const after = await readExaminedRows(target, selection);
          selections.push({ table: selection, examined: after - before });
          return rows;
        })();
      }
      const table = /\bdelete\s+from\s+([a-z_]+)/i.exec(fragments!.join(" "))?.[1];
      if (!table) return Reflect.apply(callTarget, thisArg, args);
      return (async () => {
        const parent = table === "reconciliation_runs" && options.observeRunFk;
        const before = parent ? await readChangesScans(target) : undefined;
        let rows: Row[] & { count: number };
        if (table === "reconciliation_changes" && options.measureChanges) {
          // EXPLAIN ANALYZE executes this exact DELETE once, with its original
          // parameters and transaction; only its result transport is replaced.
          const prefix = "explain (analyze, buffers, timing off, format json) ";
          const explained = Object.assign([prefix + fragments![0], ...fragments!.slice(1)], {
            raw: [prefix + fragments!.raw[0], ...fragments!.raw.slice(1)],
          });
          const plans = await Reflect.apply(callTarget, thisArg, [explained, ...args.slice(1)]);
          const root = plans[0]["QUERY PLAN"][0].Plan as PlanNode;
          const input = root.Plans![0];
          const deleted = Number(input["Actual Rows"]) * Number(input["Actual Loops"]);
          const limits = walk(root).filter((node) => node["Node Type"] === "Limit");
          const scans = limits.flatMap(walk).filter((node) => /Scan/.test(String(node["Node Type"]))
            && node["Node Type"] !== "Bitmap Index Scan");
          candidates.push({
            examined: scans.reduce((sum, node) => sum + (Number(node["Actual Rows"] ?? 0)
              + Number(node["Rows Removed by Filter"] ?? 0)) * Number(node["Actual Loops"] ?? 1), 0),
            deleteSharedHits: Number(root["Shared Hit Blocks"] ?? 0), source: "delete",
          });
          rows = Object.assign([], { count: deleted });
        } else {
          rows = await Reflect.apply(callTarget, thisArg, args);
          deletes.push({ table, deleted: rows.count, returned: rows.length });
        }
        if (before) {
          const after = await readChangesScans(target);
          fk.push({ deleted: rows.count, seq: after.seq - before.seq, idx: after.idx - before.idx });
        }
        return rows;
      })();
    },
    get(getTarget, property) {
      if (property === "begin") {
        return (callback: (tx: TransactionSql) => unknown) => (getTarget as Sql).begin(async (tx) => {
          if (options.disableTransactionIndexes) {
            await tx`set local enable_indexscan = off`;
            await tx`set local enable_bitmapscan = off`;
          }
          return callback(wrap(tx));
        });
      }
      if (property === "unsafe" && options.measureChanges) {
        const unsafe = Reflect.get(getTarget, property, getTarget);
        return (...args: unknown[]) => {
          if (!/^fetch forward \d+ from retention_changes_cursor$/i.test(String(args[0]))) {
            return Reflect.apply(unsafe, getTarget, args);
          }
          return (async () => {
            // The actual cursor FETCH retains scan position across DELETEs.
            // Its tuple counters include filtered rows, with no imitation plan.
            const before = await readExaminedRows(getTarget, "reconciliation_changes");
            const rows = await Reflect.apply(unsafe, getTarget, args);
            const after = await readExaminedRows(getTarget, "reconciliation_changes");
            candidates.push({ examined: after - before, deleteSharedHits: 0, source: "fetch" });
            return rows;
          })();
        };
      }
      const value = Reflect.get(getTarget, property, getTarget);
      return typeof value === "function" ? value.bind(getTarget) : value;
    },
  });
  return { client: wrap(raw), deletes, fk, candidates, selections };
}

function walk(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(walk)];
}

async function readChangesScans(sql: Sql | TransactionSql): Promise<{ seq: number; idx: number }> {
  const [row] = await sql`select seq_scan, idx_scan from pg_stat_xact_user_tables
    where relname = 'reconciliation_changes'`;
  return { seq: Number(row.seq_scan), idx: Number(row.idx_scan) };
}

async function readExaminedRows(sql: Sql | TransactionSql, table: string): Promise<number> {
  const [row] = await sql`select seq_tup_read, idx_tup_fetch from pg_stat_xact_user_tables
    where relname = ${table}`;
  return Number(row.seq_tup_read) + Number(row.idx_tup_fetch);
}
