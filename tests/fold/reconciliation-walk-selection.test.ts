import { expect, it, vi } from "vitest";
import { reconcileRepository } from "@/lib/fold/reconcile";
import { RECONCILIATION_EVIDENCE_FORMAT } from "@/lib/fold/reconciliation-evidence";
import { reconciliationDependencies } from "../support/reconciliation-fixtures";
import { memoryPass } from "./reconciliation-walk-fixture";

for (const reason of [undefined, "SWEEP", "REDERIVATION", "WEBHOOK", "REGISTRATION", "OVERRIDE"] as const) {
  for (const diffOnly of [false, true]) for (const sweepDefined of [false, true]) for (const safeCache of [false, true]) {
    it(`selects the budget-bound walk for ${reason}, diffOnly=${diffOnly}, sweep=${sweepDefined}, cache=${safeCache}`, async () => {
      const walk = vi.fn(async () => ({ status: "completed" as const, issues: [], pullRequests: [], missingDisputePrIds: new Set<number>() }));
      const deps = reconciliationDependencies({ github: { walkReconciliation: walk, listIssues: vi.fn(async () => []) } });
      const at = new Date("2030-01-01T00:00:00Z");
      deps.now = () => at;
      deps.store.getSponsorBacklog = async () => diffOnly ? Number.MAX_SAFE_INTEGER : 0;
      deps.store.getReconciliationEvidence = async () => safeCache ? {
        version: 1, formatVersion: RECONCILIATION_EVIDENCE_FORMAT, omittedOversizedFacts: 0,
        checkpoint: at, lastFullPassAt: at, issues: [], pullRequests: [],
      } : null;
      const openPass = vi.fn(async (input: Parameters<NonNullable<typeof deps.sweep>["openPass"]>[0]) => ({ ...memoryPass(), ...input }));
      if (sweepDefined) deps.sweep = { spend: async () => null, discardPass: async () => {}, openPass };
      const result = await reconcileRepository(deps, "repository", { reason, rederive: true });
      const permitsFull = reason === undefined || reason === "SWEEP" || (reason === "REDERIVATION" && diffOnly);
      const needsWalk = sweepDefined && (reason === "SWEEP" || (reason === "REDERIVATION" && diffOnly));
      if (!permitsFull && !safeCache) {
        expect(result).toMatchObject({ skipped: true, sweepPending: true });
        expect(deps.github.listIssues).not.toHaveBeenCalled();
        expect(walk).not.toHaveBeenCalled();
      } else {
        expect(result.skipped).toBe(false);
        expect(walk).toHaveBeenCalledTimes(needsWalk ? 1 : 0);
        expect(deps.github.listIssues).toHaveBeenCalledTimes(needsWalk ? 0 : 1);
      }
      expect(openPass).toHaveBeenCalledTimes(needsWalk ? 1 : 0);
    });
  }
}
