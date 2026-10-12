import { describe, expect, it, vi } from "vitest";
import { DrainSummaryLogger, DRAIN_SUMMARY_INTERVAL_MS } from "@/lib/logging/drain-summary-logger";

describe("drain summary logging", () => {
  it("suppresses deferred-only and idle-only passes inside the interval", () => {
    const info = vi.fn();
    let now = 100;
    const logger = new DrainSummaryLogger({ now: () => now, info });
    logger.record(["DEFERRED", "DEFERRED"]);
    now += 899_999;
    logger.record(["IDLE"]);
    expect(info).not.toHaveBeenCalled();
  });

  it.each(["FAILED", "RECONCILED", "RETRY_SCHEDULED", "BUDGET_HELD", "FUTURE_OUTCOME"])(
    "immediately logs %s with all carried counts and clears them once", (outcome) => {
      const info = vi.fn();
      const logger = new DrainSummaryLogger({ now: () => 0, info });
      logger.record(["DEFERRED", "IDLE"]);
      logger.record([outcome, outcome, "DEFERRED"]);
      expect(info.mock.calls).toEqual([
        ["Reconciliation drain", { DEFERRED: 2, IDLE: 1, [outcome]: 2 }],
      ]);
      logger.record(["FAILED"]);
      expect(info.mock.calls).toEqual([
        ["Reconciliation drain", { DEFERRED: 2, IDLE: 1, [outcome]: 2 }],
        ["Reconciliation drain", { FAILED: 1 }],
      ]);
    },
  );

  it.each([900_000, 900_001])("aggregates pending counts at the first pass at %i ms", (elapsed) => {
    const info = vi.fn();
    let now = 10_000;
    const logger = new DrainSummaryLogger({ now: () => now, info });
    logger.record(["DEFERRED"]);
    now += 899_999;
    logger.record(["DEFERRED", "IDLE"]);
    expect(info).not.toHaveBeenCalled();
    now = 10_000 + elapsed;
    logger.record(["DEFERRED", "IDLE", "IDLE"]);
    expect(info.mock.calls).toEqual([
      ["Reconciliation drain", { DEFERRED: 3, IDLE: 3 }],
    ]);
    logger.record(["DEFERRED"]);
    expect(info).toHaveBeenCalledTimes(1);
    now += DRAIN_SUMMARY_INTERVAL_MS;
    logger.record([]);
    expect(info.mock.calls).toEqual([
      ["Reconciliation drain", { DEFERRED: 3, IDLE: 3 }],
      ["Reconciliation drain", { DEFERRED: 1 }],
    ]);
  });

  it("flushes pending counts on an empty pass and never emits empty counts", () => {
    const info = vi.fn();
    let now = 0;
    const logger = new DrainSummaryLogger({ now: () => now, info });
    logger.record([]);
    now = 900_000;
    logger.record([]);
    expect(info).not.toHaveBeenCalled();
    logger.record(["DEFERRED"]);
    expect(info.mock.calls).toEqual([["Reconciliation drain", { DEFERRED: 1 }]]);
    now += 1;
    logger.record(["IDLE"]);
    expect(info).toHaveBeenCalledTimes(1);
    now += 900_000;
    logger.record([]);
    expect(info.mock.calls).toEqual([
      ["Reconciliation drain", { DEFERRED: 1 }],
      ["Reconciliation drain", { IDLE: 1 }],
    ]);
    now += 900_000;
    logger.record([]);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("starts the quiet interval again from a state-changing emission", () => {
    const info = vi.fn();
    let now = 0;
    const logger = new DrainSummaryLogger({ now: () => now, info });
    logger.record(["DEFERRED"]);
    now = 500_000;
    logger.record(["RECONCILED"]);
    now = 900_000;
    logger.record(["DEFERRED"]);
    now = 1_399_999;
    logger.record(["IDLE"]);
    expect(info.mock.calls).toEqual([
      ["Reconciliation drain", { DEFERRED: 1, RECONCILED: 1 }],
    ]);
    now += 1;
    logger.record([]);
    expect(info.mock.calls).toEqual([
      ["Reconciliation drain", { DEFERRED: 1, RECONCILED: 1 }],
      ["Reconciliation drain", { DEFERRED: 1, IDLE: 1 }],
    ]);
  });
});
