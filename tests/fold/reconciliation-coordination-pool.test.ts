import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db/types";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";

const coordinationFailure = "Unable to coordinate repository reconciliation.";
const lockWaitDeadlineMs = 60_000;

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

      await refusal;
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

      await refusal;
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

  it("keeps a reservation that fails after the deadline from escaping unhandled", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql, reservations } = exhaustedCoordinationPool();
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-whose-reservation-fails", async () => undefined);
      const refusal = expect(coordinated).rejects.toThrow(coordinationFailure);
      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);
      await refusal;

      // An unhandled rejection fails the whole vitest run, so a clean run is the
      // assertion: the abandoned reservation's failure was consumed.
      reservations[0].fail(new Error("coordination pool connection refused"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
