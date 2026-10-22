import { getSql } from "@/lib/db/client";
import type { EnforcementState, PullRequestState, SqlClient } from "@/lib/db/types";
import { disputeComparisons, reviewEvidence } from "@/lib/moderation/closed-pr-dispute-evidence";
import { countReviewRoundsAsOf } from "@/lib/fold/review-rounds";
import { closedPrDisputeDecisionSchema } from "@/lib/moderation/closed-pr-dispute-service";
import type {
  ClosedPrDisputeDecision,
  ClosedPrDisputeDecisionInput,
  ClosedPrDisputeFilingInput,
  ClosedPrDisputeRequest,
  ClosedPrDisputeState,
  ClosedPrDisputeStore,
  ClosedPrDisputeStoreResult,
} from "@/lib/moderation/closed-pr-dispute-service";

type RequestRow = {
  id: string;
  contributor_id: string;
  pull_request_id: string;
  issue_id: string;
  landed_pull_request_id: string | null;
  landed_commit_url: string | null;
  request_reason: string;
  state: ClosedPrDisputeState;
  decision: ClosedPrDisputeDecision | null;
  decided_by: string | null;
  decided_by_sole_moderator: boolean;
  decided_reason: string | null;
  decided_at: string | Date | null;
  moderator_figure: number | null;
  awarded_points: number | null;
  created_at: string | Date;
};

type Repository = { owner_name: string; provider: string; instance_url: string | null };

export class PostgresClosedPrDisputeStore implements ClosedPrDisputeStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async fileDispute(
    input: ClosedPrDisputeFilingInput & { accountId: string },
  ): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>> {
    // Catch outside begin: postgres.js rethrows query failures after rollback.
    return this.fileDisputeInTransaction(input).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505"
        && "constraint_name" in error && error.constraint_name === "closed_pr_dispute_requests_one_open_per_pull_request") {
        return { kind: "invalid_state" };
      }
      throw error;
    });
  }

  private async fileDisputeInTransaction(
    input: ClosedPrDisputeFilingInput & { accountId: string },
  ): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>> {
    return this.sql.begin(async (transaction): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>> => {
      // Match contest filing's lock order: account first, then the target.
      const [account] = await transaction<{ id: string; enforcement_state: EnforcementState }[]>`
        select id, enforcement_state from users where id = ${input.accountId} for update
      `;
      if (account === undefined) return { kind: "not_found" };

      const [pullRequest] = await transaction<({
        id: string; author_id: string | null; issue_id: string; repository_id: string; state: PullRequestState;
      } & Repository)[]>`
        select pr.id, pr.author_id, pr.issue_id, pr.repository_id, pr.state,
          repositories.owner_name, repositories.provider, repositories.instance_url
        from pull_requests as pr
        join registered_repositories as repositories on repositories.id = pr.repository_id
        where pr.id = ${input.pullRequestId}
        for update of pr
      `;
      if (pullRequest === undefined) return { kind: "invalid_state" };
      if (pullRequest.author_id !== input.accountId) return { kind: "forbidden" };
      if (pullRequest.state !== "CLOSED") return { kind: "invalid_state" };

      const [credited] = await transaction<{ id: string }[]>`
        select id from closed_pr_dispute_requests
        where issue_id = ${pullRequest.issue_id} and decision = 'GRANTED'
        limit 1
      `;
      if (credited !== undefined) return { kind: "issue_already_credited" };

      const [automaticLanding] = await transaction<{ id: string }[]>`
        select id from pull_requests
        where issue_id = ${pullRequest.issue_id} and state = 'MERGED'
        order by merged_at asc nulls last, id asc
        limit 1
      `;
      const hasPullRequestUrl = input.landedPullRequestUrl !== undefined;
      const hasCommitUrl = input.landedCommitUrl !== undefined;
      if ((automaticLanding !== undefined && (hasPullRequestUrl || hasCommitUrl))
        || (hasPullRequestUrl && hasCommitUrl)) {
        return { kind: "invalid_input" };
      }

      let landedPullRequestId = automaticLanding?.id ?? null;
      let landedCommitUrl: string | null = null;
      if (automaticLanding === undefined) {
        if (hasPullRequestUrl) {
          const number = landedPullRequestNumber(input.landedPullRequestUrl!, pullRequest);
          if (number === null) return { kind: "invalid_input" };
          const [landing] = await transaction<{ id: string }[]>`
            select id from pull_requests
            where repository_id = ${pullRequest.repository_id}
              and pull_request_number = ${number} and state = 'MERGED'
          `;
          if (landing === undefined) return { kind: "invalid_input" };
          landedPullRequestId = landing.id;
        } else if (hasCommitUrl && input.landedCommitUrl!.trim().length > 0) {
          landedCommitUrl = input.landedCommitUrl!.trim();
        } else {
          return { kind: "invalid_input" };
        }
      }

      const [row] = await transaction<RequestRow[]>`
        insert into closed_pr_dispute_requests (
          contributor_id, pull_request_id, issue_id, landed_pull_request_id, landed_commit_url, request_reason
        ) values (
          ${input.accountId}, ${pullRequest.id}, ${pullRequest.issue_id},
          ${landedPullRequestId}, ${landedCommitUrl}, ${input.reason}
        )
        returning id, contributor_id, pull_request_id, issue_id, landed_pull_request_id, landed_commit_url,
          request_reason, state, decision, decided_by, decided_by_sole_moderator, decided_reason,
          decided_at, moderator_figure, awarded_points, created_at
      `;
      if (row === undefined) throw new Error("Closed PR dispute insert returned no row.");

      // Filing records history without changing participation eligibility: use
      // the locked account's live state on both sides, with no audit behind it.
      await transaction`
        insert into moderation_events (
          target_user_id, actor_id, audit_id, prior_state, new_state, reason, dispute_request_id, created_at
        ) values (
          ${input.accountId}, ${input.accountId}, null, ${account.enforcement_state},
          ${account.enforcement_state}, ${input.reason}, ${row.id}, clock_timestamp()
        )
      `;
      return { kind: "ok", value: toRequest(row) };
    });
  }

  public async decideDispute(input: ClosedPrDisputeDecisionInput & {
    requestId: string; moderatorAccountId: string;
  }): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>> {
    const parsed = closedPrDisputeDecisionSchema.safeParse(input);
    if (!parsed.success) return { kind: "invalid_input" };
    const { decision, figure, decidedReason } = parsed.data;
    return this.sql.begin(async (transaction): Promise<ClosedPrDisputeStoreResult<ClosedPrDisputeRequest>> => {
      const [request] = await transaction<(RequestRow & { decision_time: Date })[]>`
        select id, contributor_id, pull_request_id, issue_id, landed_pull_request_id, landed_commit_url,
          request_reason, state, decision, decided_by, decided_by_sole_moderator, decided_reason,
          decided_at, moderator_figure, awarded_points, created_at, now() as decision_time
        from closed_pr_dispute_requests where id = ${input.requestId} for update
      `;
      if (request === undefined) return { kind: "not_found" };
      if (request.state !== "OPEN") return { kind: "already_decided" };

      // Read PRs without locks: filing locks contributor then PR; taking a PR
      // lock before the contributor here would invert that order.
      const [related] = await transaction<{
        sponsor_id: string; repository_id: string; github_pull_request_id: string; landing_author_id: string | null;
      }[]>`
        select repositories.sponsor_id, closed.repository_id, closed.github_pull_request_id::text,
          landing.author_id as landing_author_id
        from issues
        join registered_repositories repositories on repositories.id = issues.repository_id
        join pull_requests closed on closed.id = ${request.pull_request_id}
        left join pull_requests landing on landing.id = ${request.landed_pull_request_id}
        where issues.id = ${request.issue_id}
      `;
      if (related === undefined) return { kind: "not_found" };
      const liveModerators = await transaction<{ id: string }[]>`
        select id from users where role = 'MODERATOR' and deleted_at is null order by id
      `;
      if (!liveModerators.some((moderator) => moderator.id === input.moderatorAccountId)) return { kind: "forbidden" };
      // Commit evidence stores no landing account: its conflict set is sponsor + contributor.
      const conflicted = [related.sponsor_id, request.contributor_id, related.landing_author_id]
        .includes(input.moderatorAccountId);
      if (conflicted && liveModerators.length > 1) return { kind: "forbidden_imposer" };
      const soleModerator = liveModerators.length === 1;

      // Serialize the same-state history event with enforcement changes.
      const [account] = await transaction<{ enforcement_state: EnforcementState }[]>`
        select enforcement_state from users where id = ${request.contributor_id} for update
      `;
      if (account === undefined) return { kind: "not_found" };
      let awardedPoints: number | null = null;
      if (decision === "GRANTED") {
        const [evidence] = await transaction<{ payload: unknown }[]>`
          select payload from repository_reconciliation_evidence_facts
          where repository_id = ${related.repository_id} and kind = 'pull_request'
            and subject_key = ${related.github_pull_request_id}
        `;
        const reviews = reviewEvidence.safeParse(evidence?.payload);
        if (!reviews.success) return { kind: "insufficient_evidence" };
        awardedPoints = Math.max(0, figure! - countReviewRoundsAsOf(reviews.data.reviews, request.decision_time.valueOf()).length);
      }

      const [row] = await transaction<RequestRow[]>`
        update closed_pr_dispute_requests set state = 'DECIDED', decision = ${decision},
          decided_by = ${input.moderatorAccountId}, decided_by_sole_moderator = ${soleModerator},
          decided_reason = ${decidedReason}, decided_at = now(),
          moderator_figure = ${decision === "GRANTED" ? figure! : null}, awarded_points = ${awardedPoints}
        where id = ${request.id}
        returning id, contributor_id, pull_request_id, issue_id, landed_pull_request_id, landed_commit_url,
          request_reason, state, decision, decided_by, decided_by_sole_moderator, decided_reason,
          decided_at, moderator_figure, awarded_points, created_at
      `;
      if (row === undefined) throw new Error("Closed PR dispute decision returned no row.");
      // Stamp history after the user lock: transaction start may predate a sanction we waited for.
      const [event] = await transaction<{ id: string }[]>`
        insert into moderation_events (target_user_id, actor_id, audit_id, prior_state, new_state, reason, dispute_request_id, created_at)
        values (${request.contributor_id}, ${input.moderatorAccountId}, null, ${account.enforcement_state},
          ${account.enforcement_state}, ${decidedReason}, ${request.id}, clock_timestamp()) returning id
      `;
      if (event === undefined) throw new Error("Closed PR dispute decision event returned no row.");

      // The landing may settle other issues; only this issue's price is reversed.
      const reversals = awardedPoints === null ? [] : await transaction<{ id: string; creditor_id: string; credits: number }[]>`
        select id, creditor_id, credits from settlements
        where pull_request_id = ${request.landed_pull_request_id} and issue_id = ${request.issue_id}
          and creditor_id <> ${related.sponsor_id} and credits > 0
      `;
      if ((awardedPoints !== null && awardedPoints > 0) || reversals.length > 0) {
        const [adjustment] = await transaction<{ id: string }[]>`
          insert into dispute_credit_adjustments (moderation_event_id, dispute_id, target_account_id, reason)
          values (${event.id}, ${request.id}, ${related.sponsor_id}, ${decidedReason}) returning id
        `;
        if (adjustment === undefined) throw new Error("Dispute credit adjustment returned no row.");
        if (awardedPoints !== null && awardedPoints > 0) await transaction`
          insert into dispute_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
          values (${adjustment.id}, null, ${request.contributor_id}, ${awardedPoints})
        `;
        for (const reversal of reversals) await transaction`
          insert into dispute_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
          values (${adjustment.id}, ${reversal.id}, ${reversal.creditor_id}, ${-reversal.credits})
        `;
      }
      return { kind: "ok", value: toRequest(row) };
    }).catch((error: unknown): ClosedPrDisputeStoreResult<ClosedPrDisputeRequest> => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505"
        && "constraint_name" in error && (error.constraint_name === "closed_pr_dispute_requests_one_grant_per_pull_request"
          || error.constraint_name === "closed_pr_dispute_requests_one_grant_per_issue")) {
        return { kind: "already_granted" };
      }
      throw error;
    });
  }

  public async listRequestsForModeration(): Promise<ClosedPrDisputeRequest[]> {
    const rows = await this.sql<RequestRow[]>`
      select id, contributor_id, pull_request_id, issue_id, landed_pull_request_id, landed_commit_url,
        request_reason, state, decision, decided_by, decided_by_sole_moderator, decided_reason,
        decided_at, moderator_figure, awarded_points, created_at
      from closed_pr_dispute_requests
      order by (state = 'OPEN') desc,
        case when state = 'OPEN' then created_at end asc,
        case when state = 'OPEN' then id end asc,
        decided_at desc, id desc
    `;
    const comparisons = await disputeComparisons(this.sql, rows.map((row) => row.id));
    return rows.map((row) => ({ ...toRequest(row), comparison: comparisons.get(row.id) }));
  }

  public async listRequestsForAccount(accountId: string): Promise<ClosedPrDisputeRequest[]> {
    const rows = await this.sql<RequestRow[]>`
      select id, contributor_id, pull_request_id, issue_id, landed_pull_request_id, landed_commit_url,
        request_reason, state, decision, decided_by, decided_by_sole_moderator, decided_reason,
        decided_at, moderator_figure, awarded_points, created_at
      from closed_pr_dispute_requests where contributor_id = ${accountId}
      order by created_at desc, id desc
    `;
    return rows.map(toRequest);
  }
}

function landedPullRequestNumber(value: string, repository: Repository): number | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const origin = repository.provider === "github" ? "https://github.com" : repository.instance_url;
  const marker = repository.provider === "github" ? "pull" : "-/merge_requests";
  const prefix = `/${repository.owner_name}/${marker}/`;
  const path = repository.provider === "github" ? url.pathname.toLowerCase() : url.pathname;
  const expectedPrefix = repository.provider === "github" ? prefix.toLowerCase() : prefix;
  if (url.origin !== origin || url.username !== "" || url.password !== "" || !path.startsWith(expectedPrefix)) {
    return null;
  }
  const suffix = path.slice(expectedPrefix.length);
  if (!/^[1-9][0-9]*\/?$/.test(suffix)) return null;
  const number = Number(suffix.replace(/\/$/, ""));
  return Number.isSafeInteger(number) && number <= 2_147_483_647 ? number : null;
}

function toRequest(row: RequestRow): ClosedPrDisputeRequest {
  return {
    id: row.id,
    contributorId: row.contributor_id,
    pullRequestId: row.pull_request_id,
    issueId: row.issue_id,
    landedPullRequestId: row.landed_pull_request_id,
    landedCommitUrl: row.landed_commit_url,
    requestReason: row.request_reason,
    state: row.state,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedBySoleModerator: row.decided_by_sole_moderator,
    decidedReason: row.decided_reason,
    decidedAt: row.decided_at === null ? null : toTimestamp(row.decided_at),
    moderatorFigure: row.moderator_figure,
    awardedPoints: row.awarded_points,
    createdAt: toTimestamp(row.created_at),
  };
}

function toTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("Database record timestamp was invalid.");
  return date.toISOString();
}
