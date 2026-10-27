import type { JSONValue } from "postgres";
import type { IssueState, PullRequestState, SqlClient, TransactionClient } from "@/lib/db/types";
import { recordNewPolicyViolations } from "@/lib/fold/policy-violation-record";
import type { ReconciliationCostCharge } from "@/lib/fold/reconciliation-fairness";
import { DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT, synchronizeReconciliationEvidence } from "@/lib/fold/evidence-facts";
import type { ReconciliationSynchronization } from "@/lib/fold/reconciliation-evidence";
import { reResolveIdentityClaims } from "@/lib/fold/identity-claims";
import { nullableTimestampToIso, timestampToIso, toSafeInteger, recordChange, requiredId } from "@/lib/fold/postgres-row-mapping";
import type { RepositoryCoordinator } from "@/lib/fold/repository-coordination";
import { scrubSuppressedForgeData } from "@/lib/fold/data-subject-suppression";
import type { FoldResult } from "@/lib/fold/repository-fold";
import type { ReconciliationDeltas, ReconciliationHeldBy } from "@/lib/fold/reconcile";
import { materializeSettlements, loadGrantedSettlementOverrides, loadExistingSettlements, materializeSelfWorkCalibrations, loadExistingSelfWorkCalibrations, materializeUnwritableClosures } from "@/lib/fold/derived-row-materialization";

type RepositoryFoldRevisionCountsRow = {
  repository_id: string;
  owner_name: string;
  rows_at_revision: number;
  rows_below_revision: number;
  rederivation_requested_at: Date | null;
};

type RepositoryRederivationRequestRow = {
  repository_id: string;
  owner_name: string;
  rederivation_requested_at: Date | null;
};

type IssueRow = {
  id: string;
  github_issue_id: number | string;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
  owner_github_login: string | null;
  opening_source_event_id: string | null;
  opening_source_actor_login: string | null;
  opening_source_at: string | Date | null;
  settled_label: string | null;
  settled_points: number | null;
  settled_label_event_id: string | null;
  settled_label_actor_login: string | null;
  settled_label_applied_at: string | Date | null;
  settled_rationale_comment_id: string | null;
  settled_rationale_actor_login: string | null;
  settled_rationale_commented_at: string | Date | null;
};

type PullRequestRow = {
  id: string;
  github_pull_request_id: number | string;
  merge_commit_oid?: string | null;
  merged_at?: string | Date | null;
};

/**
 * How many of one repository's derived rows carry the fold revision asked about,
 * and how many were written by an older revision of the fold.
 *
 * Rows stamped above the revision asked about are in neither count: they were
 * written by logic newer than the caller's, so calling them stale would be
 * wrong and calling them current would hide the rollback that produced them.
 */
export type RepositoryFoldRevisionCounts = {
  repositoryId: string;
  ownerName: string;
  rowsAtRevision: number;
  rowsBelowRevision: number;
  rederivationRequestedAt: Date | null;
};

/**
 * A repository together with the re-derivation request outstanding against it,
 * where a null timestamp means none is.
 */
export type RepositoryRederivationRequest = {
  repositoryId: string;
  ownerName: string;
  rederivationRequestedAt: Date | null;
};

export class PostgresFoldMaterializationStore {
  public constructor(
    private readonly sql: SqlClient,
    private readonly coordinator: RepositoryCoordinator,
    private readonly options: { reconciliationFactByteLimit?: number },
  ) {}

  public async hasDerivedRowsBelowFoldRevision(repositoryId: string, revision: number): Promise<boolean> {
    const [row] = await this.sql<{ stale: boolean }[]>`
      select exists (
        select 1 from settlements
        join issues on issues.id = settlements.issue_id
        where issues.repository_id = ${repositoryId} and settlements.fold_revision < ${revision}
      ) or exists (
        select 1 from self_work_calibrations
        join issues on issues.id = self_work_calibrations.issue_id
        where issues.repository_id = ${repositoryId} and self_work_calibrations.fold_revision < ${revision}
      ) or exists (
        select 1 from unwritable_closures
        join issues on issues.id = unwritable_closures.issue_id
        where issues.repository_id = ${repositoryId} and unwritable_closures.fold_revision < ${revision}
      ) as stale
    `;
    return row.stale;
  }

  /**
   * Every active repository's derived-row stamp counts, in one pass over the
   * three derived tables rather than one read per issue: a moderator asking
   * "what is still the output of older logic?" must not cost a query per row.
   *
   * Reported for every active repository, including one holding no derived rows
   * at all, so the answer is the registered catalog rather than only the
   * repositories that happen to have been folded.
   */
  public async listRepositoryFoldRevisionCounts(revision: number): Promise<RepositoryFoldRevisionCounts[]> {
    const rows = await this.sql<RepositoryFoldRevisionCountsRow[]>`
      select
        repositories.id as repository_id,
        repositories.owner_name,
        coalesce(derived.rows_at_revision, 0)::int as rows_at_revision,
        coalesce(derived.rows_below_revision, 0)::int as rows_below_revision,
        jobs.rederivation_requested_at
      from registered_repositories as repositories
      left join (
        select
          issues.repository_id,
          count(*) filter (where derived_rows.fold_revision = ${revision}) as rows_at_revision,
          count(*) filter (where derived_rows.fold_revision < ${revision}) as rows_below_revision
        from (
          select issue_id, fold_revision from settlements
          union all
          select issue_id, fold_revision from self_work_calibrations
          union all
          select issue_id, fold_revision from unwritable_closures
        ) as derived_rows
        join issues on issues.id = derived_rows.issue_id
        group by issues.repository_id
      ) as derived on derived.repository_id = repositories.id
      -- A repository owns at most one queue row, so this join cannot fan the counts out.
      left join repository_reconciliation_jobs as jobs on jobs.repository_id = repositories.id
      where repositories.active = true
      order by repositories.owner_name, repositories.id
    `;
    return rows.map((row) => ({
      repositoryId: row.repository_id,
      ownerName: row.owner_name,
      rowsAtRevision: row.rows_at_revision,
      rowsBelowRevision: row.rows_below_revision,
      rederivationRequestedAt: row.rederivation_requested_at,
    }));
  }

  /**
   * The outstanding re-derivation request for one active repository, or null
   * when this deployment serves no such repository. Answering null is what lets
   * a caller refuse an unknown target before writing a queue row for it.
   */
  public async findRepositoryRederivationRequest(
    repositoryId: string,
  ): Promise<RepositoryRederivationRequest | null> {
    const [row] = await this.sql<RepositoryRederivationRequestRow[]>`
      select
        repositories.id as repository_id,
        repositories.owner_name,
        jobs.rederivation_requested_at
      from registered_repositories as repositories
      left join repository_reconciliation_jobs as jobs on jobs.repository_id = repositories.id
      where repositories.id = ${repositoryId} and repositories.active = true
    `;
    if (row === undefined) {
      return null;
    }
    return {
      repositoryId: row.repository_id,
      ownerName: row.owner_name,
      rederivationRequestedAt: row.rederivation_requested_at,
    };
  }

  public async beginRun(repositoryId: string, options?: { rederivation: boolean }): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      insert into reconciliation_runs (repository_id, status, rederivation)
      values (${repositoryId}, ${"PENDING"}, ${options?.rederivation ?? false})
      returning id
    `;
    if (row === undefined) {
      throw new Error("Reconciliation run insert returned no row.");
    }
    return row.id;
  }

  public async failRun(runId: string, errorMessage: string, cost?: Omit<ReconciliationCostCharge, "completedAt"> | null): Promise<void> {
    void errorMessage;
    const observation = cost && (cost.observedResponses > 0 || cost.unmeasuredResponses > 0) ? cost : null;
    await this.sql`
      update reconciliation_runs
      set status = ${"FAILED"}, completed_at = now(), error_message = ${"Reconciliation failed."},
        graphql_cost = ${observation?.observedCost ?? null}, graphql_cost_sponsor_id = ${observation?.sponsorId ?? null},
        graphql_observed_responses = ${observation?.observedResponses ?? null},
        graphql_unmeasured_responses = ${observation?.unmeasuredResponses ?? null}
      where id = ${runId} and status = 'PENDING'
    `;
  }

  public async holdRun(runId: string, message: string, heldBy: ReconciliationHeldBy, cost?: Omit<ReconciliationCostCharge, "completedAt"> | null): Promise<void> {
    const observation = cost && (cost.observedResponses > 0 || cost.unmeasuredResponses > 0) ? cost : null;
    await this.sql`
      update reconciliation_runs
      set status = ${"HELD"}, completed_at = now(), error_message = ${message}, held_by = ${heldBy},
        graphql_cost = ${observation?.observedCost ?? null}, graphql_cost_sponsor_id = ${observation?.sponsorId ?? null},
        graphql_observed_responses = ${observation?.observedResponses ?? null},
        graphql_unmeasured_responses = ${observation?.unmeasuredResponses ?? null}
      where id = ${runId} and status = 'PENDING'
    `;
  }

  public async completeRun(runId: string): Promise<void> {
    await this.sql`
      update reconciliation_runs
      set status = ${"COMPLETED"}, completed_at = now(), error_message = null
      where id = ${runId} and status = 'PENDING'
    `;
  }

  public async materialize(input: {
    repositoryId: string;
    runId: string;
    fold: FoldResult;
    synchronization?: ReconciliationSynchronization;
    cost?: ReconciliationCostCharge;
  }): Promise<ReconciliationDeltas> {
    const cost = input.cost;
    if (cost !== undefined && (
      !Number.isSafeInteger(cost.observedResponses) || cost.observedResponses < 0
      || !Number.isSafeInteger(cost.unmeasuredResponses) || cost.unmeasuredResponses < 0
      || !(cost.completedAt instanceof Date) || !Number.isFinite(cost.completedAt.getTime())
      || (cost.observedCost === null ? cost.observedResponses !== 0
        : !Number.isSafeInteger(cost.observedCost) || cost.observedCost < 0 || cost.observedResponses === 0)
    )) {
      throw new Error("Invalid reconciliation cost observation.");
    }
    return this.coordinator.withRepositoryPublication(input.repositoryId, async (transaction) => {
      const [run] = await transaction<{ status: string; graphql_cost_sponsor_id: string | null }[]>`
        select status, graphql_cost_sponsor_id from reconciliation_runs
        where id = ${input.runId} and repository_id = ${input.repositoryId} for update
      `;
      // Reject terminal or charged runs before any derived write.
      if (run?.status !== "PENDING" || (cost !== undefined && run.graphql_cost_sponsor_id !== null)) {
        throw new Error(cost === undefined ? "Reconciliation publication requires a pending run."
          : "Reconciliation cost publication requires a pending run.");
      }
      // Data-subject suppressions check the import write itself (issue 1071):
      // inside the publication transaction, before any derived row or evidence
      // fact is written, so a pass that commits after a removal can never
      // re-write a suppressed person's identifiers.
      const scrubbed = await scrubSuppressedForgeData(transaction, input.repositoryId, input);
      if (scrubbed.synchronization !== undefined) {
        await synchronizeReconciliationEvidence(transaction, input.repositoryId, scrubbed.synchronization,
          this.options.reconciliationFactByteLimit ?? DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT);
      }
      // A stale snapshot must not replay a pre-claim state over rows an
      // identity claim has since written (issue 446), so resolve the fold's
      // unclaimed GitHub identities inside this publication transaction before
      // any materialization applies fold state.
      const resolved = await reResolveIdentityClaims(transaction, scrubbed.fold);
      const publication = { ...scrubbed, fold: resolved };
      // One snapshot of the granted corrections for the whole run: settlements
      // and calibrations are two ways of recording the same issue's outcome, so
      // reading the table twice could price one against a grant the other never
      // saw. Reading it before `upsertIssues` cannot miss one: migration 009
      // gives `settlement_override_requests.issue_id` a foreign key to
      // `issues.id`, so a request exists only for an issue already in the
      // table, and an issue this run is about to insert can carry no grant.
      const [existingSettlements, existingSelfWorkCalibrations, grantedOverrides] = await Promise.all([
        loadExistingSettlements(transaction, input.repositoryId),
        loadExistingSelfWorkCalibrations(transaction, input.repositoryId),
        loadGrantedSettlementOverrides(transaction, input.repositoryId),
      ]);
      const issueIds = await upsertIssues(transaction, input.repositoryId, publication.fold);
      const pullRequestIds = await upsertPullRequests(transaction, input.repositoryId, publication.fold, issueIds);
      await replacePullRequestIssueLinks(transaction, input.repositoryId, publication.fold, issueIds, pullRequestIds);
      const settlementDeltas = await materializeSettlements(
        transaction,
        publication,
        issueIds,
        pullRequestIds,
        existingSettlements,
        grantedOverrides,
      );
      const selfWorkDeltas = await materializeSelfWorkCalibrations(
        transaction,
        publication,
        issueIds,
        pullRequestIds,
        existingSelfWorkCalibrations,
        grantedOverrides,
      );
      const unwritableClosureDeltas = await materializeUnwritableClosures(transaction, publication, issueIds, pullRequestIds);
      await materializeReviewRounds(transaction, publication.fold, pullRequestIds);
      const removalDeltas = await deleteAbsentMaterialization(
        transaction,
        input.repositoryId,
        publication.fold,
        issueIds,
        pullRequestIds,
        input.runId,
        publication.synchronization,
      );
      await recordNewPolicyViolations(transaction, input.repositoryId, input.runId, publication.fold.policyViolations);
      if (input.synchronization !== undefined) {
        await transaction`update registered_repositories set reconciliation_not_before = null where id = ${input.repositoryId}`;
      }
      if (cost !== undefined) {
        await transaction`
          insert into repository_reconciliation_usage
            (sponsor_id, repository_id, debt, measured_at, rate_per_second)
          values (${cost.sponsorId}, ${input.repositoryId}, ${cost.observedCost ?? 0}, ${cost.completedAt}, 0)
          on conflict (sponsor_id, repository_id) do update set
            debt = greatest(0, repository_reconciliation_usage.debt
              - repository_reconciliation_usage.rate_per_second
              * greatest(0, extract(epoch from (excluded.measured_at - repository_reconciliation_usage.measured_at))))
              + excluded.debt,
            measured_at = greatest(repository_reconciliation_usage.measured_at, excluded.measured_at)
        `;
        const completed = await transaction`
          update reconciliation_runs
          set status = ${"COMPLETED"}, completed_at = now(), error_message = null,
            graphql_cost = ${cost.observedCost}, graphql_cost_sponsor_id = ${cost.sponsorId},
            graphql_observed_responses = ${cost.observedResponses}, graphql_unmeasured_responses = ${cost.unmeasuredResponses}
          where id = ${input.runId} and repository_id = ${input.repositoryId}
            and status = 'PENDING' and graphql_cost_sponsor_id is null
          returning id
        `;
        if (completed.length !== 1) throw new Error("Reconciliation cost publication requires a pending run.");
      } else {
        const completed = await transaction`
          update reconciliation_runs
          set status = ${"COMPLETED"}, completed_at = now(), error_message = null
          where id = ${input.runId} and repository_id = ${input.repositoryId} and status = 'PENDING'
          returning id
        `;
        if (completed.length !== 1) throw new Error("Reconciliation publication requires a pending run.");
      }
      return combineDeltas(settlementDeltas, selfWorkDeltas, unwritableClosureDeltas, removalDeltas);
    });
  }
}

async function upsertIssues(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  // Raw fields share GitHub's clock with webhooks. A cached or in-flight fold
  // may be older; its derived evidence must still be materialized below.
  const acceptsRawView = sql`issues.github_updated_at is null or excluded.github_updated_at >= issues.github_updated_at`;
  // The publication holds this registration row `for update`, so an unregistration either committed before
  // this read or scrubs after this transaction; a pass that read before it must not write the statement back.
  const [registration] = await sql<{ active: boolean }[]>`select active from registered_repositories where id = ${repositoryId}`;
  const registered = registration?.active === true;
  for (const issue of fold.issues) {
    // Absent means this pass held the issue from cache, with no comment bodies to read it from.
    const doneWhen = !registered ? sql`null` : issue.doneWhen === undefined
      ? sql`issues.done_when`
      : sql`case when ${acceptsRawView} then excluded.done_when else issues.done_when end`;
    const [row] = await sql<IssueRow[]>`
      insert into issues (
        github_issue_id, repository_id, issue_number, title, url, state, github_updated_at,
        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
        opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id, settled_rationale_actor_login,
        settled_rationale_commented_at, claim_assignee_github_login, claim_assignee_github_user_id,
        asks_outside_repository, done_when
      )
      values (
        ${issue.githubIssueId}, ${repositoryId}, ${issue.number}, ${issue.title}, ${issue.url}, ${issue.state}, ${issue.updatedAt},
        ${issue.ownerGitHubLogin}, ${issue.openingLabel}, ${issue.openingComparisonPoints}, ${issue.openingReservePoints},
        ${issue.openingSourceEventId}, ${issue.openingSourceActorLogin}, ${issue.openingSourceAt},
        ${issue.settledLabel}, ${issue.settledPoints}, ${issue.settledLabelEventId}, ${issue.settledLabelActorLogin},
        ${issue.settledLabelAppliedAt}, ${issue.settledRationaleCommentId}, ${issue.settledRationaleActorLogin},
        ${issue.settledRationaleCommentedAt}, ${issue.claimAssigneeGitHubLogin}, ${issue.claimAssigneeGitHubUserId},
        ${issue.asksOutsideRepository}, ${registered ? issue.doneWhen?.text ?? null : null}
      )
      on conflict (github_issue_id) do update
      set issue_number = excluded.issue_number,
          title = case when ${acceptsRawView} then excluded.title else issues.title end,
          url = case when ${acceptsRawView} then excluded.url else issues.url end,
          state = case when ${acceptsRawView} then excluded.state else issues.state end,
          github_updated_at = case when ${acceptsRawView} then excluded.github_updated_at else issues.github_updated_at end,
          asks_outside_repository = case when ${acceptsRawView} then excluded.asks_outside_repository else issues.asks_outside_repository end,
          done_when = ${doneWhen},
          opening_label = case
            when issues.opening_source_event_id is null then excluded.opening_label
            else issues.opening_label
          end,
          opening_comparison_points = case
            when issues.opening_source_event_id is null then excluded.opening_comparison_points
            else issues.opening_comparison_points
          end,
          opening_reserve_points = case
            when issues.opening_source_event_id is null then excluded.opening_reserve_points
            else issues.opening_reserve_points
          end,
          owner_github_login = excluded.owner_github_login,
          opening_source_event_id = coalesce(issues.opening_source_event_id, excluded.opening_source_event_id),
          opening_source_actor_login = excluded.opening_source_actor_login,
          opening_source_at = coalesce(issues.opening_source_at, excluded.opening_source_at),
          settled_label = excluded.settled_label,
          settled_points = excluded.settled_points,
          settled_label_event_id = excluded.settled_label_event_id,
          settled_label_actor_login = excluded.settled_label_actor_login,
          settled_label_applied_at = excluded.settled_label_applied_at,
          settled_rationale_comment_id = excluded.settled_rationale_comment_id,
          settled_rationale_actor_login = excluded.settled_rationale_actor_login,
          settled_rationale_commented_at = excluded.settled_rationale_commented_at,
          claim_assignee_github_login = excluded.claim_assignee_github_login,
          claim_assignee_github_user_id = excluded.claim_assignee_github_user_id,
          updated_at = now()
      returning
        id, github_issue_id, opening_label, opening_comparison_points, opening_reserve_points,
        owner_github_login, opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id, settled_rationale_actor_login,
        settled_rationale_commented_at
    `;
    if (row === undefined) {
      throw new Error("Issue materialization returned no row.");
    }
    if (
      row.opening_label !== issue.openingLabel ||
      row.opening_comparison_points !== issue.openingComparisonPoints ||
      row.opening_reserve_points !== issue.openingReservePoints ||
      row.opening_source_event_id !== issue.openingSourceEventId ||
      timestampToIso(row.opening_source_at) !== issue.openingSourceAt
    ) {
      throw new Error("Issue opening evidence did not match immutable GitHub history.");
    }
    ids.set(issue.githubIssueId, row.id);
  }
  return ids;
}

async function upsertPullRequests(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const pullRequest of fold.pullRequests) {
    const firstIssueId = issueIds.get(pullRequest.githubIssueIds[0] ?? -1);
    if (firstIssueId === undefined) {
      throw new Error("Pull request was missing an authoritative issue.");
    }
    const [row] = await sql<PullRequestRow[]>`
      insert into pull_requests (
        github_pull_request_id, repository_id, issue_id, pull_request_number, url, title,
        author_id, author_github_login, author_github_user_id, state, merged_at, merge_commit_oid, final_commit_at, proof_sha256
      )
      values (
        ${pullRequest.githubPullRequestId}, ${repositoryId}, ${firstIssueId}, ${pullRequest.number},
        ${pullRequest.url}, ${pullRequest.title}, ${pullRequest.authorId},
        ${pullRequest.authorGitHubLogin}, ${pullRequest.authorGitHubUserId}, ${pullRequest.state}, ${pullRequest.mergedAt},
        ${pullRequest.mergeCommitOid}, ${pullRequest.finalCommitAt}, ${pullRequest.proofSha256}
      )
      on conflict (github_pull_request_id) do update
      set issue_id = excluded.issue_id,
          pull_request_number = excluded.pull_request_number,
          url = excluded.url,
          title = excluded.title,
          author_id = excluded.author_id,
          author_github_login = excluded.author_github_login,
          author_github_user_id = excluded.author_github_user_id,
          state = excluded.state,
          merged_at = excluded.merged_at,
          merge_commit_oid = excluded.merge_commit_oid,
          final_commit_at = excluded.final_commit_at,
          proof_sha256 = excluded.proof_sha256,
          updated_at = now()
      returning id, github_pull_request_id
    `;
    if (row === undefined) {
      throw new Error("Pull request materialization returned no row.");
    }
    ids.set(pullRequest.githubPullRequestId, row.id);
  }
  return ids;
}

async function materializeReviewRounds(
  sql: TransactionClient,
  fold: FoldResult,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  for (const pullRequest of fold.pullRequests) {
    const pullRequestId = requiredId(pullRequestIds, pullRequest.githubPullRequestId, "Pull request");
    await sql`delete from review_rounds where pull_request_id = ${pullRequestId}`;
    for (const review of pullRequest.reviewRounds) {
      await sql`
        insert into review_rounds (pull_request_id, github_review_id, submitted_at)
        values (${pullRequestId}, ${review.githubReviewId}, ${review.submittedAt})
      `;
    }
  }
}

async function replacePullRequestIssueLinks(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  for (const pullRequest of fold.pullRequests) {
    const pullRequestId = requiredId(pullRequestIds, pullRequest.githubPullRequestId, "Pull request");
    for (const githubIssueId of pullRequest.githubIssueIds) {
      await sql`
        insert into pull_request_issues (pull_request_id, issue_id, repository_id)
        values (${pullRequestId}, ${requiredId(issueIds, githubIssueId, "Issue")}, ${repositoryId})
        on conflict do nothing
      `;
    }
  }
}

/**
 * The columns each removal snapshot records, named per query rather than
 * borrowed from the shared `IssueRow` and `PullRequestRow`. Those two describe
 * what the upserts return, which neither contains nor is contained by what
 * these selects fetch: `IssueRow` declares no number, state, title or url, and
 * `PullRequestRow` declares only its two ids and the merge pair, so reusing
 * either here would not compile at all.
 *
 * The other direction is the one worth guarding once it does compile.
 * `IssueRow` carries the opening-source and settlement columns that neither
 * removal select fetches, and a column declared on the row type but absent
 * from the query arrives `undefined`: `JSON.stringify` drops the key on its
 * way into `before_state`, so the snapshot quietly loses a field and nothing
 * fails. Naming the fetched columns here makes reading anything else a
 * compile error.
 *
 * `id` is the one column both selects fetch that no snapshot records — it
 * addresses the delete that follows, not the item that left — so the call
 * sites intersect it in rather than putting it on these types.
 */
type RemovedIssueRow = {
  github_issue_id: number | string;
  issue_number: number;
  title: string;
  url: string;
  state: IssueState;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
  owner_github_login: string | null;
};

type RemovedPullRequestRow = {
  github_pull_request_id: number | string;
  pull_request_number: number;
  title: string;
  url: string;
  state: PullRequestState;
  author_github_login: string | null;
  merge_commit_oid: string | null;
  merged_at: string | Date | null;
};

/**
 * Deletes unreferenced issues and pull requests the fold no longer contains.
 * Dispute history retains its rows; observed nonterminal PRs refresh live state.
 *
 * Each removal is reported before deletion, so its snapshot describes the
 * materialized work that actually left. The record is written before
 * the delete, so the state it carries is read from the row that existed, and it
 * carries no `pull_request_id`: migration 004 gives that column
 * `on delete set null`, so a reference to the row being deleted is nulled by the
 * delete that follows in the same transaction. `before_state` is therefore where
 * a removal is legible, so each snapshot names the row it deleted — its number,
 * url, state and the login it carried — and not only what the fold priced.
 */
async function deleteAbsentMaterialization(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
  runId: string,
  synchronization?: ReconciliationSynchronization,
): Promise<ReconciliationDeltas> {
  const observedStates = new Map((synchronization?.issues ?? [])
    .flatMap((issue) => issue.closingPullRequests).map((pr) => [pr.id, pr.state]));
  const desiredIssueIds = new Set(issueIds.values());
  const desiredPullRequestIds = new Set(pullRequestIds.values());
  let removals = 0;
  const currentPullRequests = await sql<({ id: string } & RemovedPullRequestRow)[]>`
    select
      id, github_pull_request_id, pull_request_number, title, url, state,
      author_github_login, merge_commit_oid, merged_at
    from pull_requests where repository_id = ${repositoryId}
  `;
  const currentIssues = await sql<({ id: string } & RemovedIssueRow)[]>`
    select
      id, github_issue_id, issue_number, title, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, owner_github_login
    from issues where repository_id = ${repositoryId}
  `;

  await deleteAbsentPullRequestIssueLinks(sql, repositoryId, fold);
  for (const pullRequest of currentPullRequests) {
    if (!desiredPullRequestIds.has(pullRequest.id)) {
      // Serialize with filing before checking references in a fresh statement.
      await sql`select id from pull_requests where id = ${pullRequest.id} for update`;
      const [dispute] = await sql`
        select id from closed_pr_dispute_requests
        where pull_request_id = ${pullRequest.id} or landed_pull_request_id = ${pullRequest.id} limit 1
      `;
      if (dispute !== undefined) {
        const state = observedStates.get(toSafeInteger(pullRequest.github_pull_request_id));
        if (state !== undefined) await sql`
          update pull_requests set state = ${state}, updated_at = now()
          where id = ${pullRequest.id} and state is distinct from ${state}
        `;
        continue;
      }
      await recordChange(sql, runId, null, "PULL_REQUEST", "REMOVE", removedPullRequestState(pullRequest), null);
      await sql`delete from review_rounds where pull_request_id = ${pullRequest.id}`;
      await sql`delete from pull_request_issues where pull_request_id = ${pullRequest.id}`;
      await sql`delete from pull_requests where id = ${pullRequest.id}`;
      removals += 1;
    }
  }
  for (const issue of currentIssues) {
    if (!desiredIssueIds.has(issue.id)) {
      const [dispute] = await sql`
        select requests.id from closed_pr_dispute_requests requests
        join pull_requests closed on closed.id = requests.pull_request_id
        left join pull_requests landing on landing.id = requests.landed_pull_request_id
        where requests.issue_id = ${issue.id} or closed.issue_id = ${issue.id} or landing.issue_id = ${issue.id}
        limit 1
      `;
      if (dispute !== undefined) continue;
      // An observed issue the fold excluded (opening evidence unreadable)
      // keeps its stored row: the fold priced nothing, so there is no FoldIssue
      // to hold it, and the unreadable read is not an upstream deletion.
      if (synchronization?.keptIssueGitHubIds?.includes(toSafeInteger(issue.github_issue_id))) continue;
      await recordChange(sql, runId, null, "ISSUE", "REMOVE", removedIssueState(issue), null);
      await sql`delete from issues where id = ${issue.id}`;
      removals += 1;
    }
  }

  return { adds: 0, changes: 0, removals };
}

function removedIssueState(row: RemovedIssueRow): JSONValue {
  return {
    githubIssueId: toSafeInteger(row.github_issue_id),
    issueNumber: row.issue_number,
    title: row.title,
    url: row.url,
    state: row.state,
    ownerGitHubLogin: row.owner_github_login,
    openingLabel: row.opening_label,
    openingComparisonPoints: row.opening_comparison_points,
    openingReservePoints: row.opening_reserve_points,
  };
}

function removedPullRequestState(row: RemovedPullRequestRow): JSONValue {
  return {
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    pullRequestNumber: row.pull_request_number,
    title: row.title,
    url: row.url,
    state: row.state,
    authorGitHubLogin: row.author_github_login,
    mergeCommitOid: row.merge_commit_oid,
    mergedAt: nullableTimestampToIso(row.merged_at),
  };
}

async function deleteAbsentPullRequestIssueLinks(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<void> {
  const desired = new Set(
    fold.pullRequests.flatMap((pullRequest) =>
      pullRequest.githubIssueIds.map((githubIssueId) => `${pullRequest.githubPullRequestId}:${githubIssueId}`),
    ),
  );
  const existing = await sql<{
    pull_request_id: string;
    issue_id: string;
    github_pull_request_id: number | string;
    github_issue_id: number | string;
  }[]>`
    select links.pull_request_id, links.issue_id, pull_requests.github_pull_request_id, issues.github_issue_id
    from pull_request_issues as links
    join pull_requests on pull_requests.id = links.pull_request_id
    join issues on issues.id = links.issue_id
    where pull_requests.repository_id = ${repositoryId}
  `;
  for (const row of existing) {
    const key = `${toSafeInteger(row.github_pull_request_id)}:${toSafeInteger(row.github_issue_id)}`;
    if (!desired.has(key)) {
      await sql`
        delete from pull_request_issues
        where pull_request_id = ${row.pull_request_id} and issue_id = ${row.issue_id}
      `;
    }
  }
}

function combineDeltas(...deltas: readonly ReconciliationDeltas[]): ReconciliationDeltas {
  return deltas.reduce(
    (total, delta) => ({
      adds: total.adds + delta.adds,
      changes: total.changes + delta.changes,
      removals: total.removals + delta.removals,
    }),
    { adds: 0, changes: 0, removals: 0 },
  );
}
