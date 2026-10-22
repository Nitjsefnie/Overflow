import { reasonText } from "@/lib/validation/reason";

export type ClosedPrDisputeState = "OPEN" | "DECIDED";
export type ClosedPrDisputeDecision = "GRANTED" | "DENIED";

export type ClosedPrDisputeRequest = {
  id: string;
  contributorId: string;
  pullRequestId: string;
  issueId: string;
  landedPullRequestId: string | null;
  landedCommitUrl: string | null;
  requestReason: string;
  state: ClosedPrDisputeState;
  decision: ClosedPrDisputeDecision | null;
  decidedBy: string | null;
  decidedBySoleModerator: boolean;
  decidedReason: string | null;
  decidedAt: string | null;
  moderatorFigure: number | null;
  awardedPoints: number | null;
  createdAt: string;
};

export type ClosedPrDisputeFilingInput = {
  pullRequestId: string;
  reason: string;
  landedPullRequestUrl?: string;
  landedCommitUrl?: string;
};

export type ClosedPrDisputeStoreResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "invalid_state" }
  | { kind: "forbidden" }
  | { kind: "invalid_input" };

export type ClosedPrDisputeStore = {
  fileDispute(input: ClosedPrDisputeFilingInput & { accountId: string }): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>>;
  listRequestsForAccount(accountId: string): Promise<ClosedPrDisputeRequest[]>;
};

export type ClosedPrDisputeErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID_INPUT" | "FORBIDDEN";

export class ClosedPrDisputeError extends Error {
  public constructor(
    public readonly code: ClosedPrDisputeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ClosedPrDisputeError";
  }
}

export class ClosedPrDisputeService {
  public constructor(private readonly store: ClosedPrDisputeStore) {}

  public async fileDispute(
    account: { id: string },
    input: ClosedPrDisputeFilingInput,
  ): Promise<ClosedPrDisputeRequest> {
    const pullRequestId = normalizeText(input.pullRequestId, "Pull request identifier");
    const reason = reasonText().safeParse(input.reason);
    if (!reason.success) {
      throw new ClosedPrDisputeError("INVALID_INPUT", "A nonblank reason of at most 2000 characters is required.");
    }
    return unwrap(await this.store.fileDispute({
      accountId: account.id,
      pullRequestId,
      reason: reason.data,
      landedPullRequestUrl: input.landedPullRequestUrl === undefined
        ? undefined : normalizeText(input.landedPullRequestUrl, "Landed pull request URL"),
      landedCommitUrl: input.landedCommitUrl === undefined
        ? undefined : normalizeText(input.landedCommitUrl, "Landed commit URL"),
    }));
  }

  /** The contributor's own requests, open and decided, newest first. */
  public async listDisputes(account: { id: string }): Promise<ClosedPrDisputeRequest[]> {
    return this.store.listRequestsForAccount(account.id);
  }
}

function normalizeText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClosedPrDisputeError("INVALID_INPUT", `${label} is required.`);
  }
  return value.trim();
}

function unwrap<T>(result: ClosedPrDisputeStoreResult<T>): T {
  switch (result.kind) {
    case "ok":
      return result.value;
    case "not_found":
      throw new ClosedPrDisputeError("NOT_FOUND", "No such account.");
    case "invalid_state":
      throw new ClosedPrDisputeError("CONFLICT", "This pull request cannot be disputed right now.");
    case "forbidden":
      throw new ClosedPrDisputeError("FORBIDDEN", "Only the stored author may dispute this pull request.");
    case "invalid_input":
      throw new ClosedPrDisputeError("INVALID_INPUT", "Provide one landed evidence source unless the issue already has a merged pull request.");
  }
}
