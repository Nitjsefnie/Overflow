import { pathToFileURL } from "node:url";
import { closeSql, getSql } from "../src/lib/db/client.ts";
import type { Sql } from "postgres";

/**
 * Prunes the no-op CHANGE rows the issue 659 bug recorded (issue 665).
 *
 * Between the introduction of provenance recording and the issue 659 fix,
 * every reconciliation pass recorded one CHANGE row for every settlement and
 * self-work calibration it folded: the materializer compared the stored state
 * with the fold as JSON, and the two rendered the same timestamps in two
 * notations ("...:28.000Z" from the database side, GitHub's "...:28Z" from the
 * fold). The comparison never matched, so an unchanged entity was rewritten
 * and gained a CHANGE row whose before and after states differ only in that
 * notation. Such a row carries no information: nothing about the entity
 * changed, and nothing in the application reads the table.
 *
 * A row is prunable when it is a CHANGE row for a SETTLEMENT or a
 * SELF_WORK_CALIBRATION whose states share one key set and differ only where
 * a timestamp field holds the same instant in two notations; the predicate
 * below is the single definition, used by both the count and the delete.
 *
 * Run against the server DATABASE_URL points at, never without; the variable
 * is read from the environment, so load it first, for example with
 * `set -a; . <env file>; set +a`, or let node load it from a .env file with
 * the --env-file-if-exists=.env flag the usage text shows. Run it only after
 * the issue 659 fix is deployed: while the bug is live, every pass records
 * new no-op rows and the counted and deleted totals can diverge. Deleting
 * rows does not return the space to the filesystem; afterwards run
 * `VACUUM FULL reconciliation_changes` (which takes an exclusive lock) when
 * the space matters.
 *
 * Each --execute batch reads the next page of primary keys in id order and
 * deletes the matching ids in the same single statement, so each batch is
 * atomic. Deleting in uuid order dirties heap pages in random order: expect
 * on the order of three times the table's size in WAL over a full run,
 * which matters only where WAL is retained — archived, or kept for a
 * replication slot or replica.
 *
 * Every batch commits on its own. On a failure, the batch lines already
 * printed stand (the last line's "total" is what was committed; a killed
 * process can leave its in-flight batch to commit server-side, so the
 * printed total can undercount by one), the cause is on the failure line,
 * and rerunning the same command is safe and idempotent — a dry run
 * afterwards is the source of truth, and reports "matched":0 once the
 * prunable rows are gone.
 *
 *   node --env-file-if-exists=.env --experimental-transform-types --import ./scripts/register-path-aliases.ts \
 *     scripts/prune-noop-reconciliation-changes.ts              # dry run: counts only
 *   node --env-file-if-exists=.env --experimental-transform-types --import ./scripts/register-path-aliases.ts \
 *     scripts/prune-noop-reconciliation-changes.ts --execute             # delete in batches
 *   ... --execute --batch-size 2000   # rows per page (default 10000)
 *
 * With no arguments it prints one count line per entity kind the predicate
 * matched, then a summary, and deletes nothing — so a loosened predicate is
 * visible in the dry run instead of silently widening the delete. With
 * --execute it deletes prunable rows page by page, printing the scanned and
 * deleted counts per page, until a page is empty. --help prints usage; any
 * other argument is a usage error.
 */

export interface PruneNoopReconciliationChangesDependencies {
  sql?: Sql;
  write?: (line: string) => void;
}

const DEFAULT_BATCH_SIZE = 10_000;
const PRUNED_ENTITY_KINDS = ["SETTLEMENT", "SELF_WORK_CALIBRATION"] as const;

interface ParsedArguments {
  execute: boolean;
  batchSize: number | undefined;
}

export async function runPruneNoopReconciliationChangesCli(
  argumentsList: readonly string[] = process.argv.slice(2),
  dependencies?: PruneNoopReconciliationChangesDependencies,
): Promise<number> {
  const write = dependencies?.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  if (argumentsList.length === 1 && argumentsList[0] === "--help") {
    write(usage());
    return 0;
  }
  const parsed = parseArguments(argumentsList);
  if (parsed === undefined) {
    write(usage());
    return 2;
  }
  try {
    const client = dependencies?.sql ?? getSql();
    if (parsed.execute) {
      await executePrune(client, write, parsed.batchSize ?? DEFAULT_BATCH_SIZE);
    } else {
      await reportCounts(client, write);
    }
    return 0;
  } catch (error) {
    write(JSON.stringify({ failure: "PRUNE_FAILED", reason: failureReason(error) }));
    return 1;
  }
}

function failureReason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const theMessage = error instanceof Error ? error.message : String(error);
  return typeof code === "string" && code.length > 0 ? `${code}: ${theMessage}` : theMessage;
}

function parseArguments(argumentsList: readonly string[]): ParsedArguments | undefined {
  let execute = false;
  let batchSize: number | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--execute" && !execute) {
      execute = true;
      continue;
    }
    if (argument === "--batch-size" && batchSize === undefined && index + 1 < argumentsList.length) {
      const raw = argumentsList[index + 1]!;
      const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isSafeInteger(value) || value <= 0) {
        return undefined;
      }
      batchSize = value;
      index += 1;
      continue;
    }
    return undefined;
  }
  if (!execute && batchSize !== undefined) {
    return undefined;
  }
  return { execute, batchSize };
}

function usage(): string {
  return [
    "Prunes the no-op reconciliation CHANGE rows recorded by the issue 659 bug (issue 665).",
    "",
    "Usage, from the repository root (DATABASE_URL in the environment or .env):",
    "  node --env-file-if-exists=.env --experimental-transform-types \\",
    "    --import ./scripts/register-path-aliases.ts scripts/prune-noop-reconciliation-changes.ts",
    "    [--execute] [--batch-size N]",
    "",
    "With no options: dry run, counts only. --help alone shows this usage.",
  ].join("\n");
}

async function reportCounts(client: Sql, write: (line: string) => void): Promise<void> {
  const grouped = await client<{ entity_kind: string; count: number }[]>`
    select entity_kind::text as entity_kind, count(*)::int as count
    from reconciliation_changes
    where ${noopChangePredicate(client)}
    group by entity_kind
  `;
  const counts = new Map(grouped.map((row) => [row.entity_kind, row.count]));
  // The two pruned kinds first, then anything else the predicate matched, so
  // a loosened predicate shows up in the dry run instead of silently
  // widening what --execute would delete.
  const kinds = [
    ...PRUNED_ENTITY_KINDS,
    ...[...counts.keys()]
      .filter((kind) => !(PRUNED_ENTITY_KINDS as readonly string[]).includes(kind))
      .sort(),
  ];
  let matched = 0;
  for (const kind of kinds) {
    const count = counts.get(kind) ?? 0;
    matched += count;
    write(JSON.stringify({ entityKind: kind, count }));
  }
  write(JSON.stringify({ executed: false, deleted: 0, matched }));
}

async function executePrune(client: Sql, write: (line: string) => void, batchSize: number): Promise<void> {
  const matched = await countMatching(client);
  const startOfTable = "00000000-0000-0000-0000-000000000000";
  let cursor = startOfTable;
  let deletedTotal = 0;
  let batch = 0;
  while (true) {
    batch += 1;
    // One statement, one snapshot: the page of ids after the cursor is read
    // from the table and the matching ones among them are deleted in the same
    // statement, so there is no select-then-delete gap. Keyset pagination on
    // the primary key evaluates each row exactly once; the shared predicate
    // decides what counts as no-op and what gets deleted.
    const [row] = await client<{ scanned: number; deleted: number; last_id: string | null }[]>`
      with page as (
        select id, (${noopChangePredicate(client)}) as matches
        from reconciliation_changes
        where id > ${cursor}
        order by id
        limit ${batchSize}
      ), pruned as (
        delete from reconciliation_changes
        where id in (select id from page where matches)
        returning id
      )
      select (select count(*) from page)::int as scanned,
             (select count(*) from pruned)::int as deleted,
             -- uuid has no max aggregate. max(id::text) is the page's last
             -- id because canonical uuids differ from their text form only
             -- by hyphens at four fixed positions and lowercase hex, which
             -- every collation orders before letters, so text order equals
             -- uuid order whatever the database collation.
             (select max(id::text) from page) as last_id
    `;
    const scanned = row?.scanned ?? 0;
    const deleted = row?.deleted ?? 0;
    const lastId = row?.last_id ?? null;
    if (lastId !== null) {
      cursor = lastId;
    }
    deletedTotal += deleted;
    write(JSON.stringify({ batch, scanned, deleted, total: deletedTotal }));
    if (scanned === 0) {
      break;
    }
  }
  write(JSON.stringify({ executed: true, deleted: deletedTotal, matched }));
}

async function countMatching(client: Sql): Promise<number> {
  const [row] = await client<{ count: number }[]>`
    select count(*)::int as count from reconciliation_changes where ${noopChangePredicate(client)}
  `;
  return row?.count ?? 0;
}

/**
 * The single definition of a prunable no-op row, used by both the count and
 * the delete. A pair of values for one key counts as a difference unless both
 * sides are timestamp notations of the same instant: timestamp-shaped strings
 * on a known timestamp key compare as instants, everything else compares as
 * JSON, so ".000Z" vs "Z" is no difference while one second, one point, one
 * label, or one missing key is. The object-state guards live in the CASE
 * condition, not an AND limb, so jsonb_each can never see a non-object
 * regardless of the planner's evaluation order.
 */
function noopChangePredicate(client: Sql) {
  return client`
    change_kind = 'CHANGE'
    and entity_kind in ('SETTLEMENT', 'SELF_WORK_CALIBRATION')
    and case
      when jsonb_typeof(before_state) = 'object' and jsonb_typeof(after_state) = 'object'
      then not exists (
        select 1
        from jsonb_each(before_state) as before_pair(key, value)
        full outer join jsonb_each(after_state) as after_pair(key, value)
          on before_pair.key = after_pair.key
        where before_pair.key is null
          or after_pair.key is null
          or (
            case
              when before_pair.key in (
                'settledLabelAppliedAt', 'settledRationaleCommentedAt',
                'actualLabelAppliedAt', 'rationaleCommentedAt', 'mergedAt'
              )
              and jsonb_typeof(before_pair.value) = 'string'
              and jsonb_typeof(after_pair.value) = 'string'
              and (before_pair.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
              and (after_pair.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
              and pg_input_is_valid(before_pair.value #>> '{}', 'timestamptz')
              and pg_input_is_valid(after_pair.value #>> '{}', 'timestamptz')
              then (before_pair.value #>> '{}')::timestamptz <> (after_pair.value #>> '{}')::timestamptz
              else before_pair.value is distinct from after_pair.value
            end
          )
      )
      else false
    end
  `;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runPruneNoopReconciliationChangesCli();
  } finally {
    try {
      await closeSql();
    } catch {
      process.stdout.write(`${JSON.stringify({ failure: "CLOSE_FAILED" })}\n`);
      process.exitCode = 1;
    }
  }
}
