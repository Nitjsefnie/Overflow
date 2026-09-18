import type { Sql } from "postgres";

/**
 * The reconciliation advisory-lock probe, relocated from schema.test.ts so
 * that file stays under its recorded module-size ceiling (the check offers
 * exactly two remedies: shrink, or relocate into a new module). Both
 * operations scope to the current database on purpose: pg_locks is
 * cluster-wide, and on the shared server — one postgres per run (issue 626)
 * — touching another suite's advisory waiters would break that suite's run.
 */

/**
 * How many transactions are waiting on an ungranted advisory lock in THIS
 * database, as seen through the observer connection passed in.
 */
export async function ungrantedAdvisoryWaiterCount(observer: Sql): Promise<number> {
  const [locks] = await observer<{ waiting: number }[]>`
    select count(*)::integer as waiting
    from pg_locks
    where locktype = 'advisory' and granted = false
      and database = (select oid from pg_database where datname = current_database())
  `;
  return locks!.waiting;
}

/**
 * Cancels every backend waiting on an ungranted advisory lock in THIS
 * database — the sweep the probe's finally runs once the assertion has
 * settled, so a stranded waiter cannot outlive the suite.
 */
export async function cancelUngrantedAdvisoryBackends(observer: Sql): Promise<void> {
  await observer`
    select pg_cancel_backend(pid)
    from pg_locks
    where locktype = 'advisory'
      and granted = false
      and pid <> pg_backend_pid()
      and database = (select oid from pg_database where datname = current_database())
  `;
}
