import { describe, expect, it, vi } from "vitest";
import { FailureLogger } from "@/lib/worker/failure-logger";

/**
 * Issue 661: the reconciliation worker logs one full error per failure, which
 * during an outage means one full stack trace every five-second poll. The
 * logger bounds that: the first failure of an outage prints in full, later
 * failures inside the quiet window are counted silently, one summary line
 * crosses the window, and success after a failure prints one recovery line.
 * Every case here runs on an injected clock, so no test waits on the window.
 */

const DRAIN_KEY = "reconciliation-drain";
const HEARTBEAT_KEY = "reconciliation-lease-heartbeat";

function testLogger(clockMs: { value: number }, error: (...args: unknown[]) => void): FailureLogger {
  return new FailureLogger({ now: () => clockMs.value, error });
}

describe("the failure logger's state machine", () => {
  it("logs the first failure of a key in full, as the unbounded sites did", () => {
    const error = vi.fn();
    const logger = testLogger({ value: 1_000 }, error);
    const failure = new Error("the queue store is unreachable");

    logger.failure(DRAIN_KEY, "Reconciliation worker could not drain the job queue", failure);

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "Reconciliation worker could not drain the job queue",
      failure,
    );
  });

  it("suppresses and counts failures inside the sixty-second quiet window", () => {
    const error = vi.fn();
    const clock = { value: 1_000 };
    const logger = testLogger(clock, error);
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    clock.value += 59_999;

    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    logger.failure(DRAIN_KEY, "drain failed", new Error("still down"));

    // Only the first failure printed; the rest of the outage is one number on
    // a later line, not a stack trace per poll.
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("emits one still-failing line after the window, carrying the key and the count", () => {
    const error = vi.fn();
    const clock = { value: 1_000 };
    const logger = testLogger(clock, error);
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    for (let index = 0; index < 11; index += 1) {
      clock.value += 5_000;
      logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    }
    clock.value += 5_000; // 60 s after the only emission so far.

    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[0]).toEqual(["drain failed", expect.any(Error)]);
    // Twelve failures have arrived since the detail: the eleven inside the
    // window plus this one, which crossed it.
    expect(error.mock.calls[1]).toEqual([
      "still failing: reconciliation-drain: 12 failures since last detail",
    ]);
  });

  it("restarts the window from each emission, so the count resets", () => {
    const error = vi.fn();
    const clock = { value: 0 };
    const logger = testLogger(clock, error);
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    clock.value += 60_000;
    logger.failure(DRAIN_KEY, "drain failed", new Error("down")); // summary: 1 since the detail

    // The next sixty seconds are a fresh cycle measured from the summary, not
    // from the detail: a failure at 119 999 ms is inside it and says nothing.
    clock.value += 59_999;
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));

    clock.value += 1;
    logger.failure(DRAIN_KEY, "drain failed", new Error("down")); // summary: 2 since the summary

    expect(error).toHaveBeenCalledTimes(3);
    expect(error.mock.calls[1]).toEqual([
      "still failing: reconciliation-drain: 1 failures since last detail",
    ]);
    expect(error.mock.calls[2]).toEqual([
      "still failing: reconciliation-drain: 2 failures since last detail",
    ]);
  });

  it("prints one recovery line on success after failures, with the count and the duration", () => {
    const error = vi.fn();
    const clock = { value: 0 };
    const logger = testLogger(clock, error);
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    clock.value += 10_000;
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    clock.value += 55_000;

    logger.success(DRAIN_KEY);

    expect(error).toHaveBeenCalledTimes(2);
    expect(error.mock.calls[1]).toEqual([
      "recovered: reconciliation-drain after 2 failures over 65 s",
    ]);
  });

  it("prints no recovery line when no failure preceded the success", () => {
    const error = vi.fn();
    const logger = testLogger({ value: 0 }, error);

    logger.success(DRAIN_KEY);
    logger.success(HEARTBEAT_KEY);

    expect(error).not.toHaveBeenCalled();
  });

  it("keeps keys independent", () => {
    const error = vi.fn();
    const clock = { value: 0 };
    const logger = testLogger(clock, error);
    const drainFailure = new Error("drain");
    const heartbeatFailure = new Error("heartbeat");

    logger.failure(DRAIN_KEY, "drain failed", drainFailure);
    // The same instant on another key is that key's first failure, not a
    // suppressed repeat of the drain's.
    logger.failure(HEARTBEAT_KEY, "heartbeat failed", heartbeatFailure);
    expect(error.mock.calls[1]).toEqual(["heartbeat failed", heartbeatFailure]);

    // The drain's window does not suppress the heartbeat's next failure.
    clock.value += 1_000;
    logger.failure(HEARTBEAT_KEY, "heartbeat failed", new Error("heartbeat"));
    expect(error).toHaveBeenCalledTimes(2);

    // Recovering the heartbeat says nothing about the drain, whose outage runs on.
    logger.success(HEARTBEAT_KEY);
    expect(error.mock.calls[2]).toEqual([
      "recovered: reconciliation-lease-heartbeat after 2 failures over 1 s",
    ]);
    logger.success(DRAIN_KEY);
    expect(error.mock.calls[3]).toEqual([
      "recovered: reconciliation-drain after 1 failures over 1 s",
    ]);
  });

  it("counts a whole outage on the recovery line, across still-failing summaries", () => {
    const error = vi.fn();
    const clock = { value: 0 };
    const logger = testLogger(clock, error);
    logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
    for (let cycle = 0; cycle < 3; cycle += 1) {
      for (let index = 0; index < 12; index += 1) {
        clock.value += 5_000;
        logger.failure(DRAIN_KEY, "drain failed", new Error("down"));
      }
    }
    // The first failure plus thirty-six more over three minutes; two summary
    // lines crossed their windows along the way, and the recovery line carries
    // the whole outage, not just the last cycle.

    logger.success(DRAIN_KEY);

    // Twelve failures per five-second step lands each cycle's twelfth failure
    // exactly on its window boundary, so every cycle prints one summary.
    expect(error).toHaveBeenCalledTimes(5);
    expect(error.mock.calls[1]).toEqual([
      "still failing: reconciliation-drain: 12 failures since last detail",
    ]);
    expect(error.mock.calls[2]).toEqual([
      "still failing: reconciliation-drain: 12 failures since last detail",
    ]);
    expect(error.mock.calls[3]).toEqual([
      "still failing: reconciliation-drain: 12 failures since last detail",
    ]);
    expect(error.mock.calls[4]).toEqual([
      "recovered: reconciliation-drain after 37 failures over 180 s",
    ]);
  });
});
