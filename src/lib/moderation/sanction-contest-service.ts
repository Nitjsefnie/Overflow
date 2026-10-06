import type { EnforcementState } from "@/lib/db/types";

/**
 * The sanction half of the disputes framework (issue 1125): a sanctioned
 * account asks for its sanction to be contested, and a moderator decides.
 *
 * Task 2 lands the decision path; this module is the sanctioned side. The
 * store refuses anything but the account's live sanction — a contest targets
 * the sanction the account is under now, not one history recorded — and the
 * filing is itself a moderation event, linked back to the request through
 * moderation_events' contest_request_id column, with the sanction's state on
 * both sides so the fold's participation history is unchanged by it.
 *
 * The one-open-per-sanction rule is the database's, not this service's: the
 * partial unique index sanction_contest_requests_one_open_per_sanction
 * (migration 061) decides, the way the settlement case's one-open rule is held
 * by its own index (migration 009). The store maps the index's violation onto
 * the same invalid_state result every other refusal of a non-live sanction
 * carries.
 */

/** The request states: open until a moderator decides it. */
export type SanctionContestState = "OPEN" | "DECIDED";

/** The outcomes a decision records. Task 2 writes them; the store reads them. */
export type SanctionContestDecision = "GRANTED" | "DENIED";

export type SanctionContestRequest = {
  id: string;
  accountId: string;
  sanctionEventId: string;
  requestReason: string;
  state: SanctionContestState;
  decision: SanctionContestDecision | null;
  decidedBy: string | null;
  decidedBySoleModerator: boolean;
  decidedReason: string | null;
  decidedAt: string | null;
  createdAt: string;
};

/**
 * A sanction the account could file against right now: the enforcement state
 * it is living under is that event's own state, and that state is a sanction.
 * The page offers these as the form's choices, newest first — repeated
 * entries into the same state can leave several, and each is a live sanction
 * the account can name.
 */
export type FileableSanction = {
  id: string;
  newState: EnforcementState;
  reason: string;
  occurredAt: string;
};

export type SanctionContestStoreResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "invalid_state" };

export type SanctionContestStore = {
  fileSanctionContest(input: {
    accountId: string;
    sanctionEventId: string;
    reason: string;
  }): Promise<SanctionContestStoreResult<SanctionContestRequest>>;
  listRequestsForAccount(accountId: string): Promise<SanctionContestRequest[]>;
  listFileableSanctions(accountId: string): Promise<FileableSanction[]>;
};

export type SanctionContestErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT";

export class SanctionContestError extends Error {
  public constructor(
    public readonly code: SanctionContestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SanctionContestError";
  }
}

/**
 * The filing loop for the sanction case: the signed-in account files against
 * one of its own live sanctions, with a reason, and reads back its own
 * requests. Nothing here moderates — Task 2's decision path owns that half.
 */
export class SanctionContestService {
  public constructor(private readonly store: SanctionContestStore) {}

  public async fileSanctionContest(
    account: { id: string },
    input: { sanctionEventId: string; reason: string },
  ): Promise<SanctionContestRequest> {
    const sanctionEventId = normalizeIdentifier(input.sanctionEventId, "Sanction event identifier");
    const reason = normalizeReason(input.reason);
    return unwrap(
      await this.store.fileSanctionContest({
        accountId: account.id,
        sanctionEventId,
        reason,
      }),
    );
  }

  /** The account's own requests, open and decided, newest first. */
  public async listContests(account: { id: string }): Promise<SanctionContestRequest[]> {
    return this.store.listRequestsForAccount(account.id);
  }

  /** The account's live sanctions, as the filing form's candidates. */
  public async listFileableSanctions(account: { id: string }): Promise<FileableSanction[]> {
    return this.store.listFileableSanctions(account.id);
  }
}

function normalizeIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SanctionContestError("INVALID_INPUT", `${label} is required.`);
  }
  return value.trim();
}

function normalizeReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SanctionContestError("INVALID_INPUT", "A nonblank reason is required.");
  }
  return value.trim();
}

/**
 * Turns a store result into a value or the error a caller should see. The one
 * conflict message covers every invalid_state the store returns — a request
 * against a sanction that is not the account's live one, and a second open
 * request on a sanction that is — because from the filing side they read the
 * same: this sanction cannot be contested right now.
 */
function unwrap<T>(result: SanctionContestStoreResult<T>): T {
  switch (result.kind) {
    case "ok":
      return result.value;
    case "not_found":
      throw new SanctionContestError(
        "NOT_FOUND",
        "No such account or sanction event.",
      );
    case "invalid_state":
      throw new SanctionContestError("CONFLICT", "This sanction cannot be contested right now.");
  }
}
