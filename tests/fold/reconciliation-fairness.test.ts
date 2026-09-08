import { describe, expect, it } from "vitest";
import { assessReconciliationFairness, decayReconciliationUsage } from "@/lib/fold/reconciliation-fairness";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";

const now = new Date("2026-09-08T10:00:00Z");
const budget: GitHubGraphqlBudgetAssessment = { state: "AVAILABLE", reserve: 500,
  reading: { remaining: 6500, limit: 10000, cost: 7,
    resetAt: new Date("2026-09-08T11:00:00Z"), observedAt: now } };
const assess = (debt: number, at = now) => assessReconciliationFairness({
  usage: { debt, measuredAt: now, ratePerSecond: 1 }, budget, activeRepositoryCount: 2, now: at,
});

describe("repository fairness", () => {
  it("admits the 25-point allowance and holds excess debt without ranking peers", () => {
    expect(assess(25).state).toBe("ADMITTED");
    expect(assess(50).holdUntil).toEqual(new Date("2026-09-08T10:00:30Z"));
    expect(assess(0).state).toBe("ADMITTED");
    expect(assess(1).state).toBe("ADMITTED");
    expect(assess(26).holdUntil).toEqual(new Date("2026-09-08T10:00:05Z"));
  });

  it("decays with the old rate and never rewinds a persisted timestamp", () => {
    const usage = { debt: 50, measuredAt: now, ratePerSecond: 1 };
    expect(decayReconciliationUsage(usage, new Date("2026-09-08T10:00:30Z")))
      .toEqual({ debt: 20, measuredAt: new Date("2026-09-08T10:00:30Z"), ratePerSecond: 1 });
    expect(decayReconciliationUsage(usage, new Date("2026-09-08T09:59:30Z"))).toEqual(usage);
    expect(assess(50, new Date("2026-09-08T10:00:30Z")).state).toBe("ADMITTED");
  });

  it("fails open at reset and rechecks positive zero-rate debt", () => {
    const usage = { debt: 50, measuredAt: now, ratePerSecond: 0 };
    const zero = { ...budget, reading: { ...budget.reading!, remaining: 500 } };
    expect(assessReconciliationFairness({ usage, budget: zero, activeRepositoryCount: 2, now }).holdUntil)
      .toEqual(new Date("2026-09-08T10:00:30Z"));
    expect(assessReconciliationFairness({ usage: null, budget: zero, activeRepositoryCount: 2, now }).state).toBe("ADMITTED");
    expect(assessReconciliationFairness({ usage, budget, activeRepositoryCount: 2,
      now: budget.reading!.resetAt }).state).toBe("ADMITTED");
    expect(assessReconciliationFairness({ usage, budget: { state: "UNKNOWN", reading: null, reserve: 500 },
      activeRepositoryCount: 2, now }).state).toBe("ADMITTED");
  });

  it("changes the allowance only with the sponsor's active repository count", () => {
    const usage = { debt: 50, measuredAt: now, ratePerSecond: 1 };
    expect(assessReconciliationFairness({ usage, budget, activeRepositoryCount: 2, now }).state).toBe("HELD");
    expect(assessReconciliationFairness({ usage, budget, activeRepositoryCount: 1, now }))
      .toEqual({ state: "ADMITTED", holdUntil: null, usage: { ...usage, ratePerSecond: 5 / 3 } });
  });

  it("decays before installing an increased allocation rate", () => {
    const later = new Date("2026-09-08T10:00:30Z");
    const increased = { ...budget, reading: { ...budget.reading!, remaining: 71900 } };
    expect(assessReconciliationFairness({ usage: { debt: 50, measuredAt: now, ratePerSecond: 1 },
      budget: increased, activeRepositoryCount: 2, now: later }).usage)
      .toEqual({ debt: 20, measuredAt: later, ratePerSecond: 10 });
  });

  it("pauses decay across repeated backwards checks and bounds a future-timestamp hold", () => {
    const usage = { debt: 50, measuredAt: now, ratePerSecond: 1 };
    const first = decayReconciliationUsage(usage, new Date("2026-09-08T09:59:30Z"));
    const second = decayReconciliationUsage(first, new Date("2026-09-08T09:59:40Z"));
    expect(second).toEqual(usage);
    expect(decayReconciliationUsage(second, new Date("2026-09-08T10:00:10Z")))
      .toEqual({ debt: 40, measuredAt: new Date("2026-09-08T10:00:10Z"), ratePerSecond: 1 });
    expect(assessReconciliationFairness({ usage: { ...usage, measuredAt: new Date("2026-09-08T10:01:00Z") },
      budget, activeRepositoryCount: 2, now }).holdUntil).toEqual(new Date("2026-09-08T10:00:30Z"));
  });

  it("includes the pause before a future usage timestamp in a held recheck", () => {
    expect(assessReconciliationFairness({ usage: { debt: 30, measuredAt: new Date("2026-09-08T10:00:10Z"), ratePerSecond: 1 },
      budget, activeRepositoryCount: 2, now }).holdUntil).toEqual(new Date("2026-09-08T10:00:16Z"));
  });

  it("returns fresh values without mutating inputs and floors exhausted debt at zero", () => {
    const usage = { debt: 1, measuredAt: new Date(now), ratePerSecond: 1 };
    const result = decayReconciliationUsage(usage, new Date("2026-09-08T10:00:30Z"));
    expect(result.debt).toBe(0);
    result.measuredAt.setTime(0);
    expect(usage).toEqual({ debt: 1, measuredAt: now, ratePerSecond: 1 });
    const unchanged = decayReconciliationUsage(usage, now);
    expect(unchanged).not.toBe(usage);
    expect(unchanged.measuredAt).not.toBe(usage.measuredAt);
    const assessed = assessReconciliationFairness({ usage, budget, activeRepositoryCount: 2, now });
    assessed.usage.measuredAt.setTime(0);
    expect(now).toEqual(new Date("2026-09-08T10:00:00Z"));
  });

  it.each(["UNKNOWN", "BELOW_RESERVE"] as const)("admits %s without erasing debt or installing a new rate", (state) => {
    expect(assessReconciliationFairness({ usage: { debt: 50, measuredAt: now, ratePerSecond: 1 },
      budget: { ...budget, state }, activeRepositoryCount: 2, now: new Date("2026-09-08T10:00:30Z") }))
      .toEqual({ state: "ADMITTED", holdUntil: null,
        usage: { debt: 20, measuredAt: new Date("2026-09-08T10:00:30Z"), ratePerSecond: 0 } });
  });

  it.each([
    { reading: null },
    { reading: { ...budget.reading!, resetAt: new Date("invalid") } },
    { reading: { ...budget.reading!, observedAt: new Date("invalid") } },
    { reading: { ...budget.reading!, resetAt: new Date("2026-09-08T09:59:59Z") } },
    ...[-1, Infinity, NaN].map((remaining) => ({ reading: { ...budget.reading!, remaining } })),
    ...[-1, Infinity, NaN].map((reserve) => ({ reserve })),
  ])("admits malformed or expired allocation inputs %j", (invalid) => {
    expect(assessReconciliationFairness({ usage: { debt: 50, measuredAt: now, ratePerSecond: 1 },
      budget: { ...budget, ...invalid }, activeRepositoryCount: 2, now }))
      .toEqual({ state: "ADMITTED", holdUntil: null, usage: { debt: 50, measuredAt: now, ratePerSecond: 0 } });
  });

  it.each([0, -1, 1.5, Infinity, NaN])("admits an unusable active repository count %s", (activeRepositoryCount) => {
    expect(assessReconciliationFairness({ usage: { debt: 50, measuredAt: now, ratePerSecond: 1 },
      budget, activeRepositoryCount, now }))
      .toEqual({ state: "ADMITTED", holdUntil: null, usage: { debt: 50, measuredAt: now, ratePerSecond: 0 } });
  });

  it("admits an invalid clock without advancing a known timestamp, using epoch only when cold", () => {
    const invalid = new Date("invalid");
    const usage = { debt: 50, measuredAt: now, ratePerSecond: 1 };
    expect(decayReconciliationUsage(usage, invalid)).toEqual(usage);
    expect(assessReconciliationFairness({ usage, budget, activeRepositoryCount: 2, now: invalid }))
      .toEqual({ state: "ADMITTED", holdUntil: null, usage: { ...usage, ratePerSecond: 0 } });
    expect(assessReconciliationFairness({ usage: null, budget, activeRepositoryCount: 2, now: invalid }))
      .toEqual({ state: "ADMITTED", holdUntil: null, usage: { debt: 0, measuredAt: new Date(0), ratePerSecond: 0 } });
  });

  it.each([
    { debt: -1, measuredAt: now, ratePerSecond: 1 },
    { debt: Infinity, measuredAt: now, ratePerSecond: 1 },
    { debt: NaN, measuredAt: now, ratePerSecond: 1 },
    { debt: 50, measuredAt: now, ratePerSecond: -1 },
    { debt: 50, measuredAt: now, ratePerSecond: Infinity },
    { debt: 50, measuredAt: now, ratePerSecond: NaN },
    { debt: 50, measuredAt: new Date("invalid"), ratePerSecond: 1 },
  ])("admits malformed usage %j with finite nonnegative state", (usage) => {
    const result = assessReconciliationFairness({ usage, budget, activeRepositoryCount: 2, now });
    expect(result.state).toBe("ADMITTED");
    expect(result.usage.ratePerSecond).toBe(0);
    expect(result.usage.debt).toBe(Number.isFinite(usage.debt) && usage.debt >= 0 ? usage.debt : 0);
    expect(result.usage.measuredAt).toEqual(now);
  });

  it("admits when arithmetic or a recheck deadline cannot be represented", () => {
    const huge = { ...budget, reading: { ...budget.reading!, remaining: Number.MAX_VALUE,
      resetAt: new Date(now.getTime() + 1) } };
    expect(assessReconciliationFairness({ usage: null, budget: huge, activeRepositoryCount: 1, now }).usage.ratePerSecond).toBe(0);
    const end = new Date(8_640_000_000_000_000);
    const almostEnd = new Date(end.getTime() - 1000);
    expect(assessReconciliationFairness({ usage: { debt: 50, measuredAt: almostEnd, ratePerSecond: 0 },
      budget: { ...budget, reading: { ...budget.reading!, remaining: 500, resetAt: end, observedAt: almostEnd } },
      activeRepositoryCount: 2, now: almostEnd }).state).toBe("ADMITTED");
  });
});
