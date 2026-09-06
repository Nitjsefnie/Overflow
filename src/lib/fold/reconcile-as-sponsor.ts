import { GitHubGateway } from "@/lib/github/client";
import {
  reconcileRepository,
  type ReconciliationGateway,
  type ReconciliationStore,
  type ReconciliationSummary,
} from "@/lib/fold/reconcile";

/**
 * Folds one repository with its own sponsor's GitHub credentials.
 *
 * Every caller that reconciles on nobody's behalf — the queue worker, the CLI —
 * needs the same thing: a repository has no actor of its own, so the reads are
 * made with the token of the account that registered it, exactly as the webhook
 * route does.
 *
 * The token is resolved on the first GitHub read rather than before the fold
 * starts, and that is the whole point of routing through this helper. A wrapper
 * that resolved it up front threw before the fold could reach its inactive
 * short-circuit, which completes a deactivated repository without touching
 * GitHub at all. So a repository deactivated while it held a job, whose
 * sponsor's token has since gone, burned every retry and settled as FAILED — a
 * state the sweep never revives, because it enqueues active repositories only.
 *
 * `createGateway` is injectable for tests; production takes the real gateway.
 */
export function reconcileRepositoryAsSponsor(
  store: ReconciliationStore,
  repositoryId: string,
  createGateway: (accessToken: string) => ReconciliationGateway = (accessToken) =>
    new GitHubGateway({ accessToken }),
): Promise<ReconciliationSummary> {
  return reconcileRepository(
    { store, github: sponsorGateway(store, repositoryId, createGateway) },
    repositoryId,
  );
}

/**
 * A gateway that resolves the sponsor's token the first time GitHub is actually
 * read, and not before.
 *
 * Every method defers to the same memoized resolution, so a fold that reads
 * GitHub several times still authenticates once, and a fold that reads it not at
 * all — the inactive repository, the cooled-down one — never asks for a token
 * that may no longer exist.
 */
function sponsorGateway(
  store: ReconciliationStore,
  repositoryId: string,
  createGateway: (accessToken: string) => ReconciliationGateway,
): ReconciliationGateway {
  let resolving: Promise<ReconciliationGateway> | undefined;
  const gateway = (): Promise<ReconciliationGateway> => {
    resolving ??= (async () => {
      const repository = await store.getRepository(repositoryId);
      if (repository === null) {
        throw new Error("Repository was not found.");
      }
      const accessToken = await store.getGitHubAccessToken(repository.sponsor.id);
      if (accessToken === null) {
        throw new Error("GitHub access token was not available.");
      }
      return createGateway(accessToken);
    })();
    return resolving;
  };

  return {
    getRepositoryById: async (githubRepositoryId) => (await gateway()).getRepositoryById(githubRepositoryId),
    listIssues: async (repository, options) => (await gateway()).listIssues(repository, options),
    getPullRequestReviews: async (repository, pullRequestNumber) =>
      (await gateway()).getPullRequestReviews(repository, pullRequestNumber),
    getPullRequestDiff: async (repository, pullRequestNumber) =>
      (await gateway()).getPullRequestDiff(repository, pullRequestNumber),
  };
}
