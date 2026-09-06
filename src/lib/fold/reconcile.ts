import { mapWithConcurrency } from "@/lib/async/map-with-concurrency";
import { isGitHubRateLimitError } from "@/lib/github/errors";
import { foldRepository, type FoldResult, type FoldUser, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubRepository,
  GitHubRepositoryReference,
} from "@/lib/github/types";

// Cap this reconciliation at four HTTP requests: each PR worker paginates
// reviews, then dismissals, then fetches its diff, one request at a time.
const reconciliationConcurrency = 4;

// A large repository can exhaust an hourly GitHub budget; without retry guidance,
// allow a full hour for it to recover before spending points on another full fold.
export const DEFAULT_RECONCILIATION_COOLDOWN_SECONDS = 60 * 60;

// The fold itself works from the stored path, but reconciliation must resolve the
// registered repository by the identity GitHub cannot reassign.
export type ReconciliationRepository = RepositoryFoldSnapshot["repository"] & { githubRepositoryId: number };

export type RepositoryUnavailableReason = "NOT_FOUND" | "NOT_PUBLIC" | "IDENTITY_MISMATCH";

export type ReconciliationGateway = {
  getRepositoryById(githubRepositoryId: number): Promise<GitHubRepository | null>;
  listIssues(repository: GitHubRepositoryReference): Promise<GitHubIssue[]>;
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
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
  setReconciliationCooldown(repositoryId: string, notBefore: Date | null): Promise<void>;
  getGitHubAccessToken(userId: string): Promise<string | null>;
  findUsersByGitHubUserIds(githubUserIds: readonly number[]): Promise<FoldUser[]>;
  beginRun(repositoryId: string): Promise<string>;
  completeRun(runId: string): Promise<void>;
  materialize(input: { repositoryId: string; runId: string; fold: FoldResult }): Promise<ReconciliationDeltas>;
  failRun(runId: string, errorMessage: string): Promise<void>;
  recordVerifiedRepositoryIdentity(input: {
    repositoryId: string;
    ownerName: string;
    visibility: "PUBLIC" | "PRIVATE";
  }): Promise<void>;
  markRepositoryUnavailable(input: {
    repositoryId: string;
    reason: RepositoryUnavailableReason;
    at: Date;
  }): Promise<void>;
};

export type ReconciliationDependencies = {
  store: ReconciliationStore;
  github: ReconciliationGateway;
  now?: () => Date;
};

export type ReconciliationSummary = ReconciliationDeltas & {
  repositoryId: string;
  added: number;
  changed: number;
  removed: number;
} & ({ skipped: false; runId: string } | { skipped: true; runId: null });

export async function reconcileRepository(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
): Promise<ReconciliationSummary> {
  return dependencies.store.withRepositoryReconciliation(
    repositoryId,
    () => reconcileRepositoryWhileCoordinated(dependencies, repositoryId),
  );
}

async function reconcileRepositoryWhileCoordinated(
  dependencies: ReconciliationDependencies,
  repositoryId: string,
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

  const runId = await dependencies.store.beginRun(repositoryId);
  try {
    if (!repository.active) {
      await dependencies.store.completeRun(runId);
      await dependencies.store.setReconciliationCooldown(repositoryId, null);
      return noDeltaSummary(repositoryId, runId);
    }

    const accessToken = await dependencies.store.getGitHubAccessToken(repository.sponsor.id);
    if (accessToken === null) {
      throw new Error("GitHub access token was not available.");
    }

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
    // stops being crawled.
    if (verified.visibility !== "PUBLIC") {
      return declineCrawl(dependencies, repositoryId, runId, "NOT_PUBLIC", now());
    }

    await dependencies.store.recordVerifiedRepositoryIdentity({
      repositoryId,
      ownerName: verified.fullName,
      visibility: verified.visibility,
    });
    const reference: GitHubRepositoryReference = { owner: verified.owner, name: verified.name };
    const githubIssues = await dependencies.github.listIssues(reference);
    const pullRequestEvidence = await collectPullRequestEvidence(
      dependencies.github,
      reference,
      githubIssues.flatMap(({ closingPullRequests }) => closingPullRequests),
    );
    const authorGitHubUserIds = [...new Set(
      githubIssues
        .flatMap(({ closingPullRequests }) => closingPullRequests.map((pullRequest) => pullRequest.authorGitHubUserId))
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
    const deltas = await dependencies.store.materialize({ repositoryId, runId, fold });
    await dependencies.store.setReconciliationCooldown(repositoryId, null);

    return {
      repositoryId,
      runId,
      skipped: false,
      ...deltas,
      added: deltas.adds,
      changed: deltas.changes,
      removed: deltas.removals,
    };
  } catch (error) {
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
  repository: GitHubRepositoryReference,
  pullRequests: readonly GitHubPullRequest[],
): Promise<Map<number, { reviews: GitHubPullRequestReview[]; rawDiff: string }>> {
  const uniqueMergedPullRequests = new Map(
    pullRequests
      .filter((pullRequest) => pullRequest.state === "MERGED" && pullRequest.mergedAt !== null)
      .map((pullRequest) => [pullRequest.id, pullRequest]),
  );
  const evidence = await mapWithConcurrency(
    [...uniqueMergedPullRequests.values()],
    reconciliationConcurrency,
    async (pullRequest) => [
      pullRequest.id,
      {
        reviews: await github.getPullRequestReviews(repository, pullRequest.number),
        rawDiff: await github.getPullRequestDiff(repository, pullRequest.number),
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
