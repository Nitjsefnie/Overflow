import type { GitHubPullRequestReview } from "@/lib/github/types";
import { reasonText } from "@/lib/validation/reason";
import { z } from "zod";

export type ClosedPrDisputeState = "OPEN" | "DECIDED";
export type ClosedPrDisputeDecision = "GRANTED" | "DENIED";

export type ClosedPrDisputePullRequest = {
  number: number; title: string; url: string;
  reviews: GitHubPullRequestReview[] | null;
  rawDiff: string | null;
};
export type ClosedPrDisputeComparison = {
  closedPullRequest: ClosedPrDisputePullRequest;
  landedPullRequest: ClosedPrDisputePullRequest | null;
  landedCommitUrl: string | null;
};

export type ClosedPrDisputeRequest = {
  /** Stored comparison evidence is projected for the moderation queue. */
  comparison?: ClosedPrDisputeComparison;
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

export const closedPrDisputeDecisionSchema = z.object({
  decision: z.enum(["GRANTED", "DENIED"]),
  figure: z.number().int().min(1).max(10).optional(),
  decidedReason: reasonText(),
}).refine((input) => input.decision !== "GRANTED" || input.figure !== undefined);

export type ClosedPrDisputeDecisionInput = z.input<typeof closedPrDisputeDecisionSchema>;

export type ClosedPrDisputeStoreResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: "invalid_state" }
  | { kind: "already_decided" }
  | { kind: "already_granted" }
  | { kind: "issue_already_credited" }
  | { kind: "forbidden_imposer" }
  | { kind: "insufficient_evidence" }
  | { kind: "forbidden" }
  | { kind: "invalid_input" };

export type ClosedPrDisputeStore = {
  fileDispute(input: ClosedPrDisputeFilingInput & { accountId: string }): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>>;
  decideDispute(input: ClosedPrDisputeDecisionInput & {
    requestId: string; moderatorAccountId: string;
  }): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>>;
  listRequestsForAccount(accountId: string): Promise<ClosedPrDisputeRequest[]>;
  listRequestsForModeration(): Promise<ClosedPrDisputeRequest[]>;
};

export type ClosedPrDisputeErrorCode = "NOT_FOUND" | "CONFLICT" | "ALREADY_GRANTED" | "INVALID_INPUT" | "FORBIDDEN" | "INSUFFICIENT_EVIDENCE";

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

  public async decideDispute(
    requestId: string,
    moderator: { id: string },
    input: ClosedPrDisputeDecisionInput,
  ): Promise<ClosedPrDisputeRequest> {
    const id = normalizeText(requestId, "Dispute request identifier");
    const parsed = closedPrDisputeDecisionSchema.safeParse(input);
    if (!parsed.success) {
      throw new ClosedPrDisputeError("INVALID_INPUT", "A decision, bounded reason and grant figure from 1 to 10 are required.");
    }
    return unwrap(await this.store.decideDispute({ ...parsed.data, requestId: id, moderatorAccountId: moderator.id }));
  }

  /** With an account, its history; without one, the moderation queue and decided history. */
  public async listDisputes(account?: { id: string }): Promise<ClosedPrDisputeRequest[]> {
    return account === undefined ? this.store.listRequestsForModeration() : this.store.listRequestsForAccount(account.id);
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
      throw new ClosedPrDisputeError("NOT_FOUND", "No such account or dispute request.");
    case "invalid_state":
      throw new ClosedPrDisputeError("CONFLICT", "This pull request cannot be disputed right now.");
    case "forbidden":
      throw new ClosedPrDisputeError("FORBIDDEN", "This account may not perform this dispute action.");
    case "forbidden_imposer":
      throw new ClosedPrDisputeError("FORBIDDEN", "A sponsor, contributor or landing author may not decide while another moderator can.");
    case "already_decided":
      throw new ClosedPrDisputeError("CONFLICT", "This dispute request has already been decided.");
    case "issue_already_credited":
      throw new ClosedPrDisputeError("CONFLICT", "this issue has already been credited through a granted dispute");
    case "already_granted":
      throw new ClosedPrDisputeError("ALREADY_GRANTED", "this issue has already been credited through a granted dispute");
    case "insufficient_evidence":
      throw new ClosedPrDisputeError("INSUFFICIENT_EVIDENCE", "Stored review evidence is required to grant this dispute.");
    case "invalid_input":
      throw new ClosedPrDisputeError("INVALID_INPUT", "Invalid dispute input.");
  }
}
