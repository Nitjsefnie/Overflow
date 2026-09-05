import { foldRepository, type FoldResult, type FoldUser, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type { GitHubIssue, GitHubPullRequest, GitHubPullRequestReview, GitHubRepositoryReference } from "@/lib/github/types";

export type ReconciliationRepository = RepositoryFoldSnapshot["repository"];

export type ReconciliationGateway = {
  listIssues(repository: GitHubRepositoryReference): Promise<GitHubIssue[]>;
  getIssueClosingPullRequests(
    repository: GitHubRepositoryReference,
    issueNumber: number,
  ): Promise<GitHubPullRequest[]>;
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
  getGitHubAccessToken(userId: string): Promise<string | null>;
  findUsersByGitHubLogins(logins: readonly string[]): Promise<FoldUser[]>;
  beginRun(repositoryId: string): Promise<string>;
  completeRun(runId: string): Promise<void>;
  materialize(input: { repositoryId: string; runId: string; fold: FoldResult }): Promise<ReconciliationDeltas>;
  failRun(runId: string, errorMessage: string): Promise<void>;
};

export type ReconciliationDependencies = {
  store: ReconciliationStore;
  github: ReconciliationGateway;
};

export type ReconciliationSummary = ReconciliationDeltas & {
  repositoryId: string;
  runId: string;
  added: number;
  changed: number;
  removed: number;
};

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

  const runId = await dependencies.store.beginRun(repositoryId);
  try {
    if (!repository.active) {
      await dependencies.store.completeRun(runId);
      return {
        repositoryId,
        runId,
        adds: 0,
        changes: 0,
        removals: 0,
        added: 0,
        changed: 0,
        removed: 0,
      };
    }

    const accessToken = await dependencies.store.getGitHubAccessToken(repository.sponsor.id);
    if (accessToken === null) {
      throw new Error("GitHub access token was not available.");
    }

    const reference = toRepositoryReference(repository.ownerName);
    const githubIssues = await dependencies.github.listIssues(reference);
    const issuePullRequests = await Promise.all(
      githubIssues.map(async (issue) => ({
        issue,
        closingPullRequests: await dependencies.github.getIssueClosingPullRequests(reference, issue.number),
      })),
    );
    const pullRequestEvidence = await collectPullRequestEvidence(
      dependencies.github,
      reference,
      issuePullRequests.flatMap(({ closingPullRequests }) => closingPullRequests),
    );
    const logins = [...new Set(
      issuePullRequests
        .flatMap(({ closingPullRequests }) => closingPullRequests.map((pullRequest) => pullRequest.authorLogin))
        .filter((login): login is string => login !== null),
    )];
    const users = await dependencies.store.findUsersByGitHubLogins(logins);
    const snapshot: RepositoryFoldSnapshot = {
      repository,
      users,
      issues: issuePullRequests.map(({ issue, closingPullRequests }) => ({
        ...issue,
        claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin,
        closingPullRequests: closingPullRequests.map((pullRequest) => ({
          ...pullRequest,
          reviews: pullRequestEvidence.get(pullRequest.id)?.reviews ?? [],
          rawDiff: pullRequestEvidence.get(pullRequest.id)?.rawDiff ?? "",
        })),
      })),
    };
    const fold = foldRepository(snapshot);
    const deltas = await dependencies.store.materialize({ repositoryId, runId, fold });

    return {
      repositoryId,
      runId,
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
  const evidence = await Promise.all(
    [...uniqueMergedPullRequests.values()].map(async (pullRequest) => [
      pullRequest.id,
      {
        reviews: await github.getPullRequestReviews(repository, pullRequest.number),
        rawDiff: await github.getPullRequestDiff(repository, pullRequest.number),
      },
    ] as const),
  );
  return new Map(evidence);
}

function toRepositoryReference(ownerName: string): GitHubRepositoryReference {
  const parts = ownerName.split("/");
  if (parts.length !== 2 || parts[0]?.length === 0 || parts[1]?.length === 0) {
    throw new Error("Registered repository owner/name was invalid.");
  }
  return { owner: parts[0], name: parts[1] };
}
