import { readDiffOnlyBacklogThreshold, type PostgresRepositorySizeStore } from "@/lib/fold/repository-size";
import { readEnv } from "@/lib/env";
import {
  RECONCILIATION_EVIDENCE_FORMAT,
  type ReconciliationEvidence,
} from "@/lib/fold/reconciliation-evidence";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import type { ListedRepositorySponsor } from "@/lib/fold/sweep";
import type { PostgresSweepCatchupStore } from "@/lib/fold/sweep-catchup-store";
import type { TransactionClient } from "@/lib/db/types";
import { errorLogToken } from "@/lib/webhooks/log-field";

export type ReconciliationCatchupDependencies = {
  listActiveRepositorySponsors(): Promise<readonly ListedRepositorySponsor[]>;
  backlog: Pick<PostgresRepositorySizeStore, "getSponsorBacklog">;
  catchups: Pick<PostgresSweepCatchupStore, "requeueCandidateIds" | "advance">;
  evidence: {
    getReconciliationEvidence(repositoryId: string): Promise<ReconciliationEvidence | null>;
    hasDerivedRowsBelowFoldRevision(repositoryId: string, revision: number): Promise<boolean>;
  };
  /**
   * Runs on the catch-up advance's own transaction, so the claim and the job
   * insert commit or roll back together — a crash between them leaves the row
   * pending with no job row, never in flight without one.
   */
  enqueue(repositoryId: string, transaction: TransactionClient): Promise<unknown>;
  now?: () => Date;
};

export type ReconciliationCatchupSummary = {
  enqueued: number;
  requeued: number;
  completed: number;
  failed: number;
};

/**
 * Advances every over-threshold sponsor's catch-up queue by one step.
 *
 * Runs beside the sweep rotation in the same tick. A sponsor whose backlog is
 * not strictly over the diff-only threshold is skipped entirely: its rows are
 * created, ended and consumed only while it is over the threshold, so one that
 * drops under leaves its in-flight row in place and self-heals it on the next
 * over-threshold tick.
 *
 * One sponsor's failure is contained like the sweep's per-repository failures:
 * it is reported and the other sponsors carry on.
 */
export async function sweepReconciliationCatchups(
  dependencies: ReconciliationCatchupDependencies,
): Promise<ReconciliationCatchupSummary> {
  const repositories = await dependencies.listActiveRepositorySponsors();
  const threshold = readDiffOnlyBacklogThreshold({ RECONCILIATION_DIFF_ONLY_BACKLOG: readEnv("RECONCILIATION_DIFF_ONLY_BACKLOG") });
  const now = dependencies.now ?? (() => new Date());
  const bySponsor = new Map<string, string[]>();
  for (const { repositoryId, sponsorId } of repositories) {
    const ids = bySponsor.get(sponsorId);
    if (ids === undefined) bySponsor.set(sponsorId, [repositoryId]);
    else ids.push(repositoryId);
  }

  const summary: ReconciliationCatchupSummary = { enqueued: 0, requeued: 0, completed: 0, failed: 0 };
  for (const sponsorId of [...bySponsor.keys()].sort()) {
    if (((await dependencies.backlog.getSponsorBacklog(sponsorId)) ?? 0) <= threshold) continue;
    try {
      // The re-queue check is bounded to the sponsor's terminal rows.
      const requeue: string[] = [];
      for (const repositoryId of await dependencies.catchups.requeueCandidateIds(sponsorId)) {
        const cached = await dependencies.evidence.getReconciliationEvidence(repositoryId);
        if (cached !== null && cached.formatVersion === RECONCILIATION_EVIDENCE_FORMAT
          && !(await dependencies.evidence.hasDerivedRowsBelowFoldRevision(repositoryId, FOLD_REVISION))) {
          continue;
        }
        requeue.push(repositoryId);
      }
      const outcome = await dependencies.catchups.advance({
        sponsorId,
        activeRepositoryIds: bySponsor.get(sponsorId)!,
        requeueRepositoryIds: requeue,
        now: now(),
        enqueue: dependencies.enqueue,
      });
      summary.enqueued += outcome.enqueued === null ? 0 : 1;
      summary.requeued += outcome.requeued;
      summary.completed += outcome.completed === null ? 0 : 1;
      summary.failed += outcome.failed === null ? 0 : 1;
    } catch (error) {
      console.error("Reconciliation catch-up advance failed for sponsor", sponsorId, errorLogToken(error));
    }
  }
  return summary;
}
