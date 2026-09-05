import { describe, expect, it } from "vitest";
import {
  MINIMUM_CALIBRATION_SAMPLE_SIZE,
  type CalibrationPair,
} from "@/lib/calibration/statistics";
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

  it("rejects a blank moderation reason before opening an audit", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(10, 10_000),
      outsiderSettlementPairs: calibrationPairs(10, 20_000),
    });
    const service = new AccountModerationService(store);

    await expect(
      service.openAccountAudit(moderator(), { ...openAuditInput(), reason: "   " }),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "INVALID_INPUT" });
    expect(store.lastOpenInput).toBeUndefined();
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

  it("holds both cohorts to the shared calibration sample-size floor", async () => {
    const belowFloor = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE - 1, 20_000),
    });

    await expect(
      new AccountModerationService(belowFloor).openAccountAudit(moderator(), openAuditInput()),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({
      code: "INSUFFICIENT_SAMPLES",
      message: `At least ${MINIMUM_CALIBRATION_SAMPLE_SIZE} self-work and ${MINIMUM_CALIBRATION_SAMPLE_SIZE} outsider-settlement pairs are required.`,
    });
    expect(belowFloor.lastOpenInput).toBeUndefined();

    const atFloor = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
    });

    const audit = await new AccountModerationService(atFloor).openAccountAudit(moderator(), openAuditInput());

    expect(audit.state).toBe("OPEN");
    expect(atFloor.lastOpenInput?.cohort.comparison).toMatchObject({
      selfWork: { count: MINIMUM_CALIBRATION_SAMPLE_SIZE },
      outsider: { count: MINIMUM_CALIBRATION_SAMPLE_SIZE },
    });
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

describe("calibration cohort preview", () => {
  it("refuses a preview for a non-moderator before reading any cohort", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
    });

    await expect(
      new AccountModerationService(store).previewCalibrationCohort({ id: "member", role: "MEMBER" }, previewInput()),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "FORBIDDEN" });
    expect(store.cohortReadCount).toBe(0);
  });

  it.each([
    { selfSettled: 7, outsiderSettled: 5, selfMean: 3, outsiderMean: 1, difference: 2 },
    { selfSettled: 5, outsiderSettled: 7, selfMean: 1, outsiderMean: 3, difference: -2 },
  ])("returns the compared cohort with signed difference $difference over the normalized window without opening an audit", async ({ selfSettled, outsiderSettled, selfMean, outsiderMean, difference }) => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000)
        .map((pair) => ({ ...pair, settledDifficulty: selfSettled })),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000)
        .map((pair) => ({ ...pair, settledDifficulty: outsiderSettled })),
    });

    const preview = await new AccountModerationService(store).previewCalibrationCohort(moderator(), {
      targetAccountId: "  target-account  ",
      repositoryId: "  repository-scope  ",
      sampleStartedAt: "2026-01-01T00:00:00Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(preview).toEqual({
      targetAccountId: "target-account",
      repositoryId: "repository-scope",
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
      comparison: {
        selfWork: { count: MINIMUM_CALIBRATION_SAMPLE_SIZE, meanDelta: selfMean, medianDelta: selfMean },
        outsider: { count: MINIMUM_CALIBRATION_SAMPLE_SIZE, meanDelta: outsiderMean, medianDelta: outsiderMean },
        differenceBetweenMeans: difference,
      },
      meetsMinimumSampleSize: true,
    });
    expect(store.lastCohortInput).toEqual({
      targetAccountId: "target-account",
      repositoryId: "repository-scope",
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
    });
    expect(store.lastOpenInput).toBeUndefined();
  });

  it("reads an account-wide cohort when no repository scope is given", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
    });

    const preview = await new AccountModerationService(store).previewCalibrationCohort(moderator(), {
      targetAccountId: "target-account",
      sampleStartedAt: "2026-01-01T00:00:00.000Z",
      sampleEndedAt: "2026-02-01T00:00:00.000Z",
    });

    expect(preview.repositoryId).toBeNull();
    expect(store.lastCohortInput?.repositoryId).toBeNull();
  });

  it.each([
    ["self-work", MINIMUM_CALIBRATION_SAMPLE_SIZE - 1, MINIMUM_CALIBRATION_SAMPLE_SIZE],
    ["outsider-settlement", MINIMUM_CALIBRATION_SAMPLE_SIZE, MINIMUM_CALIBRATION_SAMPLE_SIZE - 1],
  ] as const)(
    "shows a short %s cohort rather than refusing the window an audit would refuse",
    async (_side, selfWorkCount, outsiderCount) => {
      const store = new TestModerationStore({
        selfWorkPairs: calibrationPairs(selfWorkCount, 10_000),
        outsiderSettlementPairs: calibrationPairs(outsiderCount, 20_000),
      });
      const service = new AccountModerationService(store);

      const preview = await service.previewCalibrationCohort(moderator(), previewInput());

      expect(preview.meetsMinimumSampleSize).toBe(false);
      expect(preview.comparison.selfWork.count).toBe(selfWorkCount);
      expect(preview.comparison.outsider.count).toBe(outsiderCount);

      await expect(
        service.openAccountAudit(moderator(), {
          ...previewInput(),
          reason: "A moderator identified a sustained account-level pattern.",
        }),
      ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "INSUFFICIENT_SAMPLES" });
      expect(store.lastOpenInput).toBeUndefined();
    },
  );

  it("reports a target account the store cannot find", async () => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
      missingAccount: true,
    });

    await expect(
      new AccountModerationService(store).previewCalibrationCohort(moderator(), previewInput()),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "NOT_FOUND" });
  });

  it("reports a cohort the calibration statistics reject as invalid input", async () => {
    const corrupted = calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000);
    corrupted[0] = { ...corrupted[0]!, settledDifficulty: 11 };
    const store = new TestModerationStore({
      selfWorkPairs: corrupted,
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
    });

    await expect(
      new AccountModerationService(store).previewCalibrationCohort(moderator(), previewInput()),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({
      code: "INVALID_INPUT",
      message: "The selected calibration cohort is invalid.",
    });
  });

  it.each([
    ["a window that ends before it starts", { sampleEndedAt: "2025-12-01T00:00:00.000Z" }],
    ["a window that ends when it starts", { sampleEndedAt: "2026-01-01T00:00:00.000Z" }],
    ["an unparseable window bound", { sampleStartedAt: "the first of January" }],
    ["a blank target account identifier", { targetAccountId: "   " }],
  ] as const)("refuses %s before reading any cohort", async (_label, overrides) => {
    const store = new TestModerationStore({
      selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
      outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
    });

    await expect(
      new AccountModerationService(store).previewCalibrationCohort(moderator(), {
        ...previewInput(),
        ...overrides,
      }),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "INVALID_INPUT" });
    expect(store.cohortReadCount).toBe(0);
  });
});

type LoadedCohortRequest = {
  targetAccountId: string;
  repositoryId: string | null;
  sampleStartedAt: string;
  sampleEndedAt: string;
};

class TestModerationStore implements ModerationStore {
  public cohortReadCount = 0;
  public settlementMutationCount = 0;
  public ledgerMutationCount = 0;
  public lastOpenInput: OpenAccountAuditStoreInput | undefined;
  public lastDismissInput: { actorId: string; auditId: string; reason: string } | undefined;
  public lastSubstantiateInput: { actorId: string; auditId: string; reason: string } | undefined;
  public lastCloseInput: { actorId: string; targetAccountId: string; plan: string } | undefined;
  public lastCohortInput: LoadedCohortRequest | undefined;

  public constructor(
    private readonly options: {
      selfWorkPairs: CalibrationPair[];
      outsiderSettlementPairs: CalibrationPair[];
      missingAccount?: boolean;
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

  public async loadCalibrationCohort(input: LoadedCohortRequest): Promise<LoadedCalibrationCohort | null> {
    this.cohortReadCount += 1;
    this.lastCohortInput = input;
    if (this.options.missingAccount === true) {
      return null;
    }
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

  public async listModerators() {
    return [];
  }

  public async setModeratorRole(): Promise<ModerationStoreResult<never>> {
    return { kind: "not_found" };
  }
}

function moderator() {
  return { id: "moderator", role: "MODERATOR" as const };
}

function previewInput() {
  return {
    targetAccountId: "target-account",
    repositoryId: "repository-scope",
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
  };
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
    mergedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
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
