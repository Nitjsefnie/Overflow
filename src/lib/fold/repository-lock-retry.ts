/**
 * The repository-lock retry policy, relocated from the fold store (issue 1071
 * moved the data-subject import check into the store and relocated this
 * self-contained policy to keep the store within its recorded module size).
 *
 * Waiting for another coordinator's repository lock retries with exponential
 * backoff and jitter, capped, and never longer than the caller's remaining
 * deadline.
 */
const repositoryLockInitialRetryMs = 10;
const repositoryLockMaximumRetryMs = 250;

/**
 * The next wait before retrying a repository lock take, after `attempt`
 * failed tries and with `remainingMs` of the caller's deadline left.
 */
export function waitForRepositoryLockRetry(attempt: number, remainingMs: number): Promise<void> {
  const retryCeilingMs = Math.min(
    repositoryLockMaximumRetryMs,
    repositoryLockInitialRetryMs * (2 ** Math.min(attempt, 10)),
  );
  const retryFloorMs = Math.ceil(retryCeilingMs / 2);
  const jitteredRetryMs = retryFloorMs
    + Math.floor(Math.random() * (retryCeilingMs - retryFloorMs + 1));
  const retryMs = Math.max(1, Math.min(remainingMs, jitteredRetryMs));
  return new Promise((resolve) => setTimeout(resolve, retryMs));
}
