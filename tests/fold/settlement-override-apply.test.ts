import { describe, expect, it } from "vitest";
import type { FoldSettlement } from "@/lib/fold/repository-fold";
import { applyGrantedSettlementOverride } from "@/lib/overrides/apply";

function unsettled(overrides: Partial<FoldSettlement> = {}): FoldSettlement {
  return {
    githubIssueId: 44,
    githubPullRequestId: 4_400,
    creditorId: "creditor-id",
    creditorGitHubLogin: "ada",
    creditorGitHubUserId: 2001,
    debtorId: "debtor-id",
    openingComparisonPoints: 5,
    settledLabel: null,
    settledPoints: null,
    settledLabelEventId: null,
    settledLabelActorLogin: null,
    settledLabelAppliedAt: null,
    settledRationaleCommentId: null,
    settledRationaleActorLogin: null,
    settledRationaleCommentedAt: null,
    mergeCommitOid: "a".repeat(40),
    mergedAt: "2026-09-01T12:00:00.000Z",
    reviewRounds: 2,
    credits: 0,
    proofSha256: "b".repeat(64),
    status: "UNSETTLED",
    ...overrides,
  };
}

describe("granted settlement override applied to a folded settlement", () => {
  it("settles an unsettled settlement at the overridden points", () => {
    const applied = applyGrantedSettlementOverride(unsettled(), 6);

    expect(applied).toMatchObject({ status: "SETTLED", settledPoints: 6, credits: 4 });
  });

  it("recomputes credits from the rule rather than storing a figure", () => {
    expect(applyGrantedSettlementOverride(unsettled({ reviewRounds: 0 }), 6).credits).toBe(6);
    expect(applyGrantedSettlementOverride(unsettled({ reviewRounds: 9 }), 6).credits).toBe(0);
  });

  it("corrects a settlement that was already settled at the wrong points", () => {
    const applied = applyGrantedSettlementOverride(
      unsettled({ status: "SETTLED", settledPoints: 2, settledLabel: "delivered/2", credits: 0, reviewRounds: 2 }),
      8,
    );

    expect(applied).toMatchObject({ status: "SETTLED", settledPoints: 8, credits: 6 });
  });

  it("leaves the immutable GitHub evidence untouched", () => {
    const before = unsettled();
    const applied = applyGrantedSettlementOverride(before, 6);

    expect(applied.proofSha256).toBe(before.proofSha256);
    expect(applied.mergeCommitOid).toBe(before.mergeCommitOid);
    expect(applied.settledLabel).toBeNull();
    expect(applied.settledLabelEventId).toBeNull();
    expect(applied.settledRationaleCommentId).toBeNull();
    expect(before.status).toBe("UNSETTLED");
  });

  it("keeps an unclaimed settlement unclaimed while correcting its points", () => {
    const applied = applyGrantedSettlementOverride(
      unsettled({ creditorId: null, status: "UNCLAIMED", settledPoints: 3, credits: 1 }),
      7,
    );

    expect(applied).toMatchObject({ status: "UNCLAIMED", settledPoints: 7, credits: 5, creditorId: null });
  });

  it("cannot settle work whose author has no GitHub login at all", () => {
    const orphan = unsettled({ creditorId: null, creditorGitHubLogin: null });

    expect(applyGrantedSettlementOverride(orphan, 6)).toEqual(orphan);
  });

  it("cannot settle self-work, where creditor and debtor are the same account", () => {
    const selfWork = unsettled({ creditorId: "debtor-id" });

    expect(applyGrantedSettlementOverride(selfWork, 6)).toEqual(selfWork);
  });

  it("ignores points outside the catalog range", () => {
    const settlement = unsettled();

    expect(applyGrantedSettlementOverride(settlement, 0)).toEqual(settlement);
    expect(applyGrantedSettlementOverride(settlement, 11)).toEqual(settlement);
    expect(applyGrantedSettlementOverride(settlement, 4.5)).toEqual(settlement);
  });
});
