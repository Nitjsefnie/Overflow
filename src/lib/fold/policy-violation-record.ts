import type { TransactionClient } from "@/lib/db/types";
import type { FoldPolicyViolation } from "@/lib/fold/repository-fold";

/**
 * Records the fold's policy violations that are new for the repository, then
 * makes the fold's list the repository's stored set.
 *
 * A fold reports every violation that currently holds, so recording its whole
 * list would append the same rows on every run. Only a violation absent from
 * the stored set gains a `POLICY_VIOLATION` row, and replacing the set drops
 * the ones that vanished, so a violation that disappears and later reappears is
 * recorded again. Comparison is jsonb equality, which ignores key order, and a
 * violation listed twice in one fold is one member of the set.
 *
 * Runs inside the publication transaction: a run that fails after this point
 * rolls the recorded rows and the set back together.
 */
export async function recordNewPolicyViolations(
  sql: TransactionClient,
  repositoryId: string,
  runId: string,
  violations: FoldPolicyViolation[],
): Promise<void> {
  const current = sql.json(violations);
  // Inserted in the fold's order (its first occurrence of each violation), so
  // `recorded_seq` keeps the order the fold reported them in.
  await sql`
    insert into reconciliation_changes (
      reconciliation_run_id, pull_request_id, entity_kind, change_kind, before_state, after_state
    )
    select ${runId}, null, 'POLICY_VIOLATION', 'POLICY_VIOLATION', null, reported.violation
    from (
      select value as violation, min(position) as position
      from jsonb_array_elements(${current}::jsonb) with ordinality as listed(value, position)
      group by value
    ) as reported
    where not exists (
      select 1 from repository_policy_violations as stored
      where stored.repository_id = ${repositoryId} and stored.violation = reported.violation
    )
    order by reported.position
  `;
  await sql`
    delete from repository_policy_violations
    where repository_id = ${repositoryId}
      and not (violation = any (select value from jsonb_array_elements(${current}::jsonb)))
  `;
  await sql`
    insert into repository_policy_violations (repository_id, violation)
    select ${repositoryId}, value from jsonb_array_elements(${current}::jsonb)
    on conflict do nothing
  `;
}
