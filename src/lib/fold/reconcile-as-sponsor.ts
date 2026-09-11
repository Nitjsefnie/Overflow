import type { ReconciliationGateway, ReconciliationStore } from "@/lib/fold/reconcile";
import {
  reconcileRepository,
  type ReconciliationSummary,
} from "@/lib/fold/reconcile";
import { ForgeCredentialRejectedError, resolveGateway } from "@/lib/forge/gateway";
import { GitLabApiError } from "@/lib/gitlab/client";

/**
 * Folds one repository with its own sponsor's forge credentials.
 *
 * Every caller that reconciles on nobody's behalf — the queue worker, the CLI —
 * needs the same thing: a repository has no actor of its own, so the reads are
 * made with the token of the account that registered it, exactly as the webhook
 * route does.
 *
 * The token is resolved on the first read rather than before the fold starts,
 * and that is the whole point of routing through this helper. A wrapper that
 * resolved it up front threw before the fold could reach its inactive
 * short-circuit, which completes a deactivated repository without touching the
 * forge at all. So a repository deactivated while it held a job, whose
 * sponsor's token has since gone, burned every retry and settled as FAILED — a
 * state the sweep never revives, because it enqueues active repositories only.
 *
 * `createGateway` (GitHub) and `resolveForgeToken` (GitLab) are injectable for
 * tests; production wires the real gateway and the identity store's
 * `getForgeToken`.
 *
 * Exported for tests: the resolution semantics (provider branch, fail-closed
 * GitLab, GitHub passthrough) are pinned directly against the gateway factory.
 */
export type ReconcileAsSponsorOptions = {
  rederive?: boolean;
  /** Decrypts the linked identity's PAT for a GitLab repository's instance. */
  resolveForgeToken?: (userId: string, instanceUrl: string) => Promise<string | null>;
  /**
   * Records a rejected credential on the linked identity (the re-link
   * signal). Best-effort: a failure here is logged and the fold's own error
   * stands — see the credential guard in `sponsorGateway`.
   */
  markCredentialRejected?: (userId: string, instanceUrl: string) => Promise<void>;
};

export function reconcileRepositoryAsSponsor(
  store: ReconciliationStore,
  repositoryId: string,
  createGateway: (accessToken: string, owner: string) => ReconciliationGateway = (accessToken, owner) =>
    resolveGateway({
      provider: "github",
      instanceUrl: null,
      github: { accessToken, owner },
      gitlab: null,
    }) as ReconciliationGateway,
  options?: ReconcileAsSponsorOptions,
): Promise<ReconciliationSummary> {
  return reconcileRepository(
    {
      store,
      github: sponsorGateway(
        store,
        repositoryId,
        createGateway,
        options?.resolveForgeToken,
        options?.markCredentialRejected,
      ),
    },
    repositoryId,
    { rederive: options?.rederive },
  );
}

/**
 * A gateway that resolves the sponsor's forge credential the first time the
 * forge is actually read, and not before.
 *
 * Every method defers to the same memoized resolution, so a fold that reads
 * the forge several times still authenticates once, and a fold that reads it
 * not at all — the inactive repository, the cooled-down one — never asks for a
 * token that may no longer exist.
 *
 * GitHub repositories resolve the sponsor's OAuth token exactly as before.
 * GitLab repositories resolve the linked identity's decrypted PAT on the
 * repository's instance and are FAIL-CLOSED: a missing or unverified identity
 * — or an unwired resolver — throws, failing that repository's reconciliation,
 * rather than reading with the wrong credential or silently skipping. Every
 * read a GitLab fold makes is additionally guarded: a 401/403 from the
 * instance marks the linked identity as needing re-verification (through the
 * injected marker, best-effort) and surfaces as `ForgeCredentialRejectedError`,
 * whose fixed message is what the run failure records.
 */
export function sponsorGateway(
  store: ReconciliationStore,
  repositoryId: string,
  createGateway: (accessToken: string, owner: string) => ReconciliationGateway,
  resolveForgeToken?: (userId: string, instanceUrl: string) => Promise<string | null>,
  markCredentialRejected?: (userId: string, instanceUrl: string) => Promise<void>,
): ReconciliationGateway {
  let resolving: Promise<ReconciliationGateway> | undefined;
  const gateway = (): Promise<ReconciliationGateway> => {
    resolving ??= (async () => {
      const repository = await store.getRepository(repositoryId);
      if (repository === null) {
        throw new Error("Repository was not found.");
      }
      if (repository.provider === "gitlab") {
        const instanceUrl = repository.instanceUrl;
        if (instanceUrl === null || instanceUrl === undefined) {
          throw new Error(
            "The GitLab repository carries no instance URL; the row needs repair before it can fold.",
          );
        }
        if (resolveForgeToken === undefined) {
          throw new Error(
            "No forge-credential resolver is wired, so the GitLab repository cannot fold (fail-closed).",
          );
        }
        const token = await resolveForgeToken(repository.sponsor.id, instanceUrl);
        if (token === null) {
          throw new Error(
            "No verified GitLab identity is linked for this repository's instance, so the reconciliation failed closed.",
          );
        }
        return guardGitLabCredential(
          resolveGateway({
            provider: "gitlab",
            instanceUrl,
            github: { accessToken: token },
            gitlab: { instanceUrl, token },
          }) as ReconciliationGateway,
          repository.sponsor.id,
          instanceUrl,
          markCredentialRejected,
        );
      }
      const accessToken = await store.getGitHubAccessToken(repository.sponsor.id);
      if (accessToken === null) {
        throw new Error("GitHub access token was not available.");
      }
      return createGateway(accessToken, repository.sponsor.id);
    })();
    return resolving;
  };

  return {
    getRepositoryById: async (githubRepositoryId) => (await gateway()).getRepositoryById(githubRepositoryId),
    listIssues: async (repository, options) => (await gateway()).listIssues(repository, options),
    getIssue: async (repository, subject) => (await gateway()).getIssue(repository, subject),
    getPullRequestClosingIssues: async (repository, subject) => (await gateway()).getPullRequestClosingIssues(repository, subject),
    getPullRequestReviews: async (repository, pullRequestNumber) =>
      (await gateway()).getPullRequestReviews(repository, pullRequestNumber),
    getPullRequestDiff: async (repository, pullRequestNumber) =>
      (await gateway()).getPullRequestDiff(repository, pullRequestNumber),
  };
}

/**
 * The credential guard around a GitLab fold's reads: an instance refusing a
 * read made through the linked identity with 401 (the token is gone) or 403
 * (its scope no longer suffices) is the one failure class that will repeat on
 * every retry, so it is recorded — the injected marker stamps the identity's
 * re-verification signal — and rethrown as `ForgeCredentialRejectedError`,
 * whose message is a fixed sentence the run failure can store. Marking is
 * best-effort: when the mark itself fails, the original error is rethrown so
 * the fold's own failure path still runs. Every other failure class — a 404,
 * a 5xx, a transport failure — is rethrown untouched and marks nothing, and
 * a healthy read passes through unchanged.
 */
function guardGitLabCredential(
  gateway: ReconciliationGateway,
  userId: string,
  instanceUrl: string,
  markCredentialRejected?: (userId: string, instanceUrl: string) => Promise<void>,
): ReconciliationGateway {
  const guarded = async <T>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof GitLabApiError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      if (markCredentialRejected !== undefined) {
        try {
          await markCredentialRejected(userId, instanceUrl);
        } catch (markError) {
          console.error(
            `Marking the rejected GitLab credential failed for user ${userId} on ${instanceUrl}.`,
            markError,
          );
          throw error;
        }
      }
      throw new ForgeCredentialRejectedError();
    }
  };
  return {
    getRepositoryById: (githubRepositoryId) => guarded(() => gateway.getRepositoryById(githubRepositoryId)),
    listIssues: (repository, options) => guarded(() => gateway.listIssues(repository, options)),
    getIssue: (repository, subject) => guarded(() => gateway.getIssue(repository, subject)),
    getPullRequestClosingIssues: (repository, subject) =>
      guarded(() => gateway.getPullRequestClosingIssues(repository, subject)),
    getPullRequestReviews: (repository, pullRequestNumber) =>
      guarded(() => gateway.getPullRequestReviews(repository, pullRequestNumber)),
    getPullRequestDiff: (repository, pullRequestNumber) =>
      guarded(() => gateway.getPullRequestDiff(repository, pullRequestNumber)),
  };
}
