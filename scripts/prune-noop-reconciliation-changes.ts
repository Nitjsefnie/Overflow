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
 * forms ("...:28.000Z" from the database side, GitHub's "...:28Z" from the
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
 * Run against the server DATABASE_URL points at, never without:
 *
 *   node --experimental-transform-types --import ./scripts/register-path-aliases.ts \
 *     scripts/prune-noop-reconciliation-changes.ts              # dry run: counts only
 *   node --experimental-transform-types --import ./scripts/register-path-aliases.ts \
 *     scripts/prune-noop-reconciliation-changes.ts --execute             # delete in batches
 *   ... --execute --batch-size 2000   # batch size (rows per statement; default 10000)
 *
 * With no arguments it prints one count line per pruned entity kind and a
 * summary, and deletes nothing. With --execute it selects prunable ids in
 * recorded order and deletes each batch in its own statement until one
 * deletes nothing. --help prints usage; any other argument is a usage error.
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
  if (argumentsList.includes("--help")) {
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
  } catch {
    write(JSON.stringify({ failure: "PRUNE_FAILED" }));
    return 1;
  }
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
      if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
        return undefined;
      }
      batchSize = Number(raw);
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
    "Usage:",
    "  scripts/prune-noop-reconciliation-changes.ts                       dry run: print counts only",
    "  scripts/prune-noop-reconciliation-changes.ts --execute             delete the rows in batches",
    "  scripts/prune-noop-reconciliation-changes.ts --execute --batch-size N   rows per batch (default 10000)",
    "  scripts/prune-noop-reconciliation-changes.ts --help                this usage",
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
  let matched = 0;
  for (const entityKind of PRUNED_ENTITY_KINDS) {
    const count = counts.get(entityKind) ?? 0;
    matched += count;
    write(JSON.stringify({ entityKind, count }));
  }
  write(JSON.stringify({ executed: false, deleted: 0, matched }));
}

async function executePrune(client: Sql, write: (line: string) => void, batchSize: number): Promise<void> {
  const matched = await countMatching(client);
  let deletedTotal = 0;
  let batch = 0;
  while (true) {
    batch += 1;
    const ids = await client<{ id: string }[]>`
      select id from reconciliation_changes
      where ${noopChangePredicate(client)}
      order by recorded_seq
      limit ${batchSize}
    `;
    if (ids.length > 0) {
      await client`
        delete from reconciliation_changes
        where id = any(${client.array(ids.map((row) => row.id))}::uuid[])
      `;
      deletedTotal += ids.length;
    }
    write(JSON.stringify({ batch, deleted: ids.length, total: deletedTotal }));
    if (ids.length === 0) {
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
 * label, or one missing key is.
 */
function noopChangePredicate(client: Sql) {
  return client`
    change_kind = 'CHANGE'
    and entity_kind in ('SETTLEMENT', 'SELF_WORK_CALIBRATION')
    and jsonb_typeof(before_state) = 'object'
    and jsonb_typeof(after_state) = 'object'
    and not exists (
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
            and (before_pair.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
            and (after_pair.value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
            and pg_input_is_valid(before_pair.value #>> '{}', 'timestamptz')
            and pg_input_is_valid(after_pair.value #>> '{}', 'timestamptz')
            then (before_pair.value #>> '{}')::timestamptz <> (after_pair.value #>> '{}')::timestamptz
            else before_pair.value is distinct from after_pair.value
          end
        )
    )
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
