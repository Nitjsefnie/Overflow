import { reconciliationBudgetHoldUntil, type ReconciliationBudgetDependencies } from "@/lib/fold/reconciliation-budget";
import type { GitHubIssueListOptions } from "@/lib/github/client";
import { DEFAULT_GRAPHQL_BUDGET_RESERVE, type GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";
import { mapWithConcurrency } from "@/lib/async/map-with-concurrency";
import { isGitHubRateLimitError } from "@/lib/github/errors";
import { GraphqlBudgetHeld, withGraphqlRequestBudget } from "@/lib/github/graphql-request-budget";
import { withGraphqlFoldCost } from "@/lib/github/graphql-cost";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import type { ReconciliationCostCharge, ReconciliationFairnessAssessment } from "@/lib/fold/reconciliation-fairness";
import {
  RECONCILIATION_EVIDENCE_FORMAT,
  type DirtyReconciliationSubject,
  type ReconciliationEvidence,
  type ReconciliationSynchronization,
} from "@/lib/fold/reconciliation-evidence";
import { foldRepository, type FoldResult, type FoldUser, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type {
  GitHubIssue,
  GitHubIssueReference,
  GitHubSubject,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubRepository,
  GitHubRepositoryReference,
} from "@/lib/github/types";

// Cap this reconciliation at four HTTP requests: each PR worker paginates
// reviews, then dismissals, then fetches its diff, one request at a time.
const reconciliationConcurrency = 4;
const reconciliationOverlapMs = 60_000;
const reconciliationFullRepairMs = 6 * 60 * 60_000;

// A large repository can exhaust an hourly GitHub budget; without retry guidance,
// allow a full hour for it to recover before spending points on another full fold.
export const DEFAULT_RECONCILIATION_COOLDOWN_SECONDS = 60 * 60;

// Reconciliation resolves the registered repository by the identity GitHub cannot
// reassign, and so does the fold: the snapshot repository carries it, so there is
// one declaration of where the registered identity lives rather than two.
export type ReconciliationRepository = RepositoryFoldSnapshot["repository"];

export type RepositoryUnavailableReason = "NOT_FOUND" | "NOT_PUBLIC" | "IDENTITY_MISMATCH";

export type ReconciliationGateway = {
  getRepositoryById(githubRepositoryId: number): Promise<GitHubRepository | null>;
  listIssues(repository: GitHubRepositoryReference, options?: GitHubIssueListOptions): Promise<GitHubIssue[]>;
  getIssue(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssue | null>;
  getPullRequestClosingIssues(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssueReference[]>;
  getPullRequestReviews(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]>;
  getPullRequestDiff(repository: GitHubRepositoryReference, pullRequestNumber: number): Promise<string>;
};

export type ReconciliationDeltas = {
  adds: number;
  changes: number;
  removals: number;
};

export type ReconciliationStore = {
  withRepositoryReconciliation<T>(repositoryId: string, work: () => Promise<T>): Promise<T>;
  getRepository(repositoryId: string): Promise<ReconciliationRepository | null>;
  assessReconciliationFairness(input: {
    repositoryId: string;
    sponsorId: string;
    budget: GitHubGraphqlBudgetAssessment;
    now: Date;
  }): Promise<ReconciliationFairnessAssessment>;
  getReconciliationEvidence(repositoryId: string): Promise<ReconciliationEvidence | null>;
  getDirtyReconciliationSubjects(repositoryId: string): Promise<DirtyReconciliationSubject[]>;
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
  setReconciliationCooldown(repositoryId: string, notBefore: Date | null): Promise<void>;
  getGitHubAccessToken(userId: string): Promise<string | null>;
  findUsersByGitHubUserIds(githubUserIds: readonly number[]): Promise<FoldUser[]>;
  hasDerivedRowsBelowFoldRevision(repositoryId: string, revision: number): Promise<boolean>;
  beginRun(repositoryId: string, options?: { rederivation: boolean }): Promise<string>;
  completeRun(runId: string): Promise<void>;
  materialize(input: { repositoryId: string; runId: string; fold: FoldResult; synchronization?: ReconciliationSynchronization; cost?: ReconciliationCostCharge }): Promise<ReconciliationDeltas>;
  failRun(runId: string, errorMessage: string): Promise<void>;
  recordVerifiedRepositoryIdentity(input: {
    repositoryId: string;
    ownerName: string;
    visibility: "PUBLIC";
  }): Promise<void>;
  markRepositoryUnavailable(input: {
    repositoryId: string;
    reason: RepositoryUnavailableReason;
    at: Date;
  }): Promise<void>;
};

export type ReconciliationDependencies = ReconciliationBudgetDependencies & {
  store: ReconciliationStore;
  github: ReconciliationGateway;
  now?: () => Date;
};

export type ReconciliationSummary = ReconciliationDeltas & {
  repositoryId: string;
  added: number;
  changed: number;
  removed: number;
} & ({ skipped: false; runId: string } | { skipped: true; runId: null; budgetHeldUntil?: Date; fairnessHeldUntil?: Date });

export async function reconcileRepository(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
  options?: { rederive?: boolean },
): Promise<ReconciliationSummary> {
  return dependencies.store.withRepositoryReconciliation(
    repositoryId,
    () => reconcileRepositoryWhileCoordinated(dependencies, repositoryId, options),
  );
}

async function reconcileRepositoryWhileCoordinated(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
  options?: { rederive?: boolean },
): Promise<ReconciliationSummary> {
  const repository = await dependencies.store.getRepository(repositoryId);
  if (repository === null) {
    throw new Error("Repository was not found.");
  }

  const now = dependencies.now ?? (() => new Date());
  const notBefore = await dependencies.store.getReconciliationCooldown(repositoryId);
  // Read under the repository lock so a queued webhook sees the previous run's cooldown.
  if (notBefore !== null && notBefore.getTime() > now().getTime()) {
    return { repositoryId, runId: null, skipped: true, adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
  }

  // The repository lock and sponsor identity scope admission for every fold caller.
  const admissionAt = now();
  const captured: { assessment: GitHubGraphqlBudgetAssessment } = {
    assessment: { state: "UNKNOWN", reading: null, reserve: DEFAULT_GRAPHQL_BUDGET_RESERVE },
  };
  const budgetHeldUntil = repository.active
    ? reconciliationBudgetHoldUntil(dependencies, repository.sponsor.id, () => admissionAt,
      (assessment) => { captured.assessment = assessment; }) : null;
  if (budgetHeldUntil !== null) {
    return { repositoryId, runId: null, skipped: true, budgetHeldUntil,
      adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
  }

  let fairnessAvailable = false;
  try {
    const { state, reading, reserve } = captured.assessment;
    fairnessAvailable = repository.active && state === "AVAILABLE" && reading !== null
      && Number.isFinite(reading.remaining) && reading.remaining >= 0
      && Number.isFinite(reserve) && reserve >= 0
      && Number.isFinite(new Date(reading.observedAt.getTime()).getTime())
      && Number.isFinite(new Date(reading.resetAt.getTime()).getTime())
      && reading.resetAt.getTime() > admissionAt.getTime();
  } catch {
    // An unreadable observation cannot turn fail-open admission into a retry.
  }
  if (fairnessAvailable) {
    const assessment = await dependencies.store.assessReconciliationFairness({
      repositoryId, sponsorId: repository.sponsor.id, budget: captured.assessment, now: admissionAt,
    });
    if (assessment.state === "HELD" && assessment.holdUntil instanceof Date
      && Number.isFinite(assessment.holdUntil.getTime()) && assessment.holdUntil.getTime() > admissionAt.getTime()) {
      return { repositoryId, runId: null, skipped: true, fairnessHeldUntil: assessment.holdUntil,
        adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
    }
  }

  const rederive = options?.rederive === true
    || await dependencies.store.hasDerivedRowsBelowFoldRevision(repositoryId, FOLD_REVISION);
  const runId = await dependencies.store.beginRun(repositoryId, { rederivation: rederive });
  try {
    if (!repository.active) {
      await dependencies.store.completeRun(runId);
      await dependencies.store.setReconciliationCooldown(repositoryId, null);
      return noDeltaSummary(repositoryId, runId);
    }

    const collected = await withGraphqlFoldCost<ReconciliationSummary>(async (readCost) => {
      const accessToken = await dependencies.store.getGitHubAccessToken(repository.sponsor.id);
      if (accessToken === null) {
        throw new Error("GitHub access token was not available.");
      }

      // Advance to scan start only after successful materialization. Completion
      // time could skip changes made while these upstream reads were in flight.
      const scanStartedAt = now();
      const [cached, dirtySubjects] = await Promise.all([
        dependencies.store.getReconciliationEvidence(repositoryId),
        dependencies.store.getDirtyReconciliationSubjects(repositoryId),
      ]);
      const full = cached === null || cached.formatVersion !== RECONCILIATION_EVIDENCE_FORMAT || rederive
        || scanStartedAt.getTime() - cached.lastFullPassAt.getTime() >= reconciliationFullRepairMs;

      // The stored path is a display name GitHub reassigns to whoever takes it after a
      // rename or transfer, so every read below is aimed by the numeric identity instead.
      const verified = await dependencies.github.getRepositoryById(repository.githubRepositoryId);
      if (verified === null) {
        return declineCrawl(dependencies, repositoryId, runId, "NOT_FOUND", now());
      }
      // GitHub answering for an id other than the one asked for should be impossible;
      // decline rather than materialize whatever it did answer with.
      if (verified.id !== repository.githubRepositoryId) {
        return declineCrawl(dependencies, repositoryId, runId, "IDENTITY_MISMATCH", now());
      }
      // Only public repositories can be registered, and one that stopped being public
      // stops being crawled. This is nearly unobservable in production: the sponsor's
      // token carries only `admin:repo_hook`, so a repository that went private answers 404
      // and lands in NOT_FOUND above. The branch is kept for a broader-scoped token,
      // where materializing a private repository would be worse than declining.
      if (verified.visibility !== "PUBLIC") {
        return declineCrawl(dependencies, repositoryId, runId, "NOT_PUBLIC", now());
      }

      await dependencies.store.recordVerifiedRepositoryIdentity({
        repositoryId,
        ownerName: verified.fullName,
        visibility: verified.visibility,
      });
      const reference: GitHubRepositoryReference = { owner: verified.owner, name: verified.name };
      const { githubIssues, pullRequestEvidence } = await withGraphqlRequestBudget(
        () => reconciliationBudgetHoldUntil(dependencies, repository.sponsor.id, now),
        async () => {
          const changed = new Map((await dependencies.github.listIssues(reference, {
            ...(full ? {} : { since: new Date(cached!.checkpoint.getTime() - reconciliationOverlapMs).toISOString() }),
            timelineCriticalLabels: new Set(repository.difficultyScheme.actualLabels.map(({ label }) => label)),
            timelineWatchedLabels: new Set(repository.difficultyScheme.openingLabels.map(({ label }) => label)),
          })).map((issue) => [issue.id, issue]));
          const retained = new Map((full ? [] : cached!.issues).map((issue) => [issue.id, issue]));
          if (!full) {
            const affected = new Map<number, GitHubSubject>();
            for (const subject of dirtySubjects) {
              if (subject.kind === "ISSUE") {
                affected.set(subject.id, subject);
              } else {
                // Both sides matter when a PR edits away an old closing reference.
                for (const issue of [...retained.values(), ...changed.values()]) {
                  if (issue.closingPullRequests.some((pr) => pr.id === subject.id && belongsToRegisteredRepository(repository, pr))) {
                    affected.set(issue.id, issue);
                  }
                }
                const references = await dependencies.github.getPullRequestClosingIssues(reference, subject);
                for (const issue of references) {
                  if (belongsToRegisteredRepository(repository, issue)) affected.set(issue.id, issue);
                }
              }
            }
            for (const subject of affected.values()) {
              if (changed.has(subject.id)) continue;
              const issue = await dependencies.github.getIssue(reference, subject);
              if (issue !== null) changed.set(issue.id, issue);
            }
          }
          for (const issue of changed.values()) retained.set(issue.id, issue);
          const githubIssues = [...retained.values()];
          const pullRequestEvidence = new Map((full ? [] : cached!.pullRequests)
            .map(({ id, reviews, rawDiff }) => [id, { reviews, rawDiff }]));
          const referencedPullRequests = githubIssues.flatMap(({ closingPullRequests }) => closingPullRequests);
          const dirtyPullRequests = new Set(dirtySubjects.filter(({ kind }) => kind === "PULL_REQUEST").map(({ id }) => id));
          const refreshedEvidence = await collectPullRequestEvidence(
            dependencies.github,
            reference,
            repository,
            full ? referencedPullRequests : [
              ...[...changed.values()].flatMap(({ closingPullRequests }) => closingPullRequests),
              ...referencedPullRequests.filter(({ id }) => dirtyPullRequests.has(id) || !pullRequestEvidence.has(id)),
            ],
          );
          for (const [id, evidence] of refreshedEvidence) pullRequestEvidence.set(id, evidence);
          const retainedPrIds = new Set(referencedPullRequests.filter((pr) => pr.state === "MERGED" && pr.mergedAt !== null
            && belongsToRegisteredRepository(repository, pr)).map(({ id }) => id));
          for (const id of pullRequestEvidence.keys()) if (!retainedPrIds.has(id)) pullRequestEvidence.delete(id);
          return { githubIssues, pullRequestEvidence };
        },
      );
      // The same boundary the evidence fetch draws: an author is looked up
      // because their pull request might be credited here, and a pull request in
      // another repository never can be.
      const authorGitHubUserIds = [...new Set(
        githubIssues
          .flatMap(({ closingPullRequests }) => closingPullRequests)
          .filter((pullRequest) => belongsToRegisteredRepository(repository, pullRequest))
          .map((pullRequest) => pullRequest.authorGitHubUserId)
          .filter((githubUserId): githubUserId is number => githubUserId !== null),
      )];
      const users = await dependencies.store.findUsersByGitHubUserIds(authorGitHubUserIds);
      const snapshot: RepositoryFoldSnapshot = {
        repository,
        users,
        issues: githubIssues.map((issue) => ({
          ...issue,
          claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin,
          closingPullRequests: issue.closingPullRequests.map((pullRequest) => ({
            ...pullRequest,
            reviews: pullRequestEvidence.get(pullRequest.id)?.reviews ?? [],
            rawDiff: pullRequestEvidence.get(pullRequest.id)?.rawDiff ?? "",
          })),
        })),
      };
      const fold = foldRepository(snapshot);
      const cost: ReconciliationCostCharge = { ...readCost(), sponsorId: repository.sponsor.id, completedAt: now() };
      const deltas = await dependencies.store.materialize({ repositoryId, runId, fold, cost, synchronization: {
        expectedVersion: cached?.version ?? null, scanStartedAt, full, issues: githubIssues,
        pullRequests: [...pullRequestEvidence].map(([id, evidence]) => ({ id, ...evidence })), dirtySubjects,
      } });

      return {
        repositoryId,
        runId,
        skipped: false,
        ...deltas,
        added: deltas.adds,
        changed: deltas.changes,
        removed: deltas.removals,
      };
    });
    return collected.value;
  } catch (error) {
    if (error instanceof GraphqlBudgetHeld) {
      await dependencies.store.failRun(runId, "Reconciliation held for GraphQL budget.");
      return { repositoryId, runId: null, skipped: true, budgetHeldUntil: error.resetAt,
        adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 };
    }
    // The stored message stays fixed: an upstream error can carry the sponsor's
    // GitHub token in a URL, and reconciliation_runs is read by the product.
    // The cause reaches the service log here and rides on the thrown error, so
    // a caller that reports the failure reports what actually went wrong.
    console.error(`Reconciliation of repository ${repositoryId} failed.`, error);
    await dependencies.store.failRun(runId, "Reconciliation failed.");
    if (isGitHubRateLimitError(error)) {
      const seconds = error.retryAfterSeconds ?? DEFAULT_RECONCILIATION_COOLDOWN_SECONDS;
      await dependencies.store.setReconciliationCooldown(repositoryId, new Date(now().getTime() + seconds * 1000));
    }
    throw new Error("Unable to reconcile repository.", { cause: error });
  }
}

async function collectPullRequestEvidence(
  github: ReconciliationGateway,
  reference: GitHubRepositoryReference,
  registered: ReconciliationRepository,
  pullRequests: readonly GitHubPullRequest[],
): Promise<Map<number, { reviews: GitHubPullRequestReview[]; rawDiff: string }>> {
  // A closing reference can name a pull request in another repository, and its
  // number means nothing here: reading it from the registered repository would
  // fingerprint whichever pull request happens to carry that number. Overflow's
  // authority ends at the registered repository, so its evidence is not read.
  // The fold makes the same call through the same predicate, because the two
  // disagreeing is what puts an empty diff behind a settlement's proof.
  const uniqueMergedPullRequests = new Map(
    pullRequests
      .filter((pullRequest) =>
        pullRequest.state === "MERGED" &&
        pullRequest.mergedAt !== null &&
        belongsToRegisteredRepository(registered, pullRequest))
      .map((pullRequest) => [pullRequest.id, pullRequest]),
  );
  const evidence = await mapWithConcurrency(
    [...uniqueMergedPullRequests.values()],
    reconciliationConcurrency,
    async (pullRequest) => [
      pullRequest.id,
      {
        reviews: await github.getPullRequestReviews(reference, pullRequest.number),
        rawDiff: await github.getPullRequestDiff(reference, pullRequest.number),
      },
    ] as const,
  );
  return new Map(evidence);
}

async function declineCrawl(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
  runId: string,
  reason: RepositoryUnavailableReason,
  at: Date,
): Promise<ReconciliationSummary> {
  await dependencies.store.markRepositoryUnavailable({ repositoryId, reason, at });
  // Nothing upstream failed: the crawl was declined, so the run completes.
  await dependencies.store.completeRun(runId);
  await dependencies.store.setReconciliationCooldown(repositoryId, null);
  return noDeltaSummary(repositoryId, runId);
}

function noDeltaSummary(repositoryId: string, runId: string): ReconciliationSummary {
  return {
    repositoryId,
    runId,
    skipped: false,
    adds: 0,
    changes: 0,
    removals: 0,
    added: 0,
    changed: 0,
    removed: 0,
  };
}
