import { withFreshSweepReads, type SweepPass } from "@/lib/fold/sweep-pass";
import { readStagedRows, stagedIdentity } from "@/lib/fold/staged-pass-data";
import type { WalkSubject } from "@/lib/forge/subject-listing";
import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";
import { walkSubjectDiscardReason, type WalkDiscardReason } from "@/lib/fold/reconciliation-walk-discard";
import { visitWalkListing, type WalkListingDriver } from "@/lib/fold/reconciliation-walk-listing";
import { GitHubGraphqlInvalidResponseError } from "@/lib/github/errors";
import type { GitHubIssue, GitHubIssueReference, GitHubPullRequest, GitHubPullRequestReview, GitHubSubject } from "@/lib/github/types";

export type { WalkListingDriver } from "@/lib/fold/reconciliation-walk-listing";

export type WalkGateway = {
  /** Read the complete opening evidence and closing references, including timeline witnesses and targeted rereads. */
  gatherIssue(subject: GitHubSubject): Promise<GitHubIssue | null>;
  /** Fresh identity-checked PR read; null means definitive absence. */
  getPullRequest(subject: GitHubSubject): Promise<GitHubSubject | null>;
  getPullRequestClosingIssues(subject: GitHubSubject): Promise<GitHubIssueReference[]>;
  getPullRequestReviews(subject: GitHubSubject): Promise<GitHubPullRequestReview[]>;
  getPullRequestDiff(subject: GitHubSubject): Promise<string>;
};

export type ReconciliationWalkInput = {
  pass: SweepPass;
  listing: WalkListingDriver;
  gateway: WalkGateway;
  repository: { githubRepositoryId: number; disputePullRequests: GitHubSubject[] };
  /** fieldPath names the connection a typed invalid response failed on; it is our own constant, never upstream text. */
  onDiscard?(input: { kind: WalkSubject["kind"]; subject: GitHubSubject; reason: WalkDiscardReason; fieldPath?: string }): Promise<void>;
};

type PrEvidence = { reviews: GitHubPullRequestReview[]; rawDiff: string };
type StagedSubject = { subject: GitHubSubject };
type StagedPr = StagedSubject & { evidence: PrEvidence | null };
type RefreshedPr = StagedPr & { refreshed: true; missing: boolean; listed: boolean };
type StagedPayload = GitHubIssue | StagedSubject | StagedPr | RefreshedPr;
export type WalkIssue = Omit<GitHubIssue, "closingPullRequests"> & {
  closingPullRequests: Array<GitHubPullRequest & PrEvidence>;
};
export type CompletedReconciliationWalk = {
  status: "completed";
  issues: WalkIssue[];
  pullRequests: Array<{ id: number } & PrEvidence>;
  missingDisputePrIds: Set<number>;
};

/** A hold rejects with SweepBudgetSpent; staging remains durable and no fold is returned. */
export function walkReconciliation(input: ReconciliationWalkInput): Promise<CompletedReconciliationWalk> {
  return withFreshSweepReads(() => walk(input));
}

async function walk({ pass, listing, gateway, repository, onDiscard }: ReconciliationWalkInput): Promise<CompletedReconciliationWalk> {
  const staged = new Map((await readStagedRows(pass)).map((row) => [rowKey(row.kind, row.subjectKey), row]));
  const issues = () => [...staged.values()].flatMap((row) => row.kind === "issue" && row.payload !== null
    && typeof row.payload === "object" && "number" in row.payload ? [row.payload as GitHubIssue] : []);
  const referenced = (facts: GitHubIssue[]) => facts.flatMap((issue) => issue.closingPullRequests).filter((pr) =>
    (pr.state === "CLOSED" || (pr.state === "MERGED" && pr.mergedAt !== null)) && belongsToRegisteredRepository(repository, pr));
  const discard = async (error: unknown, kind: WalkSubject["kind"], subject: GitHubSubject, disputed = false, closing = false) => {
    const reason = walkSubjectDiscardReason(error, kind, disputed, closing);
    if (reason === null) throw error;
    await onDiscard?.({ kind, subject, reason, ...(error instanceof GitHubGraphqlInvalidResponseError && { fieldPath: error.fieldPath }) });
    return reason;
  };
  const stage = async (anchor: string, subject: WalkSubject, fact: StagedPayload) => {
    const row = { kind: subject.kind, subjectKey: subject.id, updatedAt: subject.updatedAt, payload: fact };
    await pass.stage({ anchor, ...row });
    staged.set(rowKey(row.kind, row.subjectKey), row);
  };
  const stageIssue = async (subject: GitHubSubject, anchor: string, issue: GitHubIssue | null, updatedAt?: Date) => {
    issue = sanitizeForgeStrings(issue);
    if (issue?.openingEvidenceUnreadable || issue?.closingPullRequestsUnreadable) {
      await onDiscard?.({ kind: "issue", subject, reason: "UNREADABLE_FIELD" });
    }
    await stage(anchor, { ...subject, kind: "issue", updatedAt: updatedAt ?? new Date(issue?.updatedAt ?? pass.scanStartedAt) },
      issue ?? { subject: { id: subject.id, number: subject.number } });
  };
  const gatherIssue = async (subject: GitHubSubject, anchor: string, updatedAt?: Date) => {
    let issue: GitHubIssue | null;
    try { issue = await gateway.gatherIssue(subject); }
    catch (error) { await discard(error, "issue", subject); issue = null; }
    await stageIssue(subject, anchor, issue, updatedAt);
  };
  const readEvidence = async (subject: GitHubSubject, disputed = false): Promise<{ evidence: PrEvidence | null; missing: boolean }> => {
    try {
      const reviews = sanitizeForgeStrings(await gateway.getPullRequestReviews(subject));
      const rawDiff = sanitizeForgeStrings(await gateway.getPullRequestDiff(subject));
      return { evidence: { reviews, rawDiff }, missing: false };
    } catch (error) {
      const reason = await discard(error, "pull_request", subject, disputed);
      return { evidence: null, missing: reason === "NOT_FOUND" };
    }
  };
  const gather = async (subject: WalkSubject, anchor: string) => {
    if (subject.kind === "issue") return gatherIssue(subject, anchor, subject.updatedAt);
    const affected = new Map(issues().filter((issue) => issue.closingPullRequests.some((pr) => pr.id === subject.id
      && belongsToRegisteredRepository(repository, pr))).map((issue) => [issue.id, issue] as [number, GitHubSubject]));
    try {
      for (const issue of await gateway.getPullRequestClosingIssues(subject)) {
        if (belongsToRegisteredRepository(repository, issue)) affected.set(issue.id, issue);
      }
    } catch (error) { await discard(error, "pull_request", subject, false, true); }
    // Related reads cannot move a listing anchor past subjects its stream has not visited.
    for (const issue of affected.values()) await gatherIssue(issue, "repair");
    const { evidence } = await readEvidence(subject, repository.disputePullRequests.some((pr) => pr.id === subject.id));
    await stage(anchor, subject, { subject: { id: subject.id, number: subject.number }, evidence });
  };
  await visitWalkListing(listing, pass.walkAnchors(), async (subject, anchor) => {
    const saved = pass.walkAnchors()[anchor];
    if (saved !== undefined && compareSubject(subject, saved) <= 0 && staged.has(rowKey(subject.kind, subject.id))) return;
    await gather(subject, anchor);
  });

  // Absence may restart: ceil(size/100) data pages plus boundary/tie pages and drift
  // gathers; the expensive PR refreshes retain their progress across holds below.
  // A held run restarts this listing from its first page, so a budget-bound pass
  // completes only while one run's verify, resumed walk listing and this whole listing
  // fit in its repository's share of the sweep budget; above that it walks every
  // window and never completes. Even the walk needs a share above a run's verify and
  // first listing page, which are spent before anything stages.
  const listed = new Map<string, WalkSubject>();
  await visitWalkListing(listing, {}, async (subject) => {
    const key = rowKey(subject.kind, subject.id), previous = listed.get(key);
    if (previous === undefined || previous.updatedAt <= subject.updatedAt) listed.set(key, subject);
  });
  const refreshTargets = new Set([...referenced(issues().filter((issue) => listed.has(rowKey("issue", issue.id)))),
    ...repository.disputePullRequests].map(({ id }) => id));
  // References/disputes may name an unlisted PR; retain its completed refresh outcome for resume.
  const omitted = [...staged.values()].filter((row) => !listed.has(rowKey(row.kind, row.subjectKey))
    && !(row.kind === "pull_request" && refreshTargets.has(row.subjectKey) && isRefreshedPr(row.payload) && !row.payload.listed));
  const absent: typeof omitted = [];
  // The rare pagination-drift set costs one fresh, kind-aware lookup per omitted row.
  for (const row of omitted) {
    const subject = stagedIdentity(row.payload);
    let fact: GitHubIssue | GitHubSubject | null;
    try {
      fact = row.kind === "issue" ? await gateway.gatherIssue(subject) : await gateway.getPullRequest(subject);
    } catch (error) {
      if (walkSubjectDiscardReason(error, row.kind, true, false) !== "NOT_FOUND") throw error;
      fact = null;
    }
    if (fact === null) { absent.push(row); continue; }
    const observed: WalkSubject = { ...subject, kind: row.kind,
      updatedAt: row.kind === "issue" ? new Date((fact as GitHubIssue).updatedAt) : row.updatedAt };
    if (row.kind === "issue") await stageIssue(subject, "repair", fact as GitHubIssue);
    else await gather(observed, "repair");
    listed.set(rowKey(row.kind, row.subjectKey), observed);
  }
  await pass.deleteStaged(absent.map(({ kind, subjectKey }) => ({ kind, subjectKey })));
  for (const row of absent) staged.delete(rowKey(row.kind, row.subjectKey));
  for (const [key, subject] of listed) {
    const previous = staged.get(key);
    if (previous === undefined || previous.updatedAt < subject.updatedAt) await gather(subject, "repair");
  }
  const retained = new Map([...referenced(issues()), ...repository.disputePullRequests].map((pr) => [pr.id, pr]));
  const refreshSubjects: WalkSubject[] = [...retained.values()].map((pr) => ({ ...pr, kind: "pull_request",
    updatedAt: listed.get(rowKey("pull_request", pr.id))?.updatedAt ?? pass.scanStartedAt }));
  refreshSubjects.sort((left, right) => compareSubject(left, { updatedAt: right.updatedAt, key: right.id }));
  const evidence = new Map<number, PrEvidence>();
  const missingDisputePrIds = new Set<number>();
  for (const pr of refreshSubjects) {
    const anchor = pass.walkAnchors().refresh;
    const previous = staged.get(rowKey("pull_request", pr.id))?.payload;
    let refreshed: RefreshedPr;
    if (anchor !== undefined && compareSubject(pr, anchor) <= 0 && isRefreshedPr(previous)) {
      refreshed = previous;
    } else {
      refreshed = { subject: { id: pr.id, number: pr.number }, refreshed: true, listed: listed.has(rowKey("pull_request", pr.id)),
        ...await readEvidence(retained.get(pr.id)!, repository.disputePullRequests.some((dispute) => dispute.id === pr.id)) };
      await stage("refresh", pr, refreshed);
    }
    if (refreshed.evidence !== null) evidence.set(pr.id, refreshed.evidence);
    if (refreshed.missing && repository.disputePullRequests.some((dispute) => dispute.id === pr.id)) missingDisputePrIds.add(pr.id);
  }
  return {
    status: "completed",
    issues: issues().map((issue) => ({ ...issue, closingPullRequests: issue.closingPullRequests.map((pr) => ({
      ...pr, reviews: evidence.get(pr.id)?.reviews ?? [], rawDiff: evidence.get(pr.id)?.rawDiff ?? "",
    })) })),
    pullRequests: [...evidence].map(([id, value]) => ({ id, ...value })), missingDisputePrIds,
  };
}

function rowKey(kind: WalkSubject["kind"], id: number): string { return `${kind}:${id}`; }
function isRefreshedPr(payload: unknown): payload is RefreshedPr {
  return payload !== null && typeof payload === "object" && "refreshed" in payload && payload.refreshed === true;
}
function compareSubject(subject: WalkSubject, anchor: { updatedAt: Date; key: number }): number {
  return +subject.updatedAt - +anchor.updatedAt || subject.id - anchor.key;
}
