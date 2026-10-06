import type { EnforcementState } from "@/lib/db/types";

/**
 * The sanction half of the disputes framework (issue 1125): a sanctioned
 * account asks for its sanction to be contested, and a moderator decides.
 *
 * The store refuses anything but the account's live sanction — a contest
 * targets the sanction the account is under now, not one history recorded —
 * and the filing is itself a moderation event, linked back to the request
 * through moderation_events' contest_request_id column, with the sanction's
 * state on both sides so the fold's participation history is unchanged by it.
 *
 * The deciding half lives beside it here: the store enforces the
 * deciding-moderator rule server-side (the imposer decides only where no
 * other live moderator exists, and the row records a sole-moderator
 * decision), and a decision writes its own moderation event. A decision does
 * NOT move enforcement_state: granting a contest is recorded, not executed —
 * what a grant does to the sanction is unspecified by the ruling, and the
 * ban reversals remain the paths that change it.
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
  | { kind: "invalid_state" }
  | { kind: "already_decided" }
  | { kind: "forbidden_imposer" }
  | { kind: "invalid_input" };

export type SanctionContestStore = {
  fileSanctionContest(input: {
    accountId: string;
    sanctionEventId: string;
    reason: string;
  }): Promise<SanctionContestStoreResult<SanctionContestRequest>>;
  decideSanctionContest(input: {
    requestId: string;
    moderatorAccountId: string;
    decision: SanctionContestDecision;
    decidedReason: string;
  }): Promise<SanctionContestStoreResult<SanctionContestRequest>>;
  listRequestsForAccount(accountId: string): Promise<SanctionContestRequest[]>;
  listFileableSanctions(accountId: string): Promise<FileableSanction[]>;
  listOpenContestRequests(): Promise<OpenContestRequestProjection[]>;
};

/**
 * One OPEN contest request, as the moderation queue's section renders it.
 * Declared beside the request types because the store reads it and the
 * moderation page renders it.
 */
export type OpenContestRequestProjection = {
  requestId: string;
  accountId: string;
  accountLogin: string;
  sanctionState: EnforcementState;
  requestReason: string;
  filedAt: string;
};

export type SanctionContestErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT" | "FORBIDDEN";

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
 * The disputes loop for the sanction case: the signed-in account files
 * against one of its own live sanctions, reads back its own requests, and a
 * moderator decides an open one — GRANTED or DENIED, with a reason, under the
 * deciding-moderator rule the store enforces.
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

  /**
   * The deciding half: a moderator records GRANTED or DENIED with a nonblank
   * reason. The deciding-moderator rule is the store's, enforced against the
   * database — the service carries the refusal out as FORBIDDEN.
   */
  public async decideContest(
    moderator: { id: string },
    input: { requestId: string; decision: SanctionContestDecision; reason: string },
  ): Promise<SanctionContestRequest> {
    const requestId = normalizeIdentifier(input.requestId, "Contest request identifier");
    const decision = input.decision;
    if (decision !== "GRANTED" && decision !== "DENIED") {
      throw new SanctionContestError("INVALID_INPUT", "Decision must be GRANTED or DENIED.");
    }
    const reason = normalizeReason(input.reason);
    return unwrap(
      await this.store.decideSanctionContest({
        moderatorAccountId: moderator.id,
        requestId,
        decision,
        decidedReason: reason,
      }),
    );
  }

  /** The account's own requests, open and decided, newest first. */
  public async listContests(account: { id: string }): Promise<SanctionContestRequest[]> {
    return this.store.listRequestsForAccount(account.id);
  }

  /** The OPEN requests, oldest first — the moderation queue's read. */
  public async listOpenContests(): Promise<OpenContestRequestProjection[]> {
    return this.store.listOpenContestRequests();
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
 * Turns a store result into a value or the error a caller should see.
 *
 * The one conflict message covers every invalid_state the filing store
 * returns — a request against a sanction that is not the account's live one,
 * and a second open request on a sanction that is — because from the filing
 * side they read the same: this sanction cannot be contested right now. The
 * decision path's own state refusal is its own cause: an already-decided
 * request carries the already-decided message, which is what a moderator
 * double-deciding needs to read.
 *
 * forbidden_imposer is its own answer, not a conflict: the deciding moderator
 * is barred by the disputes rule, not by the request's state.
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
    case "already_decided":
      throw new SanctionContestError("CONFLICT", "This contest request has already been decided.");
    case "forbidden_imposer":
      throw new SanctionContestError(
        "FORBIDDEN",
        "The moderator who imposed the sanction may not decide its contest while another moderator can.",
      );
    case "invalid_input":
      throw new SanctionContestError("INVALID_INPUT", "A nonblank decision reason is required.");
  }
}
