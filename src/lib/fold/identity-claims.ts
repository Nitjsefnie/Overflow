import type { ParameterOrFragment } from "postgres";
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
    // Fence against concurrent fold publications: a publication takes
    // its repository's registered_repositories row lock as its own first statement,
    // so claiming under every such row lock orders a claim against every
    // publication transaction — one committing between the publication's identity
    // re-resolution and its materialization writes cannot be overwritten by the
    // stale snapshot. The claim's write scope is every repository, so the
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
        and pull_requests.merged_at is not null
        and participation_eligible_at(${userId}, pull_requests.merged_at)
        and participation_eligible_at(settlements.debtor_id, pull_requests.merged_at)
        and (settlements.debtor_id = ${userId} or ${teammateAtMerge(transaction, userId)})
    `;
    for (const settlement of selfWorkSettlements) {
      await transaction`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (
          ${settlement.pull_request_id}, ${settlement.issue_id}, ${settlement.debtor_id},
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
      set creditor_id = ${userId}, status = ${"SETTLED"}, team_id = ${teamAtSql(transaction, userId, transaction`pull_requests.merged_at`)}
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
    // The same publication fence claimGitHubIdentity takes.
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
        and pull_requests.merged_at is not null
        and participation_eligible_at(${input.userId}, pull_requests.merged_at)
        and participation_eligible_at(settlements.debtor_id, pull_requests.merged_at)
        and (settlements.debtor_id = ${input.userId} or ${teammateAtMerge(transaction, input.userId)})
    `;
    for (const settlement of selfWorkSettlements) {
      await transaction`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (
          ${settlement.pull_request_id}, ${settlement.issue_id}, ${settlement.debtor_id},
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
      set creditor_id = ${input.userId}, status = ${"SETTLED"},
          team_id = ${teamAtSql(transaction, input.userId, transaction`pull_requests.merged_at`)}
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
 * it does not undo a claim made since the snapshot was taken.
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
    const [guard] = await sql<{ eligible: boolean; team_id: string | null; teammate: boolean }[]>`
      select participation_eligible_at(${claimedCreditorId}, ${settlement.mergedAt})
          and participation_eligible_at(${settlement.debtorId}, ${settlement.mergedAt}) as eligible,
        ${teamAtSql(sql, claimedCreditorId, settlement.mergedAt)} as team_id,
        ${teammateAtSql(sql, claimedCreditorId, settlement.debtorId, settlement.mergedAt)} as teammate
    `;
    if (guard?.eligible !== true) {
      settlements.push(settlement);
      continue;
    }

    if (claimedCreditorId === settlement.debtorId || guard.teammate) {
      // Self-work: the claim deletes the settlement and records the sponsor's
      // calibration with the field mapping the fold itself uses, so the
      // rewritten fold describes exactly those rows.
      selfWorkCalibrations.push({
        githubIssueId: settlement.githubIssueId,
        githubPullRequestId: settlement.githubPullRequestId,
        userId: settlement.debtorId,
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
        ? { ...settlement, creditorId: claimedCreditorId, ...(guard.team_id !== null && { teamId: guard.team_id }),
          credits: decision.credits, status: "SETTLED" }
        : { ...settlement, credits: 0, status: "UNSETTLED" },
    );
  }

  return { ...fold, pullRequests, settlements, selfWorkCalibrations };
}

type ClaimSql = SqlClient | TransactionClient;
type ClaimValue = ParameterOrFragment<never>;

/**
 * The SQL twin of the fold's `teamAt`: the team `account` belonged to at `at`
 * (joined at or before it, not yet left, the latest such join), or null.
 */
function teamAtSql(sql: ClaimSql, account: string, at: ClaimValue) {
  return sql`(
    select memberships.team_id from team_memberships as memberships
    where memberships.user_id = ${account} and memberships.joined_at <= ${at}
      and (memberships.left_at is null or ${at} < memberships.left_at)
    order by memberships.joined_at desc limit 1
  )`;
}

/** The SQL twin of `isSelfWorkAt`'s team half: `sponsor` was, at `at`, in the team `account`'s work credits. */
function teammateAtSql(sql: ClaimSql, account: string, sponsor: ClaimValue, at: ClaimValue) {
  return sql`exists (
    select 1 from team_memberships as sponsor_memberships
    where sponsor_memberships.team_id = ${teamAtSql(sql, account, at)} and sponsor_memberships.user_id = ${sponsor}
      and sponsor_memberships.joined_at <= ${at} and (sponsor_memberships.left_at is null or ${at} < sponsor_memberships.left_at)
  )`;
}

/** `teammateAtSql` over a claim query's own settlement row: its sponsor, at its pull request's merge. */
function teammateAtMerge(sql: ClaimSql, account: string) {
  return teammateAtSql(sql, account, sql`settlements.debtor_id`, sql`pull_requests.merged_at`);
}
