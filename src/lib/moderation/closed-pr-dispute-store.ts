import { getSql } from "@/lib/db/client";
import type { EnforcementState, PullRequestState, SqlClient } from "@/lib/db/types";
import type {
  ClosedPrDisputeDecision,
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
          target_user_id, actor_id, audit_id, prior_state, new_state, reason, dispute_request_id
        ) values (
          ${input.accountId}, ${input.accountId}, null, ${account.enforcement_state},
          ${account.enforcement_state}, ${input.reason}, ${row.id}
        )
      `;
      return { kind: "ok", value: toRequest(row) };
    });
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
