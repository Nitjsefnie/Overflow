import { describe, expect, it } from "vitest";
import type { CalibrationPair } from "@/lib/calibration/statistics";
import {
  AccountModerationService,
  ModerationServiceError,
  type AccountAudit,
  type CalibrationCohortSnapshot,
  type LoadedCalibrationCohort,
  type ModerationStore,
  type ModerationStoreResult,
  type OpenAccountAuditStoreInput,
} from "@/lib/moderation/service";

describe("account moderation service", () => {
  it("opens an eligible account audit with an exact reproducible cohort snapshot", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
    });
    const service = new AccountModerationService(store);

    const audit = await service.openAccountAudit(moderator(), {
      targetAccountId: "target-account",
      repositoryId: "repository-scope",
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
      reason: "A moderator identified a sustained account-level pattern.",
    });

    expect(audit).toMatchObject({
      id: "audit-1",
      targetAccountId: "target-account",
      repositoryId: "repository-scope",
      state: "OPEN",
      priorState: "ACTIVE",
      targetState: "UNDER_AUDIT",
    });
    expect(store.lastOpenInput?.cohort).toEqual({
      targetAccountId: "target-account",
      repositoryId: "repository-scope",
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
      comparison: {
        selfWork: { count: 10, meanDelta: 1, medianDelta: 1 },
        outsider: { count: 10, meanDelta: 1, medianDelta: 1 },
        differenceBetweenMeans: 0,
      },
    });
  });

  it("rejects an audit when either account-level cohort has fewer than ten valid pairs", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(9, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
    });
    const service = new AccountModerationService(store);

    await expect(
      service.openAccountAudit(moderator(), openAuditInput()),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "INSUFFICIENT_SAMPLES" });
    expect(store.lastOpenInput).toBeUndefined();
  });

  it("requires a moderator before reading or changing account-moderation state", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
    });
    const service = new AccountModerationService(store);

    await expect(
      service.openAccountAudit({ id: "member", role: "MEMBER" }, openAuditInput()),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "FORBIDDEN" });
    expect(store.cohortReadCount).toBe(0);
  });

  it("surfaces a duplicate open audit without changing a second account state", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
      openResult: { kind: "conflict" },
    });
    const service = new AccountModerationService(store);

    await expect(service.openAccountAudit(moderator(), openAuditInput())).rejects.toMatchObject<
      Partial<ModerationServiceError>
    >({ code: "CONFLICT" });
  });

  it("dispatches a dismissal that restores the audit's exact prior enforcement state", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
      dismissResult: {
        kind: "ok",
        value: accountAudit({
          state: "DISMISSED",
          priorState: "WARNED",
          targetState: "WARNED",
          confirmedPatternCount: 1,
        }),
      },
    });
    const service = new AccountModerationService(store);

    const audit = await service.dismissAccountAudit(moderator(), "audit-1", "The comparison does not support a pattern.");

    expect(audit).toMatchObject({ state: "DISMISSED", targetState: "WARNED", confirmedPatternCount: 1 });
    expect(store.lastDismissInput).toEqual({
      actorId: "moderator",
      auditId: "audit-1",
      reason: "The comparison does not support a pattern.",
    });
  });

  it("dispatches substantiation and recalibration closure without accepting settlement corrections", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
      substantiateResult: {
        kind: "ok",
        value: accountAudit({
          state: "SUBSTANTIATED",
          targetState: "RECALIBRATING",
          confirmedPatternCount: 2,
        }),
      },
      closeResult: {
        kind: "ok",
        value: {
          targetAccountId: "target-account",
          priorState: "RECALIBRATING",
          targetState: "ACTIVE",
          confirmedPatternCount: 2,
          reactivatedRepositoryCount: 3,
        },
      },
    });
    const service = new AccountModerationService(store);

    const substantiated = await service.substantiateAccountAudit(
      moderator(),
      "audit-1",
      "The preserved cohorts support an account-level pattern.",
    );
    const closed = await service.closeRecalibration(
      moderator(),
      "target-account",
      "Review ten completed contributions before applying each opening label.",
    );

    expect(substantiated).toMatchObject({
      state: "SUBSTANTIATED",
      targetState: "RECALIBRATING",
      confirmedPatternCount: 2,
    });
    expect(closed).toEqual({
      targetAccountId: "target-account",
      priorState: "RECALIBRATING",
      targetState: "ACTIVE",
      confirmedPatternCount: 2,
      reactivatedRepositoryCount: 3,
    });
    expect(store.lastSubstantiateInput).toEqual({
      actorId: "moderator",
      auditId: "audit-1",
      reason: "The preserved cohorts support an account-level pattern.",
    });
    expect(store.lastCloseInput).toEqual({
      actorId: "moderator",
      targetAccountId: "target-account",
      plan: "Review ten completed contributions before applying each opening label.",
    });
    expect(store.settlementMutationCount).toBe(0);
    expect(store.ledgerMutationCount).toBe(0);
  });
});

class TestModerationStore implements ModerationStore {
  public cohortReadCount = 0;
  public settlementMutationCount = 0;
  public ledgerMutationCount = 0;
  public lastOpenInput: OpenAccountAuditStoreInput | undefined;
  public lastDismissInput: { actorId: string; auditId: string; reason: string } | undefined;
  public lastSubstantiateInput: { actorId: string; auditId: string; reason: string } | undefined;
  public lastCloseInput: { actorId: string; targetAccountId: string; plan: string } | undefined;

  public constructor(
    private readonly options: {
      selfWorkPairs: CalibrationPair[];
      outsiderSettlementPairs: CalibrationPair[];
      openResult?: ModerationStoreResult<AccountAudit>;
      dismissResult?: ModerationStoreResult<AccountAudit>;
      substantiateResult?: ModerationStoreResult<AccountAudit>;
      closeResult?: ModerationStoreResult<{
        targetAccountId: string;
        priorState: "RECALIBRATING";
        targetState: "ACTIVE";
        confirmedPatternCount: number;
        reactivatedRepositoryCount: number;
      }>;
    },
  ) {}

  public async loadCalibrationCohort(): Promise<LoadedCalibrationCohort | null> {
    this.cohortReadCount += 1;
    return {
      selfWorkPairs: this.options.selfWorkPairs,
      outsiderSettlementPairs: this.options.outsiderSettlementPairs,
    };
  }

  public async openAccountAudit(input: OpenAccountAuditStoreInput): Promise<ModerationStoreResult<AccountAudit>> {
    this.lastOpenInput = input;
    return this.options.openResult ?? {
      kind: "ok",
      value: accountAudit({ cohort: input.cohort, repositoryId: input.repositoryId }),
    };
  }

  public async dismissAccountAudit(input: {
    actorId: string;
    auditId: string;
    reason: string;
  }): Promise<ModerationStoreResult<AccountAudit>> {
    this.lastDismissInput = input;
    return this.options.dismissResult ?? { kind: "not_found" };
  }

  public async substantiateAccountAudit(input: {
    actorId: string;
    auditId: string;
    reason: string;
  }): Promise<ModerationStoreResult<AccountAudit>> {
    this.lastSubstantiateInput = input;
    return this.options.substantiateResult ?? { kind: "not_found" };
  }

  public async closeRecalibration(input: {
    actorId: string;
    targetAccountId: string;
    plan: string;
  }): Promise<ModerationStoreResult<{
    targetAccountId: string;
    priorState: "RECALIBRATING";
    targetState: "ACTIVE";
    confirmedPatternCount: number;
    reactivatedRepositoryCount: number;
  }>> {
    this.lastCloseInput = input;
    return this.options.closeResult ?? { kind: "not_found" };
  }
}

function moderator() {
  return { id: "moderator", role: "MODERATOR" as const };
}

function openAuditInput() {
  return {
    targetAccountId: "target-account",
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
    reason: "A moderator identified a sustained account-level pattern.",
  };
}

function calibrationPairs(count: number, offset: number): CalibrationPair[] {
  return Array.from({ length: count }, (_, index) => ({
    githubRepositoryId: 700 + index,
    githubIssueId: offset + index,
    githubPullRequestId: offset + 1_000 + index,
    proofSha256: (offset + index).toString(16).padStart(64, "0"),
    offeredDifficulty: 4,
    settledDifficulty: 5,
  }));
}

function accountAudit(overrides: Partial<AccountAudit> = {}): AccountAudit {
  return {
    id: "audit-1",
    targetAccountId: "target-account",
    repositoryId: null,
    state: "OPEN",
    priorState: "ACTIVE",
    targetState: "UNDER_AUDIT",
    confirmedPatternCount: 0,
    cohort: emptyCohort(),
    ...overrides,
  };
}

function emptyCohort(): CalibrationCohortSnapshot {
  return {
    targetAccountId: "target-account",
    repositoryId: null,
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
    selfWorkPairs: [],
    outsiderSettlementPairs: [],
    comparison: {
      selfWork: { count: 0, meanDelta: 0, medianDelta: 0 },
      outsider: { count: 0, meanDelta: 0, medianDelta: 0 },
      differenceBetweenMeans: 0,
    },
  };
}
