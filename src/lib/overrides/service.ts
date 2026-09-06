import type { UserRole } from "@/lib/db/types";

export type SettlementOverrideState = "OPEN" | "GRANTED" | "DECLINED";

export type SettlementOverrideRequest = {
  id: string;
  issueId: string;
  requesterId: string;
  reason: string;
  state: SettlementOverrideState;
  settledPoints: number | null;
  decidedById: string | null;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
};

/**
 * The settlement facts a moderator needs to judge a correction request.
 *
 * Nullable as a whole because a settlement is derived state: reconciliation can
 * remove the row a request was raised against, and hiding the request in that
 * case would lose it silently.
 */
export type SettlementOverrideEvidence = {
  settlementId: string;
  status: "SETTLED" | "UNSETTLED" | "UNCLAIMED";
  openingComparisonPoints: number;
  settledLabel: string | null;
  settledPoints: number | null;
  reviewRounds: number;
  credits: number;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
};

/**
 * The self-work facts a moderator needs to judge a correction request.
 *
 * A sponsor who closes their own issue is both parties, so the fold records a
 * calibration instead of a settlement and no credits move. The figures are the
 * comparison the account is judged on, and the actual ones are absent whenever
 * the closure's settled evidence was rejected — the case a correction repairs.
 */
export type SelfWorkCalibrationOverrideEvidence = {
  calibrationId: string;
  ownerLogin: string;
  openingComparisonPoints: number;
  actualLabel: string | null;
  actualPoints: number | null;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
};

/**
 * A queued request with whichever outcome its issue was priced into.
 *
 * At most one of the two is present: an issue is materialized as a settlement
 * or as a self-work calibration, never both. Both being null means the outcome
 * was rebuilt away under the request rather than never having existed.
 */
export type OpenSettlementOverrideRequest = {
  id: string;
  reason: string;
  requestedAt: string;
  requesterLogin: string;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  settlement: SettlementOverrideEvidence | null;
  calibration: SelfWorkCalibrationOverrideEvidence | null;
};

/**
 * The row a correction request names.
 *
 * An issue's priced outcome is materialized as a settlement when someone else
 * closed it and as a self-work calibration when its sponsor closed it
 * themselves, so a request has to be able to name either. The request itself is
 * still keyed on the issue behind whichever row was named.
 */
export type SettlementOverrideTarget =
  | { kind: "settlement"; settlementId: string }
  | { kind: "calibration"; calibrationId: string };

export type SettlementOverrideStoreResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "forbidden" }
  | { kind: "conflict" };

export type SettlementOverrideDecisionInput =
  | { decision: "GRANT"; settledPoints: number; reason: string }
  | { decision: "DECLINE"; reason: string };

export type SettlementOverrideStore = {
  createRequest(input: {
    requesterId: string;
    target: SettlementOverrideTarget;
    reason: string;
  }): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>>;
  listOpenRequests(): Promise<OpenSettlementOverrideRequest[]>;
  listRequestsForSettlement(settlementId: string, viewerId: string): Promise<SettlementOverrideRequest[]>;
  listRequestsForCalibration(calibrationId: string, viewerId: string): Promise<SettlementOverrideRequest[]>;
  decideRequest(
    input: { actorId: string; requestId: string } & SettlementOverrideDecisionInput,
  ): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>>;
};

export type SettlementOverrideRequester = { id: string };
export type SettlementOverrideModerator = { id: string; role: UserRole };

export type SettlementOverrideErrorCode = "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT";

export class SettlementOverrideError extends Error {
  public constructor(
    public readonly code: SettlementOverrideErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SettlementOverrideError";
  }
}

const minimumSettledPoints = 1;
const maximumSettledPoints = 10;

/**
 * The correction loop for a settlement the ledger got wrong.
 *
 * A member raises a request against a settlement they are party to; a moderator
 * grants it with corrected settled points or declines it. Both sides require a
 * reason, so the ledger keeps the argument as well as the outcome. Nothing here
 * writes to `settlements`: a granted request is a standing correction that the
 * materializer applies every time it rebuilds that issue's settlement.
 */
export class SettlementOverrideService {
  public constructor(private readonly store: SettlementOverrideStore) {}

  public async requestOverride(
    requester: SettlementOverrideRequester,
    input: { target: SettlementOverrideTarget; reason: string },
  ): Promise<SettlementOverrideRequest> {
    return unwrap(
      await this.store.createRequest({
        requesterId: requester.id,
        target: normalizeTarget(input.target),
        reason: normalizeReason(input.reason),
      }),
      alreadyRequestedMessage,
    );
  }

  public async listOpenRequests(
    moderator: SettlementOverrideModerator,
  ): Promise<OpenSettlementOverrideRequest[]> {
    requireModerator(moderator);
    return this.store.listOpenRequests();
  }

  public async listRequestsForSettlement(
    viewer: SettlementOverrideRequester,
    settlementId: string,
  ): Promise<SettlementOverrideRequest[]> {
    return this.store.listRequestsForSettlement(
      normalizeIdentifier(settlementId, "Settlement identifier"),
      viewer.id,
    );
  }

  public async listRequestsForCalibration(
    viewer: SettlementOverrideRequester,
    calibrationId: string,
  ): Promise<SettlementOverrideRequest[]> {
    return this.store.listRequestsForCalibration(
      normalizeIdentifier(calibrationId, "Calibration identifier"),
      viewer.id,
    );
  }

  public async decideRequest(
    moderator: SettlementOverrideModerator,
    requestId: string,
    decision: SettlementOverrideDecisionInput,
  ): Promise<SettlementOverrideRequest> {
    requireModerator(moderator);
    const normalizedId = normalizeIdentifier(requestId, "Override request identifier");
    const reason = normalizeReason(decision.reason);
    if (decision.decision === "DECLINE") {
      return unwrap(
        await this.store.decideRequest({
          actorId: moderator.id,
          requestId: normalizedId,
          decision: "DECLINE",
          reason,
        }),
        alreadyDecidedMessage,
      );
    }

    return unwrap(
      await this.store.decideRequest({
        actorId: moderator.id,
        requestId: normalizedId,
        decision: "GRANT",
        settledPoints: normalizeSettledPoints(decision.settledPoints),
        reason,
      }),
      alreadyDecidedMessage,
    );
  }
}

function requireModerator(moderator: SettlementOverrideModerator): void {
  if (moderator.role !== "MODERATOR") {
    throw new SettlementOverrideError("FORBIDDEN", "Moderator authorization is required.");
  }
}

function normalizeReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SettlementOverrideError("INVALID_INPUT", "A nonblank reason is required.");
  }
  return value.trim();
}

function normalizeTarget(target: SettlementOverrideTarget): SettlementOverrideTarget {
  return target.kind === "settlement"
    ? {
        kind: "settlement",
        settlementId: normalizeIdentifier(target.settlementId, "Settlement identifier"),
      }
    : {
        kind: "calibration",
        calibrationId: normalizeIdentifier(target.calibrationId, "Calibration identifier"),
      };
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SettlementOverrideError("INVALID_INPUT", `${label} is required.`);
  }
  return value.trim();
}

function normalizeSettledPoints(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimumSettledPoints ||
    value > maximumSettledPoints
  ) {
    throw new SettlementOverrideError(
      "INVALID_INPUT",
      `Corrected settled points must be a whole number between ${minimumSettledPoints} and ${maximumSettledPoints}.`,
    );
  }
  return value;
}

const alreadyRequestedMessage = "This issue already has a correction request awaiting a moderator.";
const alreadyDecidedMessage = "This correction request has already been decided.";

/**
 * Turns a store result into a value or the error a caller should see.
 *
 * The conflict message is the caller's because the two paths that can reach
 * `conflict` mean opposite things: creating hits it when a request is still
 * open, deciding when it no longer is. One wording for both would tell the
 * moderator who just lost the race that the request still awaits them.
 */
function unwrap<T>(result: SettlementOverrideStoreResult<T>, conflictMessage: string): T {
  switch (result.kind) {
    case "ok":
      return result.value;
    case "not_found":
      throw new SettlementOverrideError(
        "NOT_FOUND",
        "No settlement, calibration or correction request was found under that identifier.",
      );
    case "forbidden":
      throw new SettlementOverrideError(
        "FORBIDDEN",
        "Only the creditor or the debtor of a settlement, or the account a self-work calibration belongs to, can report it as incorrect.",
      );
    case "conflict":
      throw new SettlementOverrideError("CONFLICT", conflictMessage);
  }
}
