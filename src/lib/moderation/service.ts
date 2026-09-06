import {
  CalibrationStatisticsError,
  compareCalibration,
  MINIMUM_CALIBRATION_SAMPLE_SIZE,
  type CalibrationComparison,
  type CalibrationPair,
} from "@/lib/calibration/statistics";
import type { EnforcementState, UserRole } from "@/lib/db/types";
import { normalizeRecalibrationPlan } from "@/lib/moderation/transitions";

export type ModerationActor = {
  id: string;
  role: UserRole;
};

export type AccountAuditState = "OPEN" | "DISMISSED" | "SUBSTANTIATED";

export type LoadedCalibrationCohort = {
  selfWorkPairs: readonly CalibrationPair[];
  outsiderSettlementPairs: readonly CalibrationPair[];
};

export type CalibrationCohortSnapshot = {
  targetAccountId: string;
  repositoryId: string | null;
  sampleStartedAt: string;
  sampleEndedAt: string;
  selfWorkPairs: readonly CalibrationPair[];
  outsiderSettlementPairs: readonly CalibrationPair[];
  comparison: CalibrationComparison;
};

export type AccountAudit = {
  id: string;
  targetAccountId: string;
  repositoryId: string | null;
  state: AccountAuditState;
  priorState: EnforcementState;
  targetState: EnforcementState;
  confirmedPatternCount: number;
  cohort: CalibrationCohortSnapshot;
};

export type RecalibrationClosure = {
  targetAccountId: string;
  priorState: "RECALIBRATING";
  targetState: "ACTIVE";
  confirmedPatternCount: number;
  reactivatedRepositoryCount: number;
};

export type OpenAccountAuditInput = {
  targetAccountId: string;
  repositoryId?: string;
  sampleStartedAt: string;
  sampleEndedAt: string;
  reason: string;
};

export type CalibrationCohortPreview = {
  targetAccountId: string;
  repositoryId: string | null;
  sampleStartedAt: string;
  sampleEndedAt: string;
  comparison: CalibrationComparison;
  meetsMinimumSampleSize: boolean;
};

export type OpenAccountAuditStoreInput = {
  actorId: string;
  targetAccountId: string;
  repositoryId: string | null;
  reason: string;
  cohort: CalibrationCohortSnapshot;
};

export type ModerationStoreResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "invalid_state" };

export type ModeratorSummary = {
  accountId: string;
  githubLogin: string;
  isConfigured: boolean;
};

export type ModeratorRoleChange = {
  targetAccountId: string;
  targetGitHubLogin: string;
  role: "MEMBER" | "MODERATOR";
  actorId: string;
  changedAt: string;
};

export type ModerationStore = {
  loadCalibrationCohort(input: {
    targetAccountId: string;
    repositoryId: string | null;
    sampleStartedAt: string;
    sampleEndedAt: string;
  }): Promise<LoadedCalibrationCohort | null>;
  openAccountAudit(input: OpenAccountAuditStoreInput): Promise<ModerationStoreResult<AccountAudit>>;
  dismissAccountAudit(input: {
    actorId: string;
    auditId: string;
    reason: string;
  }): Promise<ModerationStoreResult<AccountAudit>>;
  substantiateAccountAudit(input: {
    actorId: string;
    auditId: string;
    reason: string;
  }): Promise<ModerationStoreResult<AccountAudit>>;
  closeRecalibration(input: {
    actorId: string;
    targetAccountId: string;
    plan: string;
  }): Promise<ModerationStoreResult<RecalibrationClosure>>;
  listModerators(): Promise<ModeratorSummary[]>;
  setModeratorRole(input: {
    actorId: string;
    targetAccountId: string;
    moderator: boolean;
  }): Promise<ModerationStoreResult<ModeratorRoleChange>>;
};

export type ModerationServiceErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_INPUT"
  | "INSUFFICIENT_SAMPLES";

export class ModerationServiceError extends Error {
  public constructor(
    public readonly code: ModerationServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ModerationServiceError";
  }
}

export class AccountModerationService {
  public constructor(private readonly store: ModerationStore) {}

  public async listModerators(actor: ModerationActor): Promise<ModeratorSummary[]> {
    requireModerator(actor);
    return this.store.listModerators();
  }

  /**
   * Grants or revokes moderator status.
   *
   * Revoking yourself is refused rather than merely discouraged: it is the one
   * move that can leave an instance with nobody able to undo it, and the actor
   * is by definition the person least in need of protection from it. The store
   * additionally refuses to revoke the last remaining moderator, which covers
   * the case of two moderators revoking each other.
   */
  public async setModeratorRole(
    actor: ModerationActor,
    targetAccountId: string,
    moderator: boolean,
  ): Promise<ModeratorRoleChange> {
    requireModerator(actor);
    if (!moderator && actor.id === targetAccountId) {
      throw new ModerationServiceError(
        "INVALID_INPUT",
        "Revoke your own moderator status from another moderator's account.",
      );
    }

    return unwrapStoreResult(
      await this.store.setModeratorRole({ actorId: actor.id, targetAccountId, moderator }),
    );
  }

  public async openAccountAudit(
    actor: ModerationActor,
    input: OpenAccountAuditInput,
  ): Promise<AccountAudit> {
    requireModerator(actor);
    const { reason, ...window } = normalizeOpenInput(input);
    const { loaded, comparison } = await this.compareCohort(window);
    if (
      comparison.selfWork.count < MINIMUM_CALIBRATION_SAMPLE_SIZE ||
      comparison.outsider.count < MINIMUM_CALIBRATION_SAMPLE_SIZE
    ) {
      throw new ModerationServiceError(
        "INSUFFICIENT_SAMPLES",
        `At least ${MINIMUM_CALIBRATION_SAMPLE_SIZE} self-work and ${MINIMUM_CALIBRATION_SAMPLE_SIZE} outsider-settlement pairs are required.`,
      );
    }

    return unwrapStoreResult(
      await this.store.openAccountAudit({
        actorId: actor.id,
        targetAccountId: window.targetAccountId,
        repositoryId: window.repositoryId,
        reason,
        cohort: {
          ...window,
          selfWorkPairs: [...loaded.selfWorkPairs],
          outsiderSettlementPairs: [...loaded.outsiderSettlementPairs],
          comparison,
        },
      }),
    );
  }

  /**
   * Shows a moderator the paired evidence a window would put in front of them
   * before they commit to opening an audit.
   *
   * A window too short to audit is exactly what a moderator needs to see, so
   * this reports the shortfall as `meetsMinimumSampleSize: false` instead of
   * refusing the read the way `openAccountAudit` does.
   */
  public async previewCalibrationCohort(
    actor: ModerationActor,
    input: Omit<OpenAccountAuditInput, "reason">,
  ): Promise<CalibrationCohortPreview> {
    requireModerator(actor);
    const normalized = normalizeAuditWindow(input);
    const { comparison } = await this.compareCohort(normalized);

    return {
      ...normalized,
      comparison,
      meetsMinimumSampleSize:
        comparison.selfWork.count >= MINIMUM_CALIBRATION_SAMPLE_SIZE &&
        comparison.outsider.count >= MINIMUM_CALIBRATION_SAMPLE_SIZE,
    };
  }

  public async dismissAccountAudit(
    actor: ModerationActor,
    auditId: string,
    reason: string,
  ): Promise<AccountAudit> {
    requireModerator(actor);
    return unwrapStoreResult(
      await this.store.dismissAccountAudit({
        actorId: actor.id,
        auditId: normalizeIdentifier(auditId, "Audit identifier"),
        reason: normalizeReason(reason),
      }),
    );
  }

  public async substantiateAccountAudit(
    actor: ModerationActor,
    auditId: string,
    reason: string,
  ): Promise<AccountAudit> {
    requireModerator(actor);
    return unwrapStoreResult(
      await this.store.substantiateAccountAudit({
        actorId: actor.id,
        auditId: normalizeIdentifier(auditId, "Audit identifier"),
        reason: normalizeReason(reason),
      }),
    );
  }

  public async closeRecalibration(
    actor: ModerationActor,
    targetAccountId: string,
    plan: string,
  ): Promise<RecalibrationClosure> {
    requireModerator(actor);
    let normalizedPlan: string;
    try {
      normalizedPlan = normalizeRecalibrationPlan(plan);
    } catch {
      throw new ModerationServiceError("INVALID_INPUT", "A nonblank recalibration plan is required.");
    }
    return unwrapStoreResult(
      await this.store.closeRecalibration({
        actorId: actor.id,
        targetAccountId: normalizeIdentifier(targetAccountId, "Target account identifier"),
        plan: normalizedPlan,
      }),
    );
  }

  private async compareCohort(
    window: NormalizedAuditWindow,
  ): Promise<{ loaded: LoadedCalibrationCohort; comparison: CalibrationComparison }> {
    const loaded = await this.store.loadCalibrationCohort(window);
    if (loaded === null) {
      throw new ModerationServiceError("NOT_FOUND", "The target account was not found.");
    }

    try {
      return { loaded, comparison: compareCalibration(loaded.selfWorkPairs, loaded.outsiderSettlementPairs) };
    } catch (error) {
      if (error instanceof CalibrationStatisticsError) {
        throw new ModerationServiceError("INVALID_INPUT", "The selected calibration cohort is invalid.");
      }
      throw error;
    }
  }
}

function requireModerator(actor: ModerationActor): void {
  if (actor.role !== "MODERATOR") {
    throw new ModerationServiceError("FORBIDDEN", "Moderator authorization is required.");
  }
}

type NormalizedAuditWindow = {
  targetAccountId: string;
  repositoryId: string | null;
  sampleStartedAt: string;
  sampleEndedAt: string;
};

function normalizeAuditWindow(input: Omit<OpenAccountAuditInput, "reason">): NormalizedAuditWindow {
  const sampleStartedAt = normalizeTimestamp(input.sampleStartedAt, "Sample start");
  const sampleEndedAt = normalizeTimestamp(input.sampleEndedAt, "Sample end");
  if (new Date(sampleEndedAt).getTime() <= new Date(sampleStartedAt).getTime()) {
    throw new ModerationServiceError("INVALID_INPUT", "The sample end must be after the sample start.");
  }

  return {
    targetAccountId: normalizeIdentifier(input.targetAccountId, "Target account identifier"),
    repositoryId:
      input.repositoryId === undefined ? null : normalizeIdentifier(input.repositoryId, "Repository identifier"),
    sampleStartedAt,
    sampleEndedAt,
  };
}

function normalizeOpenInput(input: OpenAccountAuditInput): NormalizedAuditWindow & { reason: string } {
  return { ...normalizeAuditWindow(input), reason: normalizeReason(input.reason) };
}

/**
 * Sample-window bounds use RFC 3339's explicit-offset and fractional-second syntax, with
 * ISO 8601 signed six-digit years so the normalizer accepts its own `toISOString` output
 * outside years 0000–9999. Minute precision remains a compatibility extension; the date/time
 * separator is uppercase T and seconds are limited to 00–59 (Date cannot parse leap seconds).
 *
 * ECMAScript resolves a date-time carrying no offset in the timezone of the server process,
 * so `2026-01-01T00:00` would name a different instant on a Europe/Prague host than on a UTC
 * one, and the bounds decide which merged pairs enter an audit's calibration cohort. A
 * date-only bound is refused too: its UTC default is not an offset the caller stated.
 *
 * RFC 3339 permits Z or z, numeric offsets with a colon, and one or more fractional digits.
 * Digits below millisecond precision are truncated by Date: a deliberate loss of precision
 * rather than of meaning. RFC 3339 excludes hour 24 and colonless numeric offsets, even
 * though Date parses them, and uses a dot rather than a comma for fractional seconds.
 */
const SAMPLE_WINDOW_BOUND_PATTERN =
  /^(\d{4}|[+-]\d{6})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ModerationServiceError("INVALID_INPUT", `${label} must be a valid timestamp.`);
  }
  const bound = SAMPLE_WINDOW_BOUND_PATTERN.exec(value);
  if (bound === null) {
    throw new ModerationServiceError(
      "INVALID_INPUT",
      `${label} must be an ISO 8601 timestamp with an explicit UTC offset.`,
    );
  }
  // After a pattern match, check the calendar: Date rolls February 31 into March.
  // This gets the valid-timestamp message; out-of-pattern dates (month 00 or day 32)
  // get the explicit-offset message above.
  if (!namesARealDate(Number(bound[1]), Number(bound[2]), Number(bound[3]))) {
    throw new ModerationServiceError("INVALID_INPUT", `${label} must be a valid timestamp.`);
  }
  const timestamp = new Date(value);
  // Backstop between the grammar and toISOString, which throws for an invalid Date
  // (for example, the expanded-year shape -000000).
  if (Number.isNaN(timestamp.getTime())) {
    throw new ModerationServiceError("INVALID_INPUT", `${label} must be a valid timestamp.`);
  }
  return timestamp.toISOString();
}

function namesARealDate(year: number, month: number, day: number): boolean {
  // setUTCFullYear rather than Date.UTC, which interprets years 0–99 as 1900–1999.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModerationServiceError("INVALID_INPUT", `${label} is required.`);
  }
  return value.trim();
}

function normalizeReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModerationServiceError("INVALID_INPUT", "A nonblank moderation reason is required.");
  }
  return value.trim();
}

function unwrapStoreResult<T>(result: ModerationStoreResult<T>): T {
  switch (result.kind) {
    case "ok":
      return result.value;
    case "not_found":
      throw new ModerationServiceError("NOT_FOUND", "The requested moderation record was not found.");
    case "conflict":
    case "invalid_state":
      throw new ModerationServiceError("CONFLICT", "The requested moderation transition is not available.");
  }
}
