import type { JSONValue } from "postgres";
import type { TransactionClient } from "@/lib/db/types";
import { narrowCachedIssueBodies, type BodyBearingCachedIssue } from "@/lib/fold/reconciliation-evidence";

/**
 * How long after a merge the fold's settlement evidence window stays open.
 *
 * Mirrors EVIDENCE_ORDERING_GRACE_MS
 * (src/lib/fold/repository-fold.ts:307, bounds applied at :968-970 and the
 * window close at :997): a settlement fold can still price a merge from
 * fifteen minutes before its final commit to fifteen minutes after the merge
 * itself, so a merge younger than that whose settlement has not landed yet
 * could still produce one.
 */
const SETTLEMENT_EVIDENCE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Scrubs the free text a repository's rows hold, in place, inside the
 * unregistration transaction (issue 681).
 *
 * The materialized issue and pull request body columns are nulled
 * unconditionally: no reader consults them, and a repository that may return
 * through re-registration keeps every identity-bearing column it had.
 *
 * The evidence cache row is rewritten in place only when no fold can still run
 * for the repository:
 *
 * 1. **No pending job.** The job runner claims exactly PENDING rows due by
 *    run_after and RUNNING rows whose lease has expired or predates lease
 *    durations (src/lib/fold/postgres-store.ts:1313-1321), so PENDING and
 *    RUNNING are pending work and FAILED is the one state the runner will not
 *    execute. A FAILED row is terminal here because every revival path is
 *    closed to an unregistered repository at the moment this gate runs: the
 *    sweep enqueues only active repositories (src/lib/fold/sweep.ts:125, via
 *    the active-only listing at src/lib/fold/postgres-store.ts:774-776) and
 *    this transaction has already set active = false. The row is therefore
 *    scrubbable when it is absent (a completed fold deleted it —
 *    src/lib/fold/postgres-store.ts:1415) or FAILED.
 * 2. **No open settlement evidence window.** A pull request of this repository
 *    merged within the last fifteen minutes that has no settlements row yet
 *    could still have one written by a later fold, so its evidence window is
 *    still open. A settled merge no longer holds the window open — that is the
 *    fold's own evidence rule: outside the window a settled label proves
 *    nothing (src/lib/fold/repository-fold.ts:968-976).
 *
 * When either condition fails the cache is left byte-for-byte untouched —
 * never partially scrubbed — and the repository's free text waits for the
 * runbook. The cached `pull_requests` column (reviews and raw diffs, the
 * settlement proof material) is never written on any path.
 */
export async function scrubRepositoryFreeText(
  transaction: TransactionClient,
  repositoryId: string,
): Promise<void> {
  await transaction`update issues set body = null where repository_id = ${repositoryId}`;
  await transaction`update pull_requests set body = null where repository_id = ${repositoryId}`;

  const [gate] = await transaction<{
    job_state: string | null;
    evidence_window_open: boolean;
  }[]>`
    select
      (select state::text from repository_reconciliation_jobs
        where repository_id = ${repositoryId}) as job_state,
      exists (
        select 1
        from pull_requests as pull_request
        where pull_request.repository_id = ${repositoryId}
          and pull_request.merged_at is not null
          and pull_request.merged_at > ${new Date(Date.now() - SETTLEMENT_EVIDENCE_WINDOW_MS)}
          and not exists (
            select 1 from settlements as settlement
              where settlement.pull_request_id = pull_request.id
          )
      ) as evidence_window_open
  `;
  const cacheIsScrubable = gate !== undefined
    && (gate.job_state === null || gate.job_state === "FAILED")
    && !gate.evidence_window_open;
  if (!cacheIsScrubable) {
    return;
  }

  const [evidence] = await transaction<{ issues: BodyBearingCachedIssue[] }[]>`
    select issues from repository_reconciliation_evidence where repository_id = ${repositoryId}
  `;
  if (evidence === undefined) {
    return;
  }
  // The narrowing is idempotent over already-narrowed caches, and the spread it
  // maps with leaves every other cached field — ids, reviews, raw diffs —
  // exactly as it found them.
  await transaction`
    update repository_reconciliation_evidence
    set issues = ${transaction.json(narrowCachedIssueBodies(evidence.issues) as unknown as JSONValue)}
    where repository_id = ${repositoryId}
  `;
}
