import {
  CalibrationStatisticsError,
  compareCalibration,
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

  public async openAccountAudit(
    actor: ModerationActor,
    input: OpenAccountAuditInput,
  ): Promise<AccountAudit> {
    requireModerator(actor);
    const normalized = normalizeOpenInput(input);
    const loaded = await this.store.loadCalibrationCohort({
      targetAccountId: normalized.targetAccountId,
      repositoryId: normalized.repositoryId,
      sampleStartedAt: normalized.sampleStartedAt,
      sampleEndedAt: normalized.sampleEndedAt,
    });
    if (loaded === null) {
      throw new ModerationServiceError("NOT_FOUND", "The target account was not found.");
    }

    let comparison: CalibrationComparison;
    try {
      comparison = compareCalibration(loaded.selfWorkPairs, loaded.outsiderSettlementPairs);
    } catch (error) {
      if (error instanceof CalibrationStatisticsError) {
        throw new ModerationServiceError("INVALID_INPUT", "The selected calibration cohort is invalid.");
      }
      throw error;
    }
    if (comparison.selfWork.count < 10 || comparison.outsider.count < 10) {
      throw new ModerationServiceError(
        "INSUFFICIENT_SAMPLES",
        "At least ten self-work and ten outsider-settlement pairs are required.",
      );
    }

    return unwrapStoreResult(
      await this.store.openAccountAudit({
        actorId: actor.id,
        targetAccountId: normalized.targetAccountId,
        repositoryId: normalized.repositoryId,
        reason: normalized.reason,
        cohort: {
          targetAccountId: normalized.targetAccountId,
          repositoryId: normalized.repositoryId,
          sampleStartedAt: normalized.sampleStartedAt,
          sampleEndedAt: normalized.sampleEndedAt,
          selfWorkPairs: [...loaded.selfWorkPairs],
          outsiderSettlementPairs: [...loaded.outsiderSettlementPairs],
          comparison,
        },
      }),
    );
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
}

function requireModerator(actor: ModerationActor): void {
  if (actor.role !== "MODERATOR") {
    throw new ModerationServiceError("FORBIDDEN", "Moderator authorization is required.");
  }
}

function normalizeOpenInput(input: OpenAccountAuditInput): {
  targetAccountId: string;
  repositoryId: string | null;
  sampleStartedAt: string;
  sampleEndedAt: string;
  reason: string;
} {
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
    reason: normalizeReason(input.reason),
  };
}

function normalizeTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ModerationServiceError("INVALID_INPUT", `${label} must be a valid timestamp.`);
  }
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new ModerationServiceError("INVALID_INPUT", `${label} must be a valid timestamp.`);
  }
  return timestamp.toISOString();
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
