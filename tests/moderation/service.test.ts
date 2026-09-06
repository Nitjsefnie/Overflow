import { afterEach, describe, expect, it } from "vitest";
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

// A sample-window bound selects which merged pairs enter the calibration cohort, so a bound
// that names a wall-clock reading rather than an instant makes the audit's evidence depend
// on where the server happens to run. The service refuses those rather than guessing a zone,
// and refuses the spellings outside its accepted subset alongside them, so that one accepted
// subset is the whole rule.
describe("sample-window bounds outside the accepted ISO 8601 subset", () => {
  const offsetRequirement = /must be an ISO 8601 timestamp with an explicit UTC offset\./;
  const refusedBounds = [
    ["an offset-less date-time", "2026-01-01T00:00"],
    ["an offset-less date-time carrying milliseconds", "2026-01-01T00:00:00.000"],
    ["a date-only bound", "2026-01-01"],
    ["a non-ISO string V8 resolves in the local zone", "Jan 1 2026"],
    ["an unparseable bound", "the first of January"],
    ["a lowercase UTC designator", "2026-01-01T00:00:00.000z"],
    ["a numeric offset written without its colon", "2026-01-01T00:00+0200"],
    // Unambiguous, but outside the subset by decision rather than by accident: `new Date`
    // reads a comma separator as NaN, and admitting an end-of-day hour would mean an
    // alternation that still has to keep 24:30 out for one spelling nothing emits.
    ["a comma decimal separator", "2026-01-01T00:00:00,5Z"],
    ["an end-of-day hour", "2026-01-01T24:00:00Z"],
  ] as const;

  const originalTimeZone = process.env.TZ;
  afterEach(() => {
    if (originalTimeZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTimeZone;
    }
  });

  it.each(refusedBounds)("refuses %s as an audit's sample start", async (_label, bound) => {
    const store = eligibleStore();

    await expect(
      new AccountModerationService(store).openAccountAudit(moderator(), {
        ...openAuditInput(),
        sampleStartedAt: bound,
      }),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({
      code: "INVALID_INPUT",
      message: expect.stringMatching(offsetRequirement) as unknown as string,
    });
    expect(store.cohortReadCount).toBe(0);
    expect(store.lastOpenInput).toBeUndefined();
  });

  // The start sits a year earlier so that every bound below reads as a window that ends after
  // it starts under any timezone, leaving the offset rule as the only thing that can refuse it.
  it.each(refusedBounds)("refuses %s as an audit's sample end", async (_label, bound) => {
    const store = eligibleStore();

    await expect(
      new AccountModerationService(store).openAccountAudit(moderator(), {
        ...openAuditInput(),
        sampleStartedAt: "2025-01-01T00:00:00.000Z",
        sampleEndedAt: bound,
      }),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({
      code: "INVALID_INPUT",
      message: expect.stringMatching(offsetRequirement) as unknown as string,
    });
    expect(store.cohortReadCount).toBe(0);
    expect(store.lastOpenInput).toBeUndefined();
  });

  // previewCalibrationCohort normalizes the same window through its own entry point, so a
  // guard proved only on openAccountAudit would leave the preview reading a different cohort.
  it.each(refusedBounds)("refuses %s in a cohort preview", async (_label, bound) => {
    const store = eligibleStore();

    await expect(
      new AccountModerationService(store).previewCalibrationCohort(moderator(), {
        ...previewInput(),
        sampleStartedAt: bound,
      }),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({
      code: "INVALID_INPUT",
      message: expect.stringMatching(offsetRequirement) as unknown as string,
    });
    expect(store.cohortReadCount).toBe(0);
  });

  // `new Date` rolls an impossible day into the following month rather than reporting NaN,
  // so a shape check alone would silently audit a window nobody asked for.
  it.each([
    ["a day past the end of February", "2026-02-31T00:00:00Z"],
    ["a leap day in a common year", "2026-02-29T00:00:00Z"],
    ["a day past the end of April", "2026-04-31T00:00:00Z"],
  ] as const)("refuses %s even though its shape is well formed", async (_label, bound) => {
    const store = eligibleStore();

    await expect(
      new AccountModerationService(store).previewCalibrationCohort(moderator(), {
        ...previewInput(),
        sampleStartedAt: bound,
        // Late enough that the rolled-over instant still opens a window, so the refusal
        // cannot come from the end-after-start rule.
        sampleEndedAt: "2027-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject<Partial<ModerationServiceError>>({
      code: "INVALID_INPUT",
      message: "Sample start must be a valid timestamp.",
    });
    expect(store.cohortReadCount).toBe(0);
  });

  it.each([
    ["a minute-precision UTC designator", "2026-01-01T00:00Z", "2026-01-01T00:00:00.000Z"],
    ["a second-precision UTC designator", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00.000Z"],
    ["a millisecond-precision UTC designator", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"],
    ["a positive numeric offset", "2026-01-01T02:00:00+02:00", "2026-01-01T00:00:00.000Z"],
    ["a negative numeric offset", "2025-12-31T19:00:00-05:00", "2026-01-01T00:00:00.000Z"],
    ["a negative zero offset", "2026-01-01T00:00-00:00", "2026-01-01T00:00:00.000Z"],
    ["a leap day in a leap year", "2024-02-29T00:00:00Z", "2024-02-29T00:00:00.000Z"],
    // Producers other than `toISOString` write a different number of fractional digits:
    // Python's `datetime.isoformat` writes six, Go's RFC3339Nano writes as many as it needs,
    // and a hand-written bound may carry one. Each names exactly one instant, so each is
    // accepted; `Date` truncates below milliseconds, which loses precision but not meaning.
    ["a single fractional digit", "2026-01-01T00:00:00.5Z", "2026-01-01T00:00:00.500Z"],
    ["microsecond precision", "2026-01-01T00:00:00.123456Z", "2026-01-01T00:00:00.123Z"],
    ["nanosecond precision", "2026-01-01T00:00:00.123456789Z", "2026-01-01T00:00:00.123Z"],
    ["a fractional second on an offset-bearing bound", "2026-01-01T02:00:00.5+02:00", "2026-01-01T00:00:00.500Z"],
  ] as const)("accepts %s and stores the instant it names", async (_label, bound, instant) => {
    const store = eligibleStore();

    const preview = await new AccountModerationService(store).previewCalibrationCohort(moderator(), {
      ...previewInput(),
      sampleStartedAt: bound,
    });

    expect(preview.sampleStartedAt).toBe(instant);
    expect(store.lastCohortInput?.sampleStartedAt).toBe(instant);
  });

  // The bug this pins: before the offset requirement, one request body recorded a different
  // instant on a Europe/Prague host than on a UTC one, with nothing in the response to say so.
  it("normalizes an offset-bearing bound identically in every server timezone", async () => {
    const zones = ["UTC", "America/New_York", "Asia/Tokyo"] as const;
    const normalized: string[] = [];

    for (const zone of zones) {
      process.env.TZ = zone;
      const store = eligibleStore();

      const preview = await new AccountModerationService(store).previewCalibrationCohort(moderator(), {
        ...previewInput(),
        sampleStartedAt: "2026-01-01T02:00:00+02:00",
      });

      normalized.push(preview.sampleStartedAt);
    }

    expect(normalized).toEqual(zones.map(() => "2026-01-01T00:00:00.000Z"));
  });

  it.each(["UTC", "America/New_York", "Asia/Tokyo"])(
    "refuses an offset-less bound on a server running in %s",
    async (zone) => {
      process.env.TZ = zone;
      const store = eligibleStore();

      await expect(
        new AccountModerationService(store).previewCalibrationCohort(moderator(), {
          ...previewInput(),
          sampleStartedAt: "2026-01-01T00:00",
        }),
      ).rejects.toMatchObject<Partial<ModerationServiceError>>({ code: "INVALID_INPUT" });
      expect(store.cohortReadCount).toBe(0);
    },
  );
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

/** A store with cohorts large enough to open an audit, so a refusal is the window's doing. */
function eligibleStore(): TestModerationStore {
  return new TestModerationStore({
    selfWorkPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 10_000),
    outsiderSettlementPairs: calibrationPairs(MINIMUM_CALIBRATION_SAMPLE_SIZE, 20_000),
  });
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
