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
};

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
    settlementId: string;
    reason: string;
  }): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>>;
  listOpenRequests(): Promise<OpenSettlementOverrideRequest[]>;
  listRequestsForSettlement(settlementId: string, viewerId: string): Promise<SettlementOverrideRequest[]>;
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
    input: { settlementId: string; reason: string },
  ): Promise<SettlementOverrideRequest> {
    return unwrap(
      await this.store.createRequest({
        requesterId: requester.id,
        settlementId: normalizeIdentifier(input.settlementId, "Settlement identifier"),
        reason: normalizeReason(input.reason),
      }),
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

function unwrap<T>(result: SettlementOverrideStoreResult<T>): T {
  switch (result.kind) {
    case "ok":
      return result.value;
    case "not_found":
      throw new SettlementOverrideError("NOT_FOUND", "The settlement correction request was not found.");
    case "forbidden":
      throw new SettlementOverrideError(
        "FORBIDDEN",
        "Only the creditor or the debtor of a settlement can report it as incorrect.",
      );
    case "conflict":
      throw new SettlementOverrideError(
        "CONFLICT",
        "This settlement already has a correction request awaiting a moderator.",
      );
  }
}
