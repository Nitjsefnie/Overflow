import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type {
  OpenSettlementOverrideRequest,
  SettlementOverrideDecisionInput,
  SettlementOverrideEvidence,
  SettlementOverrideRequest,
  SettlementOverrideState,
  SettlementOverrideStore,
  SettlementOverrideStoreResult,
} from "@/lib/overrides/service";

type RequestRow = {
  id: string;
  issue_id: string;
  requester_id: string;
  reason: string;
  state: SettlementOverrideState;
  settled_points: number | string | null;
  decided_by_id: string | null;
  decision_reason: string | null;
  created_at: string | Date;
  decided_at: string | Date | null;
};

type OpenRequestRow = RequestRow & {
  requester_login: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  settlement_id: string | null;
  settlement_status: "SETTLED" | "UNSETTLED" | "UNCLAIMED" | null;
  opening_comparison_points: number | string | null;
  settled_label: string | null;
  settlement_settled_points: number | string | null;
  review_rounds: number | string | null;
  credits: number | string | null;
  pull_request_number: number | string | null;
  pull_request_title: string | null;
  pull_request_url: string | null;
};

/**
 * Reads and writes settlement correction requests.
 *
 * Every authorization here is a database read rather than a claim carried in
 * from the caller: a request may only be raised by the account the settlement
 * names as creditor or debtor, and a settlement's requests are only listed for
 * those same two accounts.
 */
export class PostgresSettlementOverrideStore implements SettlementOverrideStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async createRequest(input: {
    requesterId: string;
    settlementId: string;
    reason: string;
  }): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>> {
    const [settlement] = await this.sql<{ issue_id: string; creditor_id: string | null; debtor_id: string }[]>`
      select issue_id, creditor_id, debtor_id
      from settlements
      where id = ${input.settlementId}
      limit 1
    `;
    if (settlement === undefined) {
      return { kind: "not_found" };
    }
    if (settlement.creditor_id !== input.requesterId && settlement.debtor_id !== input.requesterId) {
      return { kind: "forbidden" };
    }

    try {
      const rows = await this.sql<RequestRow[]>`
        insert into settlement_override_requests (issue_id, requester_id, reason)
        select ${settlement.issue_id}, ${input.requesterId}, ${input.reason}
        where not exists (
          select 1
          from settlement_override_requests
          where issue_id = ${settlement.issue_id} and state = 'OPEN'
        )
        returning
          id, issue_id, requester_id, reason, state::text as state, settled_points,
          decided_by_id, decision_reason, created_at, decided_at
      `;
      const row = rows[0];
      return row === undefined ? { kind: "conflict" } : { kind: "ok", value: toRequest(row) };
    } catch (error) {
      // Two requests raised at once both pass the guard above; the partial
      // unique index is what actually holds the one-open-request rule, so its
      // violation is the same conflict rather than an unexplained failure.
      if (isUniqueViolation(error)) {
        return { kind: "conflict" };
      }
      throw error;
    }
  }

  public async listOpenRequests(): Promise<OpenSettlementOverrideRequest[]> {
    const rows = await this.sql<OpenRequestRow[]>`
      select
        requests.id, requests.issue_id, requests.requester_id, requests.reason,
        requests.state::text as state, requests.settled_points, requests.decided_by_id,
        requests.decision_reason, requests.created_at, requests.decided_at,
        requesters.github_login as requester_login,
        repositories.owner_name as repository_name,
        issues.issue_number, issues.title as issue_title, issues.url as issue_url,
        settlements.id as settlement_id,
        settlements.status::text as settlement_status,
        settlements.opening_comparison_points,
        issues.settled_label,
        settlements.settled_points as settlement_settled_points,
        settlements.review_rounds,
        settlements.credits,
        pull_requests.pull_request_number,
        pull_requests.title as pull_request_title,
        pull_requests.url as pull_request_url
      from settlement_override_requests as requests
      join users as requesters on requesters.id = requests.requester_id
      join issues on issues.id = requests.issue_id
      join registered_repositories as repositories on repositories.id = issues.repository_id
      left join settlements on settlements.issue_id = requests.issue_id
      left join pull_requests on pull_requests.id = settlements.pull_request_id
      where requests.state = 'OPEN'
      order by requests.created_at asc, requests.id asc
    `;
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      requestedAt: toIso(row.created_at),
      requesterLogin: row.requester_login,
      repositoryName: row.repository_name,
      issueNumber: toInteger(row.issue_number),
      issueTitle: row.issue_title,
      issueUrl: row.issue_url,
      settlement: toEvidence(row),
    }));
  }

  public async listRequestsForSettlement(
    settlementId: string,
    viewerId: string,
  ): Promise<SettlementOverrideRequest[]> {
    const rows = await this.sql<RequestRow[]>`
      select
        requests.id, requests.issue_id, requests.requester_id, requests.reason,
        requests.state::text as state, requests.settled_points, requests.decided_by_id,
        requests.decision_reason, requests.created_at, requests.decided_at
      from settlement_override_requests as requests
      join settlements on settlements.issue_id = requests.issue_id
      where settlements.id = ${settlementId}
        and (settlements.creditor_id = ${viewerId} or settlements.debtor_id = ${viewerId})
      order by requests.created_at desc, requests.id desc
    `;
    return rows.map(toRequest);
  }

  public async decideRequest(
    input: { actorId: string; requestId: string } & SettlementOverrideDecisionInput,
  ): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>> {
    const settledPoints = input.decision === "GRANT" ? input.settledPoints : null;
    const state: SettlementOverrideState = input.decision === "GRANT" ? "GRANTED" : "DECLINED";
    const rows = await this.sql<RequestRow[]>`
      update settlement_override_requests
      set state = ${state}::settlement_override_state,
          settled_points = ${settledPoints},
          decided_by_id = ${input.actorId},
          decision_reason = ${input.reason},
          decided_at = now()
      where id = ${input.requestId} and state = 'OPEN'
      returning
        id, issue_id, requester_id, reason, state::text as state, settled_points,
        decided_by_id, decision_reason, created_at, decided_at
    `;
    const row = rows[0];
    if (row !== undefined) {
      return { kind: "ok", value: toRequest(row) };
    }

    const [existing] = await this.sql<{ id: string }[]>`
      select id from settlement_override_requests where id = ${input.requestId} limit 1
    `;
    return existing === undefined ? { kind: "not_found" } : { kind: "conflict" };
  }
}

function toRequest(row: RequestRow): SettlementOverrideRequest {
  return {
    id: row.id,
    issueId: row.issue_id,
    requesterId: row.requester_id,
    reason: row.reason,
    state: row.state,
    settledPoints: row.settled_points === null ? null : toInteger(row.settled_points),
    decidedById: row.decided_by_id,
    decisionReason: row.decision_reason,
    createdAt: toIso(row.created_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
  };
}

function toEvidence(row: OpenRequestRow): SettlementOverrideEvidence | null {
  if (
    row.settlement_id === null ||
    row.settlement_status === null ||
    row.opening_comparison_points === null ||
    row.review_rounds === null ||
    row.credits === null ||
    row.pull_request_number === null ||
    row.pull_request_title === null ||
    row.pull_request_url === null
  ) {
    return null;
  }
  return {
    settlementId: row.settlement_id,
    status: row.settlement_status,
    openingComparisonPoints: toInteger(row.opening_comparison_points),
    settledLabel: row.settled_label,
    settledPoints: row.settlement_settled_points === null ? null : toInteger(row.settlement_settled_points),
    reviewRounds: toInteger(row.review_rounds),
    credits: toInteger(row.credits),
    pullRequestNumber: toInteger(row.pull_request_number),
    pullRequestTitle: row.pull_request_title,
    pullRequestUrl: row.pull_request_url,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function toInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error("A settlement override record carried a non-integer value.");
  }
  return parsed;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
