import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/types";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";

const coordinationFailure = "Unable to coordinate repository reconciliation.";
const lockWaitDeadlineMs = 60_000;
const realTimeEscapeMs = 5_000;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/**
 * Fake timers fake vitest's own test deadline along with the code's, so a
 * refusal that never arrives hangs the run for as long as it is left running
 * rather than failing it. Timers captured before the fakes were installed still
 * run on the wall clock, so bounding the wait on one turns a lost deadline into
 * a named failure. The bound is an escape hatch, not a speed assertion: the
 * awaited work needs no wall-clock time at all once the faked clock is advanced.
 */
async function awaitWithRealTimeBound<T>(pending: Promise<T>, expectation: string): Promise<T> {
  let escape: ReturnType<typeof realSetTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        escape = realSetTimeout(
          () => reject(new Error(`${expectation} within ${realTimeEscapeMs}ms of real time.`)),
          realTimeEscapeMs,
        );
      }),
    ]);
  } finally {
    if (escape !== undefined) {
      realClearTimeout(escape);
    }
  }
}

type PendingReservation = {
  arrive(connection: { release(): void }): void;
  fail(error: Error): void;
};

/**
 * A coordination client whose pool never hands anything back on its own, so
 * every reservation stays pending until the test settles it.
 */
function exhaustedCoordinationPool(): {
  coordinationSql: SqlClient;
  reservations: PendingReservation[];
} {
  const reservations: PendingReservation[] = [];
  const coordinationSql = {
    reserve: () => new Promise((resolve, reject) => {
      reservations.push({ arrive: resolve, fail: reject });
    }),
  } as unknown as SqlClient;
  return { coordinationSql, reservations };
}

/**
 * A coordination client that always hands back a connection whose advisory
 * lock is refused, so every attempt has to be retried.
 */
function lockRefusingCoordinationPool(): {
  coordinationSql: SqlClient;
  lockAttempts: string[];
  releases: string[];
} {
  const lockAttempts: string[] = [];
  const releases: string[] = [];
  const connection = (() => {
    lockAttempts.push("try-lock");
    return Promise.resolve([{ acquired: false }]);
  }) as unknown as Awaited<ReturnType<SqlClient["reserve"]>>;
  connection.release = () => { releases.push("released"); };
  const coordinationSql = {
    reserve: () => Promise.resolve(connection),
  } as unknown as SqlClient;
  return { coordinationSql, lockAttempts, releases };
}

function storeOverPool(coordinationSql: SqlClient): PostgresFoldStore {
  return new PostgresFoldStore({} as unknown as SqlClient, undefined, coordinationSql);
}

describe("reconciliation coordination pool", () => {
  it("constructs over an injected client without a configured DATABASE_URL", () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // A caller that hands the store its own client asks for no process-wide
      // one, so nothing about coordination may be resolved at construction.
      expect(() => new PostgresFoldStore({} as unknown as SqlClient, "token-key")).not.toThrow();
    } finally {
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });

  it("carries the reservation's rejection as the cause of its coordination failure", async () => {
    const rejection = new Error("connect ECONNREFUSED 127.0.0.1:5432");
    const coordinationSql = {
      reserve: () => Promise.reject(rejection),
    } as unknown as SqlClient;

    const failure = await storeOverPool(coordinationSql)
      .withRepositoryReconciliation("repository-whose-reservation-rejects", async () => undefined)
      .then(() => { throw new Error("expected withRepositoryReconciliation to reject"); },
        (error: unknown) => error as Error);

    expect(failure.message).toBe(coordinationFailure);
    expect(failure.cause).toBe(rejection);
  });

  it("names the reserve timeout as the cause of its deadline refusal", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql } = exhaustedCoordinationPool();
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-whose-reservation-times-out", async () => undefined);
      const failurePromise = coordinated.then(
        () => { throw new Error("expected withRepositoryReconciliation to reject"); },
        (error: unknown) => error as Error,
      );

      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);

      const failure = await awaitWithRealTimeBound(
        failurePromise,
        "The wait for a coordination connection did not give up",
      );
      expect(failure.message).toBe(coordinationFailure);
      expect(failure.cause).toBeInstanceOf(Error);
      expect((failure.cause as Error).message).not.toBe(coordinationFailure);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries a failed lock statement as the cause of its coordination failure", async () => {
    const statementFailure = new Error("terminating connection due to administrator command");
    const connection = Object.assign(
      () => Promise.reject(statementFailure),
      { release: () => {} },
    ) as unknown as Awaited<ReturnType<SqlClient["reserve"]>>;
    const coordinationSql = {
      reserve: () => Promise.resolve(connection),
    } as unknown as SqlClient;

    const failure = await storeOverPool(coordinationSql)
      .withRepositoryReconciliation("repository-whose-lock-statement-fails", async () => undefined)
      .then(() => { throw new Error("expected withRepositoryReconciliation to reject"); },
        (error: unknown) => error as Error);

    expect(failure.message).toBe(coordinationFailure);
    expect(failure.cause).toBe(statementFailure);
  });

  it("stops waiting for a coordination connection once the lock-wait deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql, reservations } = exhaustedCoordinationPool();
      let workStarted = false;
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-waiting-for-a-connection", async () => {
          workStarted = true;
        });
      const refusal = expect(coordinated).rejects.toThrow(coordinationFailure);

      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);

      await awaitWithRealTimeBound(
        refusal,
        "The wait for a coordination connection did not give up",
      );
      expect(workStarted).toBe(false);
      expect(reservations).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying a lock it cannot take once the lock-wait deadline passes", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql, lockAttempts, releases } = lockRefusingCoordinationPool();
      let workStarted = false;
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-locked-by-someone-else", async () => {
          workStarted = true;
        });
      const refusal = expect(coordinated).rejects.toThrow(coordinationFailure);

      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);

      await awaitWithRealTimeBound(
        refusal,
        "The retrying of a refused lock did not give up",
      );
      expect(workStarted).toBe(false);
      expect(lockAttempts.length).toBeGreaterThan(1);
      expect(releases).toHaveLength(lockAttempts.length);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a coordination connection that arrives after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql, reservations } = exhaustedCoordinationPool();
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-abandoning-its-reservation", async () => undefined);
      const refusal = expect(coordinated).rejects.toThrow(coordinationFailure);
      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);
      await refusal;

      const releases: string[] = [];
      reservations[0].arrive({ release: () => releases.push("released") });
      await vi.advanceTimersByTimeAsync(0);

      expect(releases).toEqual(["released"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a failing release of an abandoned reservation from escaping unhandled", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql, reservations } = exhaustedCoordinationPool();
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-whose-release-fails", async () => undefined);
      const refusal = expect(coordinated).rejects.toThrow(coordinationFailure);
      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);
      await refusal;

      // Releasing hands the connection back to a pool that may dispatch a queued
      // query synchronously, so the release itself can throw. The recorded
      // attempt proves the abandoned reservation was still released; an
      // unhandled rejection fails the whole vitest run, so a clean run is what
      // proves that throw did not escape.
      const releaseAttempts: string[] = [];
      reservations[0].arrive({
        release: () => {
          releaseAttempts.push("release-attempted");
          throw new Error("coordination connection release failed");
        },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(releaseAttempts).toEqual(["release-attempted"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
