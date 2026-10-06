import { getSql } from "@/lib/db/client";
import type { EnforcementState, SqlClient } from "@/lib/db/types";
import type {
  FileableSanction,
  OpenContestRequestProjection,
  SanctionContestDecision,
  SanctionContestRequest,
  SanctionContestState,
  SanctionContestStore,
  SanctionContestStoreResult,
} from "@/lib/moderation/sanction-contest-service";

type RequestRow = {
  id: string;
  account_id: string;
  sanction_event_id: string;
  request_reason: string;
  state: SanctionContestState;
  decision: SanctionContestDecision | null;
  decided_by: string | null;
  decided_by_sole_moderator: boolean;
  decided_reason: string | null;
  decided_at: string | Date | null;
  created_at: string | Date;
};

/**
 * Reads and writes sanction contest requests.
 *
 * Every authorization here is a database read, not a claim from the caller:
 * the filing transaction locks the account and the named event, and refuses
 * unless the event is the account's own and its state is the sanction the
 * account is living under right now. The one-open-per-sanction rule is the
 * partial unique index's (migration 061), whose violation this store maps onto
 * the same invalid_state every other non-live-sanction refusal carries, the
 * way the settlement override store maps its index's violation onto a
 * conflict.
 *
 * The decision transaction enforces the deciding-moderator rule server-side:
 * the imposer is the actor on the request's sanction event, and where another
 * live moderator exists that imposer is refused (forbidden_imposer); alone,
 * they decide and the row records decided_by_sole_moderator. A decision
 * records outcome and reason and writes its own moderation event — it does
 * not move enforcement_state; the reversals stay the paths that do.
 */
export class PostgresSanctionContestStore implements SanctionContestStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async fileSanctionContest(input: {
    accountId: string;
    sanctionEventId: string;
    reason: string;
  }): Promise<SanctionContestStoreResult<SanctionContestRequest>> {
    return this.fileSanctionContestInTransaction(input).catch((error: unknown) => {
      // Two filings raised at once both pass the transaction's reads; the
      // partial unique index is what actually holds the one-open-per-sanction
      // rule, so its violation is the same refusal rather than an unexplained
      // failure. The catch sits OUTSIDE sql.begin: postgres.js records any
      // query error inside a transaction as an uncaught one and re-throws it
      // after rollback even when the callback caught it — the credit
      // adjustment store maps its constraint failures the same way.
      if (isUniqueViolation(error)) {
        return { kind: "invalid_state" };
      }
      throw error;
    }) as Promise<SanctionContestStoreResult<SanctionContestRequest>>;
  }

  private async fileSanctionContestInTransaction(input: {
    accountId: string;
    sanctionEventId: string;
    reason: string;
  }): Promise<SanctionContestStoreResult<SanctionContestRequest>> {
    return this.sql.begin(async (transaction): Promise<SanctionContestStoreResult<SanctionContestRequest>> => {
      const [account] = await transaction<{ id: string; enforcement_state: EnforcementState }[]>`
        select id, enforcement_state
        from users
        where id = ${input.accountId}
        for update
      `;
      if (account === undefined) {
        return { kind: "not_found" };
      }

      const [event] = await transaction<{ id: string; target_user_id: string; new_state: EnforcementState }[]>`
        select id, target_user_id, new_state
        from moderation_events
        where id = ${input.sanctionEventId}
        for update
      `;
      if (event === undefined) {
        return { kind: "not_found" };
      }
      if (event.target_user_id !== input.accountId) {
        return { kind: "invalid_state" };
      }
      // A contest targets the LIVE sanction: the event must be a sanction
      // (RECALIBRATING or BANNED — never WARNED or UNDER_AUDIT) and it must be
      // the state the account is still in. A reversal changed the account's
      // state and left the event behind as history, so its state no longer
      // qualifies.
      if (!isSanctionState(event.new_state) || event.new_state !== account.enforcement_state) {
        return { kind: "invalid_state" };
      }

      const [row] = await transaction<RequestRow[]>`
        insert into sanction_contest_requests (account_id, sanction_event_id, request_reason)
        values (${input.accountId}, ${input.sanctionEventId}, ${input.reason})
        returning
          id, account_id, sanction_event_id, request_reason, state::text as state,
          decision::text as decision, decided_by, decided_by_sole_moderator,
          decided_reason, decided_at, created_at
      `;
      if (row === undefined) {
        throw new Error("Sanction contest insert returned no row.");
      }
      const request = toRequest(row);

      // The filing is moderation history, not an enforcement change: the
      // sanction's state on both sides makes it a same-state no-op for every
      // eligibility reader (participation_eligible_at and its TypeScript
      // mirror take the latest event's new_state, which this leaves alone).
      // audit_id stays null — no calibration audit stands behind a filing —
      // and the credential columns stay null, which their check accepts.
      await transaction`
        insert into moderation_events (
          target_user_id,
          actor_id,
          audit_id,
          prior_state,
          new_state,
          reason,
          contest_request_id
        )
        values (
          ${input.accountId},
          ${input.accountId},
          null,
          ${event.new_state},
          ${event.new_state},
          ${input.reason},
          ${request.id}
        )
      `;

      return { kind: "ok", value: request };
    });
  }

  /**
   * Decides an OPEN contest request: records the outcome, the deciding
   * moderator, the reason and the sole-moderator record, and writes the
   * decision's moderation event.
   *
   * The deciding-moderator rule is enforced here, against the database, not
   * in the route: the request row is locked FOR UPDATE, the imposer is read
   * off the sanction event's actor_id, and the live moderator set is read
   * with the roster's own semantics (role MODERATOR, deleted_at is null).
   * Where the imposer decides with any other live moderator present the
   * result is forbidden_imposer and nothing is written; alone, they may
   * decide, and the row says the decision came from the only live moderator.
   */
  public async decideSanctionContest(input: {
    requestId: string;
    moderatorAccountId: string;
    decision: SanctionContestDecision;
    decidedReason: string;
  }): Promise<SanctionContestStoreResult<SanctionContestRequest>> {
    if (input.decidedReason.trim().length === 0) {
      return { kind: "invalid_input" };
    }
    return this.sql.begin(async (transaction): Promise<SanctionContestStoreResult<SanctionContestRequest>> => {
      const [request] = await transaction<RequestRow[]>`
        select
          id, account_id, sanction_event_id, request_reason, state::text as state,
          decision::text as decision, decided_by, decided_by_sole_moderator,
          decided_reason, decided_at, created_at
        from sanction_contest_requests
        where id = ${input.requestId}
        for update
      `;
      if (request === undefined) {
        return { kind: "not_found" };
      }
      if (request.state !== "OPEN") {
        return { kind: "invalid_state" };
      }

      // The imposer is the actor on the sanction event. A plain read, not a
      // lock: actor_id and new_state are immutable (the migration 007
      // trigger), so they cannot move under this decision, and taking the
      // event's row lock would invert the filing path's lock order
      // (account, then event) against this one (request, then event read)
      // and open a deadlock window between a filing and a decision.
      const [sanctionEvent] = await transaction<{ actor_id: string; new_state: EnforcementState }[]>`
        select actor_id, new_state::text as new_state
        from moderation_events
        where id = ${request.sanction_event_id}
      `;
      if (sanctionEvent === undefined) {
        // The foreign key guarantees existence; the guard narrows the type.
        return { kind: "not_found" };
      }

      // The roster's live-only semantics, read fresh in the same transaction:
      // a role change or deletion since the request was filed is honoured.
      const liveModerators = await transaction<{ id: string }[]>`
        select id from users
        where role = 'MODERATOR' and deleted_at is null
        order by id
      `;
      const decidingModeratorIsImposer = sanctionEvent.actor_id === input.moderatorAccountId;
      const soleModerator = liveModerators.length === 1 && liveModerators[0]!.id === input.moderatorAccountId;
      if (decidingModeratorIsImposer && liveModerators.length > 1) {
        return { kind: "forbidden_imposer" };
      }

      const [row] = await transaction<RequestRow[]>`
        update sanction_contest_requests
        set state = 'DECIDED',
            decision = ${input.decision},
            decided_by = ${input.moderatorAccountId},
            decided_by_sole_moderator = ${soleModerator},
            decided_reason = ${input.decidedReason},
            decided_at = now()
        where id = ${input.requestId}
        returning
          id, account_id, sanction_event_id, request_reason, state::text as state,
          decision::text as decision, decided_by, decided_by_sole_moderator,
          decided_reason, decided_at, created_at
      `;
      if (row === undefined) {
        throw new Error("Sanction contest decision update returned no row.");
      }

      // The decision is moderation history, not an enforcement change:
      // granting a contest is recorded, not executed — what a grant does to
      // the sanction's enforcement state stays unspecified by the ruling, and
      // the ban reversals remain the paths that move it. The sanction's state
      // on both sides keeps the event a same-state no-op for every
      // eligibility reader, and audit_id stays null: no calibration audit
      // stands behind a contest decision.
      await transaction`
        insert into moderation_events (
          target_user_id,
          actor_id,
          audit_id,
          prior_state,
          new_state,
          reason,
          contest_request_id
        )
        values (
          ${row.account_id},
          ${input.moderatorAccountId},
          null,
          ${sanctionEvent.new_state},
          ${sanctionEvent.new_state},
          ${input.decidedReason},
          ${row.id}
        )
      `;

      return { kind: "ok", value: toRequest(row) };
    });
  }

  public async listRequestsForAccount(accountId: string): Promise<SanctionContestRequest[]> {
    const rows = await this.sql<RequestRow[]>`
      select
        id, account_id, sanction_event_id, request_reason, state::text as state,
        decision::text as decision, decided_by, decided_by_sole_moderator,
        decided_reason, decided_at, created_at
      from sanction_contest_requests
      where account_id = ${accountId}
      order by created_at desc, id desc
    `;
    return rows.map(toRequest);
  }

  public async listFileableSanctions(accountId: string): Promise<FileableSanction[]> {
    const rows = await this.sql<
      { id: string; new_state: EnforcementState; reason: string; created_at: string | Date }[]
    >`
      select events.id, events.new_state, events.reason, events.created_at
      from moderation_events as events
      join users on users.id = events.target_user_id
      where events.target_user_id = ${accountId}
        and users.enforcement_state = events.new_state
        and events.new_state in ('RECALIBRATING', 'BANNED')
      order by events.created_at desc, events.id desc
    `;
    return rows.map((row) => ({
      id: row.id,
      newState: row.new_state,
      reason: row.reason,
      occurredAt: toTimestamp(row.created_at),
    }));
  }

  /**
   * The moderation queue's read: every OPEN contest request with the account
   * name, the sanction's state, the filed reason and the filed date, oldest
   * first so the queue drains in filing order.
   */
  public async listOpenContestRequests(): Promise<OpenContestRequestProjection[]> {
    const rows = await this.sql<
      {
        request_id: string;
        account_id: string;
        github_login: string;
        sanction_state: EnforcementState;
        request_reason: string;
        created_at: string | Date;
      }[]
    >`
      select
        requests.id as request_id,
        requests.account_id,
        users.github_login,
        events.new_state::text as sanction_state,
        requests.request_reason,
        requests.created_at
      from sanction_contest_requests as requests
      join users on users.id = requests.account_id
      join moderation_events as events on events.id = requests.sanction_event_id
      where requests.state = 'OPEN'
      order by requests.created_at asc, requests.id asc
    `;
    return rows.map((row) => ({
      requestId: row.request_id,
      accountId: row.account_id,
      accountLogin: row.github_login,
      sanctionState: row.sanction_state,
      requestReason: row.request_reason,
      filedAt: toTimestamp(row.created_at),
    }));
  }
}

function isSanctionState(state: EnforcementState): boolean {
  return state === "RECALIBRATING" || state === "BANNED";
}

function toRequest(row: RequestRow): SanctionContestRequest {
  return {
    id: row.id,
    accountId: row.account_id,
    sanctionEventId: row.sanction_event_id,
    requestReason: row.request_reason,
    state: row.state,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedBySoleModerator: row.decided_by_sole_moderator,
    decidedReason: row.decided_reason,
    decidedAt: row.decided_at === null ? null : toTimestamp(row.decided_at),
    createdAt: toTimestamp(row.created_at),
  };
}

function toTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Database record timestamp was invalid.");
  }
  return date.toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
