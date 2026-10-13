import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { calculateSettlement } from "@/lib/domain/settlement";
import type { SettlementRow } from "@/lib/fold/postgres-row-mapping";
import type { FoldResult, FoldSettlement } from "@/lib/fold/repository-fold";
import { normalizeInstanceUrl } from "@/lib/forge/identities";

type IdentityClaimSettlementRow = Pick<
  SettlementRow,
  | "id"
  | "fold_revision"
  | "issue_id"
  | "pull_request_id"
  | "creditor_id"
  | "creditor_github_login"
  | "debtor_id"
  | "opening_comparison_points"
  | "settled_points"
>;

export async function claimGitHubIdentity(
  sql: SqlClient,
  userId: string,
  githubUserId: number,
): Promise<void> {
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    throw new Error("GitHub user id must be a positive integer.");
  }
  await sql.begin(async (transaction) => {
    // Fence against concurrent fold publications (issue 472): a publication takes
    // its repository's registered_repositories row lock as its own first statement,
    // so claiming under every such row lock orders a claim against every
    // publication transaction — one committing between the publication's identity
    // re-resolution and its materialization writes can no longer be overwritten by
    // the stale snapshot. The claim's write scope is every repository, so the
    // fence's scope is every repository; row locks release at COMMIT/ROLLBACK, so
    // unlike the per-repository advisory locks there is no session-lock pool
    // hazard. Ordered by id so two concurrent claims serialize without deadlock;
    // a publication takes exactly its one row and waits on nothing else, so no
    // cycle exists with concurrent publications either.
    await transaction`select id from registered_repositories order by id for update`;
    const selfWorkSettlements = await transaction<IdentityClaimSettlementRow[]>`
      select
        settlements.id,
        settlements.fold_revision,
        settlements.issue_id,
        settlements.pull_request_id,
        settlements.creditor_id,
        settlements.creditor_github_login,
        settlements.debtor_id,
        settlements.opening_comparison_points,
        settlements.settled_points
      from settlements
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where settlements.status = ${"UNCLAIMED"}
        and settlements.provider = ${"github"}
        and settlements.creditor_github_user_id = ${githubUserId}
        and settlements.debtor_id = ${userId}
        and pull_requests.merged_at is not null
        and participation_eligible_at(${userId}, pull_requests.merged_at)
    `;
    for (const settlement of selfWorkSettlements) {
      await transaction`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (
          ${settlement.pull_request_id}, ${settlement.issue_id}, ${userId},
          ${settlement.opening_comparison_points}, ${settlement.settled_points}, ${settlement.fold_revision}
        )
        on conflict (pull_request_id, issue_id) do update
        set user_id = excluded.user_id,
            opening_comparison_points = excluded.opening_comparison_points,
            actual_points = excluded.actual_points,
            -- Identity claims carry values forward without recomputing them;
            -- keep the older provenance when either row came from older logic.
            fold_revision = least(self_work_calibrations.fold_revision, excluded.fold_revision)
      `;
      await transaction`delete from settlements where id = ${settlement.id}`;
    }

    await transaction`
      update pull_requests
      set author_id = ${userId}
      where author_github_user_id = ${githubUserId}
        and exists (
          select 1 from registered_repositories
          where registered_repositories.id = pull_requests.repository_id
            and registered_repositories.provider = 'github'
        )
    `;
    await transaction`
      update settlements
      set creditor_id = ${userId}, status = ${"SETTLED"}
      from users as creditor, users as debtor, pull_requests
      where settlements.status = ${"UNCLAIMED"}
        and settlements.provider = ${"github"}
        and settlements.creditor_github_user_id = ${githubUserId}
        and settlements.debtor_id <> ${userId}
        and creditor.id = ${userId}
        and debtor.id = settlements.debtor_id
        and pull_requests.id = settlements.pull_request_id
        and pull_requests.merged_at is not null
        and participation_eligible_at(creditor.id, pull_requests.merged_at)
        and participation_eligible_at(debtor.id, pull_requests.merged_at)
    `;
  });
}

/**
 * The GitLab analogue of claimGitHubIdentity (contract decision 3): linking a
 * forge identity claims the PAST UNCLAIMED GitLab settlements its exact
 * triple — (provider, instance_url, forge_user_id); never the login — already
 * produced, retroactively, under the same participation guards the GitHub
 * claim applies. The settlement's own provider and instance_url columns
 * (written by the fold since 038) scope the match, so a forge id on another
 * instance or another forge never resolves here.
 */
export async function claimForgeIdentity(
  sql: SqlClient,
  input: { userId: string; instanceUrl: string; forgeUserId: number },
): Promise<void> {
  if (!Number.isSafeInteger(input.forgeUserId) || input.forgeUserId <= 0) {
    throw new Error("Forge user id must be a positive integer.");
  }
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  await sql.begin(async (transaction) => {
    // The same publication fence claimGitHubIdentity takes (issue 472).
    await transaction`select id from registered_repositories order by id for update`;
    const selfWorkSettlements = await transaction<IdentityClaimSettlementRow[]>`
      select
        settlements.id,
        settlements.fold_revision,
        settlements.issue_id,
        settlements.pull_request_id,
        settlements.creditor_id,
        settlements.creditor_github_login,
        settlements.debtor_id,
        settlements.opening_comparison_points,
        settlements.settled_points
      from settlements
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where settlements.status = ${"UNCLAIMED"}
        and settlements.provider = ${"gitlab"}
        and settlements.instance_url = ${instanceUrl}
        and settlements.creditor_github_user_id = ${input.forgeUserId}
        and settlements.debtor_id = ${input.userId}
        and pull_requests.merged_at is not null
        and participation_eligible_at(${input.userId}, pull_requests.merged_at)
    `;
    for (const settlement of selfWorkSettlements) {
      await transaction`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (
          ${settlement.pull_request_id}, ${settlement.issue_id}, ${input.userId},
          ${settlement.opening_comparison_points}, ${settlement.settled_points}, ${settlement.fold_revision}
        )
        on conflict (pull_request_id, issue_id) do update
        set user_id = excluded.user_id,
            opening_comparison_points = excluded.opening_comparison_points,
            actual_points = excluded.actual_points,
            fold_revision = least(self_work_calibrations.fold_revision, excluded.fold_revision)
      `;
      await transaction`delete from settlements where id = ${settlement.id}`;
    }

    await transaction`
      update settlements
      set creditor_id = ${input.userId}, status = ${"SETTLED"}
      from users as creditor, users as debtor, pull_requests
      where settlements.status = ${"UNCLAIMED"}
        and settlements.provider = ${"gitlab"}
        and settlements.instance_url = ${instanceUrl}
        and settlements.creditor_github_user_id = ${input.forgeUserId}
        and settlements.debtor_id <> ${input.userId}
        and creditor.id = ${input.userId}
        and debtor.id = settlements.debtor_id
        and pull_requests.id = settlements.pull_request_id
        and pull_requests.merged_at is not null
        and participation_eligible_at(creditor.id, pull_requests.merged_at)
        and participation_eligible_at(debtor.id, pull_requests.merged_at)
    `;
  });
}

/**
 * Re-resolve the identities a stale fold snapshot left unclaimed, so publishing
 * it does not undo a claim made since the snapshot was taken (issue 446).
 *
 * A fold captured before a contributor's Overflow account existed marks their
 * settlements UNCLAIMED (creditor unrecorded, only a GitHub user id) and their
 * pull requests authorless. `claimGitHubIdentity` later flips those rows, and
 * materialization rewrites the same tables from the fold — replaying the
 * snapshot verbatim would write UNCLAIMED back over SETTLED, resurrect a
 * settlement the claim moved into `self_work_calibrations`, and clear the
 * claimed `pull_requests.author_id`. Inside this publication transaction,
 * resolve each unclaimed GitHub identity against the users table and recompute
 * the row the fold would produce today, evaluating the claim's own guards
 * against current data.
 *
 * The resolution is only as current as this transaction's users-table read: a
 * claim committing between that read and the materialization writes below
 * would be overwritten by those writes. claimGitHubIdentity fences against
 * this by taking every registered_repositories row lock, in id order, as its
 * own first statement — a claim waits here for this publication to commit
 * before it applies, so this window is closed rather than merely self-healing.
 *
 * Returns a NEW fold — callers retain and reuse fold objects across runs, so
 * the input is never mutated.
 */
export async function reResolveIdentityClaims(
  sql: TransactionClient,
  fold: FoldResult,
): Promise<FoldResult> {
  const githubUserIds = new Set<number>();
  for (const settlement of fold.settlements) {
    if (settlement.status === "UNCLAIMED" && settlement.creditorGitHubUserId !== null) {
      githubUserIds.add(settlement.creditorGitHubUserId);
    }
  }
  for (const pullRequest of fold.pullRequests) {
    if (pullRequest.authorGitHubUserId !== null) {
      githubUserIds.add(pullRequest.authorGitHubUserId);
    }
  }
  if (githubUserIds.size === 0) {
    return fold;
  }

  const rows = await sql<{ github_user_id: string; id: string }[]>`
    select github_user_id, id from users
    where github_user_id = any(${sql.array([...githubUserIds].map(String))}::bigint[])
  `;
  const usersByGitHubId = new Map(rows.map((row) => [Number(row.github_user_id), row.id]));

  // Mirrors claimGitHubIdentity's unconditional `update pull_requests set
  // author_id`: an identity claim is authoritative for authorship, with no
  // eligibility filter on this path.
  const pullRequests = fold.pullRequests.map((pullRequest) => {
    if (pullRequest.authorGitHubUserId === null) {
      return pullRequest;
    }
    const userId = usersByGitHubId.get(pullRequest.authorGitHubUserId);
    return userId === undefined ? pullRequest : { ...pullRequest, authorId: userId };
  });

  const selfWorkCalibrations = [...fold.selfWorkCalibrations];
  const settlements: FoldSettlement[] = [];
  for (const settlement of fold.settlements) {
    const claimedCreditorId = settlement.status === "UNCLAIMED" && settlement.creditorGitHubUserId !== null
      ? usersByGitHubId.get(settlement.creditorGitHubUserId)
      : undefined;
    if (claimedCreditorId === undefined) {
      settlements.push(settlement);
      continue;
    }

    // The claim's own WHERE clause, evaluated against current data: a
    // settlement it would not have flipped stays UNCLAIMED here too. When the
    // claimed identity is the debtor, both terms name the same user — the
    // self-work guard the claim applies.
    const [guard] = await sql<{ eligible: boolean }[]>`
      select participation_eligible_at(${claimedCreditorId}, ${settlement.mergedAt})
        and participation_eligible_at(${settlement.debtorId}, ${settlement.mergedAt}) as eligible
    `;
    if (guard?.eligible !== true) {
      settlements.push(settlement);
      continue;
    }

    if (claimedCreditorId === settlement.debtorId) {
      // Self-work: the claim deletes the settlement and records the calibration
      // with the field mapping the fold itself uses, so the rewritten fold
      // describes exactly those rows.
      selfWorkCalibrations.push({
        githubIssueId: settlement.githubIssueId,
        githubPullRequestId: settlement.githubPullRequestId,
        userId: claimedCreditorId,
        openingComparisonPoints: settlement.openingComparisonPoints,
        actualLabel: settlement.settledLabel,
        actualPoints: settlement.settledPoints,
        actualLabelEventId: settlement.settledLabelEventId,
        actualLabelActorLogin: settlement.settledLabelActorLogin,
        actualLabelAppliedAt: settlement.settledLabelAppliedAt,
        rationaleCommentId: settlement.settledRationaleCommentId,
        rationaleActorLogin: settlement.settledRationaleActorLogin,
        rationaleCommentedAt: settlement.settledRationaleCommentedAt,
        mergeCommitOid: settlement.mergeCommitOid,
        mergedAt: settlement.mergedAt,
      });
      continue;
    }

    // Re-resolve exactly as toSettlement prices a known author. reviewRounds on
    // the fold settlement is a count, so the decision's review ids are stand-ins
    // consistent with it.
    const decision = calculateSettlement({
      creditorId: claimedCreditorId,
      debtorId: settlement.debtorId,
      opening: settlement.openingComparisonPoints,
      settled: settlement.settledPoints,
      reviewIds: Array.from({ length: settlement.reviewRounds }, (_, index) => String(index)),
    });
    settlements.push(
      decision.status === "SETTLED"
        ? { ...settlement, creditorId: claimedCreditorId, credits: decision.credits, status: "SETTLED" }
        : { ...settlement, credits: 0, status: "UNSETTLED" },
    );
  }

  return { ...fold, pullRequests, settlements, selfWorkCalibrations };
}
