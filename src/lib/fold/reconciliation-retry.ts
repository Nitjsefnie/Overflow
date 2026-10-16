import type { ReconciliationGateway } from "@/lib/fold/reconcile";
import { isTransientGitHubRequestError } from "@/lib/github/errors";

// Bound each read so a persistent outage still reaches whole-run failure
// bookkeeping instead of holding reconciliation open indefinitely.
export const GITHUB_TRANSIENT_RETRY_ATTEMPTS = 3;

export function transientRetryDelayMs(attempt: number): number {
  return 250 * 2 ** (attempt - 1);
}

export function withTransientRequestRetry(
  gateway: ReconciliationGateway,
  options?: { delay?: (ms: number) => Promise<void> },
): ReconciliationGateway {
  const delay = options?.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retry = async <T>(read: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await read();
      } catch (error) {
        // Only transport failures and server errors retry; definitive subject
        // failures pass through, and rate limits retain the run-level cooldown.
        if (attempt >= GITHUB_TRANSIENT_RETRY_ATTEMPTS || !isTransientGitHubRequestError(error)) throw error;
        await delay(transientRetryDelayMs(attempt));
      }
    }
  };
  return {
    getRepositoryById: (...args) => retry(() => gateway.getRepositoryById(...args)),
    listIssues: (...args) => retry(() => gateway.listIssues(...args)),
    getIssue: (...args) => retry(() => gateway.getIssue(...args)),
    getPullRequestClosingIssues: (...args) => retry(() => gateway.getPullRequestClosingIssues(...args)),
    getPullRequestReviews: (...args) => retry(() => gateway.getPullRequestReviews(...args)),
    getPullRequestDiff: (...args) => retry(() => gateway.getPullRequestDiff(...args)),
  };
}
