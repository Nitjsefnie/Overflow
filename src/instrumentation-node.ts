import { PostgresSweepRoundStore } from "@/lib/fold/sweep-round-store";
import { PostgresSweepPassStore } from "@/lib/fold/sweep-pass-store";
import { readSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import {
  drainReconciliationJobs,
  startReconciliationWorker,
} from "@/lib/fold/reconciliation-worker";
import {
  shouldStartReconciliationBackground,
  startReconciliationSweep,
  sweepReconciliations,
} from "@/lib/fold/sweep";
import { FailureLogger } from "@/lib/worker/failure-logger";
import { DrainSummaryLogger } from "@/lib/logging/drain-summary-logger";
import { readGitHubRegistrationAppAuthConfig } from "@/lib/github/app-installation-auth";
import { errorLogToken } from "@/lib/webhooks/log-field";
import { installJournalLevels } from "@/lib/logging/journal-levels";

/**
 * The drain site's failure key (issue 661): the whole-drain hook the schedule
 * reports through when the store itself is unreachable. Distinct from the
 * lease-heartbeat site's key, so one outage does not suppress the other's
 * first failure.
 */
export const RECONCILIATION_DRAIN_FAILURE_KEY = "reconciliation-drain";

/**
 * Everything register() does on the Node.js runtime, split out of
 * src/instrumentation.ts so that module can hold the literal
 * `process.env.NEXT_RUNTIME` gate the bundler folds per runtime. Nothing here,
 * including the Node-only dynamic imports below, reaches the Edge
 * Instrumentation bundle; on the Node.js server this is wired and gated exactly
 * as it was before the split.
 */
export async function registerNodejs(): Promise<void> {
  installJournalLevels();
  if (!shouldStartReconciliationBackground(process.env)) {
    return;
  }

  // A misconfigured registration App key fails startup at wiring; the
  // reconciliation App variables production keeps set are read never.
  readGitHubRegistrationAppAuthConfig(process.env);

  const { PostgresFoldStore } = await import("@/lib/fold/postgres-store");
  const { finalizeAbandonedRuns } = await import("@/lib/fold/abandoned-runs");
  const { reconcileRepositoryAsSponsor } = await import("@/lib/fold/reconcile-as-sponsor");
  const { PostgresForgeIdentityStore } = await import("@/lib/forge/postgres-identities-store");
  const { pruneExpiredMaintenanceRows } = await import("@/lib/retention/prune");
  const { getSql, getCoordinationSql } = await import("@/lib/db/client");
  const { PostgresRepositorySizeStore, measureRepositorySize } = await import("@/lib/fold/repository-size");
  const { GitHubGateway } = await import("@/lib/github/client");
  const { GitLabGateway } = await import("@/lib/gitlab/client");
  const store = new PostgresFoldStore();
  const sweepRound = new PostgresSweepRoundStore();
  const sweepPasses = new PostgresSweepPassStore();
  const repositorySizes = new PostgresRepositorySizeStore();
  const sweep = {
    spend: () => sweepRound.spend(new Date(), readSweepRequestBudget(process.env)),
    openPass: sweepPasses.open.bind(sweepPasses),
    discardPass: sweepPasses.discardByRepository.bind(sweepPasses),
  };
  try {
    await finalizeAbandonedRuns(getSql(), getCoordinationSql());
  } catch (error) {
    console.error("Could not finalize abandoned reconciliation runs on startup", error);
  }
  // GitLab repositories fold with the sponsor's linked identity's PAT, resolved
  // and decrypted at first read through the same memoization, and a rejection
  // of that credential stamps the identity's re-verification marker. Both
  // construct the identity store per call — never at register time, so an
  // environment without database wiring stays constructible (the unit suites
  // exercise this exact wiring against fakes).
  const resolveForgeToken = (userId: string, instanceUrl: string) =>
    new PostgresForgeIdentityStore(getSql()).getForgeToken(userId, instanceUrl);
  const markCredentialRejected = (userId: string, identityId: string) =>
    new PostgresForgeIdentityStore(getSql()).markTokenRejected(userId, identityId);
  // One logger for the worker's two bounded failure sites (issue 661): the
  // drain's own key below, and the lease-heartbeat site's key inside the
  // worker. Shared so both sites' quiet windows run on one clock, separate
  // keys so neither site's outage suppresses the other's first failure.
  const failureLogger = new FailureLogger();
  const drainSummaryLogger = new DrainSummaryLogger();

  startReconciliationWorker({
    drain: async () => {
      const outcomes = await drainReconciliationJobs({
        store,
        // Each repository is folded with its own sponsor's token, the same way the
        // webhook route reads it — the worker has no actor of its own. Which token
        // and whether one is needed at all belong to the fold, so this is wiring
        // and nothing else.
        reconcile: (repositoryId, options) =>
          reconcileRepositoryAsSponsor(store, repositoryId, undefined, {
            ...options,
            sweep,
            resolveForgeToken,
            markCredentialRejected: async (identityId) => {
              const repository = await store.getRepository(repositoryId);
              if (repository !== null) {
                await markCredentialRejected(repository.sponsor.id, identityId);
              }
            },
          }),
        // The heartbeat site's failures flow through the shared logger under
        // the worker's own key, so an outage bounds both sites together.
        leaseHeartbeatFailureLogger: failureLogger,
        onFailure: (repositoryId, error) => {
          // The job carries its own retry, so this is the operator's only view of
          // a repository that keeps failing to fold. The error can carry
          // member-chosen GitLab text and the console sink renders an error
          // object through its stack — message raw — so it is encoded into one
          // bounded single-line token (issue 1042).
          console.error(`Reconciliation failed for repository ${repositoryId}`, errorLogToken(error));
        },
      });
      // A drain that resolves is the drain site's positive signal: after a
      // failed drain it ends the outage with the recovery line (issue 661).
      failureLogger.success(RECONCILIATION_DRAIN_FAILURE_KEY);
      drainSummaryLogger.record(outcomes);
      return outcomes;
    },
    onFailure: (error) => {
      // First failure of an outage passes through in full; the bound lives in
      // the logger (issue 661). The message passes through with it, so the one
      // allowed line is exactly the line the unbounded site printed.
      failureLogger.failure(
        RECONCILIATION_DRAIN_FAILURE_KEY,
        "Reconciliation worker could not drain the job queue",
        error,
      );
    },
  });

  let nextMaintenanceAt = 0;
  startReconciliationSweep({
    intervalMs: 15_000,
    finalizeAbandonedRuns: () => Date.now() < nextMaintenanceAt
      ? Promise.resolve() : finalizeAbandonedRuns(getSql(), getCoordinationSql()),
    pruneRetention: async () => {
      if (Date.now() < nextMaintenanceAt) return;
      nextMaintenanceAt = Date.now() + 6 * 60 * 60_000;
      const result = await pruneExpiredMaintenanceRows(getSql());
      // One line per tick, so an operator sees the prune ran rather than
      // inferring it from the absence of complaints.
      console.info("Retention prune", result);
      return result;
    },
    runSweep: async () => {
      const summary = await sweepReconciliations({
        round: sweepRound,
        listActiveRepositoryIds: () => store.listActiveRepositoryIds(),
        // The measure rides each repository's sponsor's credential.
        sizeStore: repositorySizes,
        measureSize: measureRepositorySize(
          {
            getRepository: (repositoryId) => store.getRepository(repositoryId),
            getGitHubAccessToken: (userId) => store.getGitHubAccessToken(userId),
            resolveForgeToken: (userId, instanceUrl) =>
              new PostgresForgeIdentityStore(getSql()).getForgeToken(userId, instanceUrl),
          },
          (input) => input.provider === "gitlab"
            ? new GitLabGateway({ instanceUrl: input.instanceUrl, token: input.token })
            : new GitHubGateway({ accessToken: input.accessToken, owner: input.ownerId }),
        ),
        enqueue: (repositoryId) => store.enqueueReconciliationJob(repositoryId, "SWEEP"),
        onFailure: (repositoryId, error) => {
          // Report the failure while retaining the durable slot: the next poll
          // retries this repository. Encode the error for the same reason as
          // the drain's site above.
          console.error(`Reconciliation sweep failed for repository ${repositoryId}`, errorLogToken(error));
        },
      });
      // One line per sweep, so an operator can see the repair path running rather
      // than inferring it from the absence of complaints.
      console.info("Reconciliation sweep", summary);
      return summary;
    },
  });
}
