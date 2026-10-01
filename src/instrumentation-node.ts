import {
  drainReconciliationJobs,
  startReconciliationWorker,
  type ReconciliationJobOutcome,
} from "@/lib/fold/reconciliation-worker";
import {
  shouldStartReconciliationBackground,
  startReconciliationSweep,
  sweepReconciliations,
} from "@/lib/fold/sweep";
import { FailureLogger } from "@/lib/worker/failure-logger";
import { appInstallationTokenResolverFromEnv } from "@/lib/github/app-installation-auth";

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
  if (!shouldStartReconciliationBackground(process.env)) {
    return;
  }

  // GitHub repositories fold as the sponsor's GitHub App installation when the
  // App is configured (issue 804), instead of the sponsor's OAuth token. The
  // resolver is built once at wiring time, never per fold: unconfigured —
  // either variable unset or empty — it is undefined and every fold reads the
  // sponsor's OAuth token exactly as before; configured with an unreadable key
  // file it throws here, failing the start before any fold (fail-closed, the
  // GitLab credential precedent). Unconfigured reading as null from the
  // factory, unwired reading as undefined on the options — both leave the
  // option off, so `?? undefined` carries the factory's null across.
  const resolveAppInstallationToken =
    appInstallationTokenResolverFromEnv(process.env) ?? undefined;

  const { PostgresFoldStore } = await import("@/lib/fold/postgres-store");
  const { finalizeAbandonedRuns } = await import("@/lib/fold/abandoned-runs");
  const { reconcileRepositoryAsSponsor } = await import("@/lib/fold/reconcile-as-sponsor");
  const { PostgresForgeIdentityStore } = await import("@/lib/forge/postgres-identities-store");
  const { pruneExpiredMaintenanceRows } = await import("@/lib/retention/prune");
  const { getSql, getCoordinationSql } = await import("@/lib/db/client");
  const store = new PostgresFoldStore();
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
            resolveAppInstallationToken,
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
          // a repository that keeps failing to fold.
          console.error(`Reconciliation failed for repository ${repositoryId}`, error);
        },
      });
      // A drain that resolves is the drain site's positive signal: after a
      // failed drain it ends the outage with the recovery line (issue 661).
      failureLogger.success(RECONCILIATION_DRAIN_FAILURE_KEY);
      if (outcomes.length > 0) console.info("Reconciliation drain", countOutcomes(outcomes));
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

  startReconciliationSweep({
    finalizeAbandonedRuns: () => finalizeAbandonedRuns(getSql(), getCoordinationSql()),
    pruneRetention: async () => {
      const result = await pruneExpiredMaintenanceRows(getSql());
      // One line per tick, so an operator sees the prune ran rather than
      // inferring it from the absence of complaints.
      console.info("Retention prune", result);
      return result;
    },
    runSweep: async () => {
      const summary = await sweepReconciliations({
        listActiveRepositoryIds: () => store.listActiveRepositoryIds(),
        enqueue: (repositoryId) => store.enqueueReconciliationJob(repositoryId, "SWEEP"),
        onFailure: (repositoryId, error) => {
          // One repository that cannot be queued must not silently stall the
          // sweep for the rest, so the failure is reported and the sweep moves on.
          console.error(`Reconciliation sweep failed for repository ${repositoryId}`, error);
        },
      });
      // One line per sweep, so an operator can see the repair path running rather
      // than inferring it from the absence of complaints.
      console.info("Reconciliation sweep", summary);
      return summary;
    },
  });
}

/** Counts a drain's outcomes by kind, so one line says what the pass actually did. */
function countOutcomes(outcomes: readonly ReconciliationJobOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}
