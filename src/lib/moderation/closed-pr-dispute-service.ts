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
  landedCommitAuthorId: string | null;
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
  pullRequestId?: string;
  pullRequestUrl?: string;
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

const filingRefusals = {
  repository_not_registered: ["CONFLICT", "The pull request repository is not registered with Overflow."],
  pull_request_not_found: ["CONFLICT", "The pull request is not recorded with Overflow."],
  unresolved_pull_request: ["CONFLICT", "The pull request URL could not be resolved on the forge."],
  pull_request_not_closed: ["CONFLICT", "The pull request is not closed."],
  pull_request_merged: ["CONFLICT", "The pull request has already been merged."],
  not_pull_request_author: ["FORBIDDEN", "The pull request was not authored by this account."],
  unlinked_pull_request_author: ["FORBIDDEN", "The pull request author has no linked Overflow account."],
  landing_required: ["INVALID_INPUT", "A landed pull request URL or commit URL is required."],
  landing_not_recorded: ["INVALID_INPUT", "The landed pull request URL does not resolve to a recorded merged pull request."],
  landing_issue_missing: ["CONFLICT", "The landed pull request has no recorded issue."],
  pull_request_issue_missing: ["CONFLICT", "The closed pull request has no recorded issue."],
  commit_landing_without_issue: ["INVALID_INPUT", "A commit URL cannot identify an issue for an unrecorded pull request; supply a landed pull request URL."],
  conflicting_landing_evidence: ["INVALID_INPUT", "Supply only one landing evidence URL."],
  automatic_landing_exists: ["INVALID_INPUT", "A merged pull request is already recorded for this issue; leave the landing evidence URLs blank."],
  dispute_already_open: ["CONFLICT", "This pull request already has an open dispute."],
} as const satisfies Record<string, readonly [ClosedPrDisputeErrorCode, string]>;

export type ClosedPrDisputeFilingRefusal = keyof typeof filingRefusals;

export type ClosedPrDisputeStoreResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_found" }
  | { kind: ClosedPrDisputeFilingRefusal }
  | { kind: "already_decided" }
  | { kind: "already_granted" }
  | { kind: "issue_already_credited" }
  | { kind: "forbidden_imposer" }
  | { kind: "insufficient_evidence" }
  | { kind: "forbidden" }
  | { kind: "invalid_input" }
  | { kind: "unresolved_commit_author" }
  | { kind: "unlinked_commit_author" };

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
    if ((input.pullRequestId === undefined) === (input.pullRequestUrl === undefined)) {
      throw new ClosedPrDisputeError("INVALID_INPUT", "Supply a pull request URL or identifier.");
    }
    const pullRequestId = input.pullRequestId === undefined ? undefined : normalizeText(input.pullRequestId, "Pull request identifier");
    const pullRequestUrl = input.pullRequestUrl === undefined ? undefined : normalizeText(input.pullRequestUrl, "Pull request URL");
    const reason = reasonText().safeParse(input.reason);
    if (!reason.success) {
      throw new ClosedPrDisputeError("INVALID_INPUT", "A nonblank reason of at most 2000 characters is required.");
    }
    return unwrap(await this.store.fileDispute({
      accountId: account.id,
      pullRequestId,
      pullRequestUrl,
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
  if (result.kind in filingRefusals) {
    const [code, message] = filingRefusals[result.kind as ClosedPrDisputeFilingRefusal];
    throw new ClosedPrDisputeError(code, message);
  }
  switch (result.kind) {
    case "ok":
      return result.value;
    case "not_found":
      throw new ClosedPrDisputeError("NOT_FOUND", "No such account or dispute request.");
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
    case "unresolved_commit_author":
      throw new ClosedPrDisputeError("CONFLICT", "The landed commit could not be resolved to its author.");
    case "unlinked_commit_author":
      throw new ClosedPrDisputeError("CONFLICT", "The landed commit author has no linked Overflow account.");
    case "invalid_input":
      throw new ClosedPrDisputeError("INVALID_INPUT", "Invalid dispute input.");
    default:
      throw new Error("Unknown dispute result.");
  }
}
