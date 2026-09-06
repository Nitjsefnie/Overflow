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

interface CoordinationOptions {
  /** Statements the connection refuses, the way a revoked `EXECUTE` does. */
  denied?: readonly string[];
  /** What the targeted unlock resolves with when it is not denied. */
  unlockRows?: unknown[];
}

/**
 * A coordination client whose reserved connection grants the repository lock and then answers each
 * statement as the options say. Nothing here touches a database: what is under test is which
 * statements the store reaches for, in what order, whether it hands the connection back, and what
 * it reports having swallowed.
 */
function coordinationPool({ denied = [], unlockRows }: CoordinationOptions): {
  coordinationSql: SqlClient;
  record: ReclaimRecord;
} {
  const record: ReclaimRecord = { statements: [], releases: 0 };
  const run = (statement: string): Promise<unknown[]> => {
    record.statements.push(statement);
    if (denied.some((fragment) => statement.includes(fragment))) {
      return Promise.reject(new Error(`permission denied for ${statement}`));
    }
    if (unlockRows !== undefined && statement.includes(targetedUnlock)) {
      return Promise.resolve(unlockRows);
    }

    return Promise.resolve([{ acquired: true, released: true }]);
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

interface CoordinationOutcome {
  record: ReclaimRecord;
  rejection: string | undefined;
  workRan: boolean;
  /** Each `console.warn` call's arguments, untouched, so a reported cause can be inspected. */
  warnings: unknown[][];
}

/** Drives one reconciliation over the fake pool, capturing what it logged. */
async function reconcileOver(options: CoordinationOptions): Promise<CoordinationOutcome> {
  const { coordinationSql, record } = coordinationPool(options);
  const warnings: unknown[][] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args);
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

function reconcileWithDeniedUnlock(denied: readonly string[]): Promise<CoordinationOutcome> {
  return reconcileOver({ denied: [targetedUnlock, ...denied] });
}

/** The message of a captured warning, without its cause. */
function messageOf(warning: unknown[]): string {
  return String(warning[0]);
}

/** The `released` value a warning reported the targeted unlock as having come back with. */
function reportedReleaseValue(warning: unknown[]): unknown {
  return (warning[1] as { released?: unknown }).released;
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
    expect(warnings.every((warning) => messageOf(warning).includes(repositoryId))).toBe(true);
    expect(messageOf(warnings[0])).toContain("pg_advisory_unlock");
    expect(String((warnings[0][1] as Error).message)).toContain("permission denied");
    expect(messageOf(warnings[1])).toContain("pg_advisory_unlock_all");
    expect(messageOf(warnings[2])).toContain("DISCARD ALL");
    expect(messageOf(warnings[3])).toContain("without releasing it");
  });

  it("says nothing when the first reclaim stage answers", async () => {
    const { warnings } = await reconcileWithDeniedUnlock([]);

    // Only the targeted unlock failed; the connection was reclaimed and handed back intact.
    expect(warnings).toHaveLength(1);
    expect(messageOf(warnings[0])).toContain("pg_advisory_unlock");
  });

  // An unlock that answers is not an unlock that released anything. These three say so without
  // ever throwing, which is the path a rejection cannot stand in for.
  describe("an unlock that resolves without confirming", () => {
    it("treats a plain false as unreleased, reclaims, and reports the value", async () => {
      const { record, rejection, warnings } = await reconcileOver({ unlockRows: [{ released: false }] });

      expect(rejection).toBe(coordinationFailure);
      expect(record.statements).toEqual([tryLockStatement, targetedUnlockStatement, unlockAllStatement]);
      expect(record.releases).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(messageOf(warnings[0])).toContain("pg_advisory_unlock");
      expect(reportedReleaseValue(warnings[0])).toBe(false);
    });

    it("treats no row at all as unreleased, reclaims, and reports the absence", async () => {
      const { record, rejection, warnings } = await reconcileOver({ unlockRows: [] });

      expect(rejection).toBe(coordinationFailure);
      expect(record.statements).toEqual([tryLockStatement, targetedUnlockStatement, unlockAllStatement]);
      expect(record.releases).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(messageOf(warnings[0])).toContain("pg_advisory_unlock");
      expect(reportedReleaseValue(warnings[0])).toBeUndefined();
    });

    // 1 is truthy and loosely equal to true, so anything looser than `=== true` accepts it.
    it("treats a value that is neither true nor false as unreleased, reclaims, and reports it", async () => {
      const { record, rejection, warnings } = await reconcileOver({ unlockRows: [{ released: 1 }] });

      expect(rejection).toBe(coordinationFailure);
      expect(record.statements).toEqual([tryLockStatement, targetedUnlockStatement, unlockAllStatement]);
      expect(record.releases).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(messageOf(warnings[0])).toContain("pg_advisory_unlock");
      expect(reportedReleaseValue(warnings[0])).toBe(1);
    });

    it("asks for nothing beyond the unlock when it does confirm", async () => {
      const { record, rejection, warnings } = await reconcileOver({ unlockRows: [{ released: true }] });

      expect(rejection).toBeUndefined();
      expect(record.statements).toEqual([tryLockStatement, targetedUnlockStatement]);
      expect(record.releases).toBe(1);
      expect(warnings).toEqual([]);
    });
  });
});
