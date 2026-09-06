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

function storeOverPool(coordinationSql: SqlClient): PostgresFoldStore {
  return new PostgresFoldStore({} as unknown as SqlClient, undefined, coordinationSql);
}

describe("reconciliation coordination pool", () => {
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

  it("keeps an abandoned reservation's own failure from escaping unhandled", async () => {
    vi.useFakeTimers();
    try {
      const { coordinationSql, reservations } = exhaustedCoordinationPool();
      const coordinated = storeOverPool(coordinationSql)
        .withRepositoryReconciliation("repository-whose-reservation-fails", async () => undefined);
      const refusal = expect(coordinated).rejects.toThrow(coordinationFailure);
      await vi.advanceTimersByTimeAsync(lockWaitDeadlineMs);
      await refusal;

      // An unhandled rejection fails the whole vitest run, so a green suite is
      // the assertion: the abandoned reservation's failure was consumed.
      reservations[0].fail(new Error("coordination pool connection refused"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
