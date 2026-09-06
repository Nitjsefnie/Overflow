import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/types";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";

const coordinationFailure = "Unable to coordinate repository reconciliation.";
const repositoryId = "repository-whose-unlock-fails";

const tryLockStatement = "select pg_try_advisory_lock( hashtextextended(?, ?) ) as acquired";
const targetedUnlockStatement = "select pg_advisory_unlock( hashtextextended(?, ?) ) as released";
const unlockAllStatement = "select pg_advisory_unlock_all()";
const discardAllStatement = "discard all";
const terminateStatement = "select pg_terminate_backend(pg_backend_pid())";

/** Matches the targeted unlock without matching `pg_advisory_unlock_all()`. */
const targetedUnlock = "pg_advisory_unlock(";
const unlockAll = "pg_advisory_unlock_all";
const discardAll = "discard all";
const terminate = "pg_terminate_backend";

interface ReclaimRecord {
  /** Every statement the store issued on the reserved connection, in order. */
  statements: string[];
  releases: number;
}

/**
 * A coordination client whose reserved connection grants the repository lock and then refuses
 * every statement matching one of `denied`, the way a revoked `EXECUTE` does. Nothing here touches
 * a database: what is under test is which statements the store reaches for, in what order, and
 * whether it hands the connection back.
 */
function coordinationPoolDenying(denied: readonly string[]): {
  coordinationSql: SqlClient;
  record: ReclaimRecord;
} {
  const record: ReclaimRecord = { statements: [], releases: 0 };
  const run = (statement: string): Promise<unknown[]> => {
    record.statements.push(statement);

    return denied.some((fragment) => statement.includes(fragment))
      ? Promise.reject(new Error(`permission denied for ${statement}`))
      : Promise.resolve([{ acquired: true, released: true }]);
  };
  const connection = ((strings: TemplateStringsArray) => (
    run(collapse(Array.from(strings)))
  )) as unknown as Awaited<ReturnType<SqlClient["reserve"]>>;
  connection.unsafe = ((statement: string) => run(collapse([statement]))) as typeof connection.unsafe;
  connection.release = () => { record.releases += 1; };

  return { coordinationSql: { reserve: () => Promise.resolve(connection) } as unknown as SqlClient, record };
}

function collapse(fragments: readonly string[]): string {
  return fragments.join("?").replace(/\s+/gu, " ").trim();
}

/** Drives one reconciliation whose targeted unlock is always denied, capturing what was logged. */
async function reconcileWithDeniedUnlock(denied: readonly string[]): Promise<{
  record: ReclaimRecord;
  rejection: string | undefined;
  workRan: boolean;
  warnings: string[];
}> {
  const { coordinationSql, record } = coordinationPoolDenying([targetedUnlock, ...denied]);
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  });
  let workRan = false;
  let rejection: string | undefined;
  try {
    const store = new PostgresFoldStore({} as unknown as SqlClient, undefined, coordinationSql);
    await store.withRepositoryReconciliation(repositoryId, async () => {
      workRan = true;
      return "reconciled";
    });
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  } finally {
    warn.mockRestore();
  }

  return { record, rejection, workRan, warnings };
}

describe("reclaiming a coordination connection whose unlock did not confirm", () => {
  it("stops at pg_advisory_unlock_all() and hands the connection back", async () => {
    const { record, rejection, workRan } = await reconcileWithDeniedUnlock([]);

    expect(workRan).toBe(true);
    expect(rejection).toBe(coordinationFailure);
    expect(record.statements).toEqual([tryLockStatement, targetedUnlockStatement, unlockAllStatement]);
    expect(record.releases).toBe(1);
  });

  it("falls through to DISCARD ALL, which no revoked grant can reach, and still hands it back", async () => {
    const { record, rejection, workRan } = await reconcileWithDeniedUnlock([unlockAll]);

    expect(workRan).toBe(true);
    expect(rejection).toBe(coordinationFailure);
    expect(record.statements).toEqual([
      tryLockStatement,
      targetedUnlockStatement,
      unlockAllStatement,
      discardAllStatement,
    ]);
    expect(record.releases).toBe(1);
  });

  it("ends the session when every earlier stage is denied, and never releases the connection", async () => {
    const { record, rejection, workRan } = await reconcileWithDeniedUnlock([unlockAll, discardAll, terminate]);

    expect(workRan).toBe(true);
    expect(rejection).toBe(coordinationFailure);
    expect(record.statements).toEqual([
      tryLockStatement,
      targetedUnlockStatement,
      unlockAllStatement,
      discardAllStatement,
      terminateStatement,
    ]);
    // A session that may still hold the lock must never serve another caller.
    expect(record.releases).toBe(0);
  });

  it("logs every swallowed coordination failure against the repository", async () => {
    const { warnings } = await reconcileWithDeniedUnlock([unlockAll, discardAll, terminate]);

    expect(warnings).toHaveLength(4);
    expect(warnings.every((warning) => warning.includes(repositoryId))).toBe(true);
    expect(warnings[0]).toContain("pg_advisory_unlock");
    expect(warnings[0]).toContain("permission denied");
    expect(warnings[1]).toContain("pg_advisory_unlock_all");
    expect(warnings[2]).toContain("DISCARD ALL");
    expect(warnings[3]).toContain("without releasing it");
  });

  it("says nothing when the first reclaim stage answers", async () => {
    const { warnings } = await reconcileWithDeniedUnlock([]);

    // Only the targeted unlock failed; the connection was reclaimed and handed back intact.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pg_advisory_unlock");
  });
});
