import { getSql } from "@/lib/db/client";
import type { UnwritableClosure } from "@/lib/fold/repository-fold";
import type { ReconciliationJobState } from "@/lib/fold/reconciliation-jobs";

/** A deliberately small SQL boundary that keeps dashboard projections easy to exercise without a database; `unsafe` is the unnamed-statement escape hatch the board read serves through. */
export type DashboardSql = {
  <T extends readonly unknown[] = readonly unknown[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  unsafe<T extends readonly unknown[] = readonly unknown[]>(text: string, values?: unknown[]): Promise<T>;
};

export type DashboardProjection = {
  settledBalance: number;
  earnedTotal: number;
  givenTotal: number;
  reservedPoints: number;
  availableHeadroom: number;
  recentSettlements: RecentSettlementProjection[];
  enforcementState?: string;
  openClaims: OpenClaimProjection[];
  registeredRepositories: RegisteredRepositoryProjection[];
  enforcementNotices: EnforcementNoticeProjection[];
  openAudit: MemberOpenAuditProjection | null;
};

export type OpenClaimProjection = {
  id: string;
  repositoryName: string;
  issueNumber: number;
  title: string;
  url: string;
  assigneeGitHubLogin: string;
  openingName: string;
  openingLabel: string;
  reservePoints: number;
};

export type RegisteredRepositoryProjection = {
  id: string;
  ownerName: string;
  visibility: string;
  active: boolean;
  openingName: string;
  actualName: string;
  /** The repository's opening label names in stored order — the listing rule's labels. */
  openingLabels: string[];
  unavailableReason: string | null;
  /** `IDLE` is the no-row case: a job deletes its own row on success, so nothing outstanding is nothing to say. */
  reconciliationState: "IDLE" | ReconciliationJobState;
  reconciliationLastFailureAt: Date | null;
};

export type EnforcementNoticeProjection = {
  id: string;
  priorState: string;
  newState: string;
  reason: string;
  createdAt: string;
};

/**
 * The member's own notice that a calibration audit is open on their account: its
 * identity and the day it opened. The rationale, cohort definition and statistics
 * stay moderator-facing, so the notice exists independently of anything a moderator typed.
 */
export type MemberOpenAuditProjection = {
  id: string;
  openedAt: string;
};

/** A dashboard-safe settlement summary that links a member to the complete proof page. */
export type RecentSettlementProjection = {
  id: string;
  status: SettlementStatus;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  proofSha256: string;
  credits: number;
  reviewRounds: number;
  settledAt: string;
};

export type SettlementStatus = "SETTLED" | "UNSETTLED" | "UNCLAIMED" | "DONATED";

export type UnwritableClosureProjection = {
  id: string;
  // The fold's kind set is the one declaration; this projection restates no kind.
  kind: UnwritableClosure["kind"];
  reason: string;
  recordedAt: string;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequest: { number: number; title: string; url: string } | null;
  settlementId: string | null;
  settlementParties: { creditorLogin: string | null; debtorLogin: string } | null;
  calibrationId: string | null;
  calibrationOwnerLogin: string | null;
  viewerCanRequestCorrection: boolean;
  latestCorrection: { state: "OPEN" | "GRANTED" | "DECLINED"; requestedAt: string } | null;
};

export type UnwritableClosureQueues = {
  queue: UnwritableClosureProjection[];
  history: UnwritableClosureProjection[];
};

export type EnforcementHistoryProjection = {
  id: string;
  targetAccountId: string;
  targetLogin: string;
  actorLogin: string;
  priorState: string;
  newState: string;
  reason: string;
  recalibrationPlan: unknown;
  createdAt: string;
};

export type RecalibratingAccountProjection = {
  id: string;
  githubLogin: string;
  confirmedPatternCount: number;
};

export type ModerationRepositoryProjection = {
  id: string;
  ownerName: string;
};

/**
 * A scope that runs a whole projection's reads against one database snapshot.
 * `getDashboard` hands its callback every read the projection makes, so a commit
 * landing mid-projection cannot show the callback two different committed states.
 * Tests supply their own to observe or replace the transaction boundary
 * without a database.
 */
export type DashboardBegin = <T>(run: (sql: DashboardSql) => Promise<T>) => Promise<T>;

export type DashboardQueryDependencies = {
  sql?: DashboardSql;
  begin?: DashboardBegin;
};

type DashboardRow = {
  settled_balance: number | string | null;
  earned_total: number | string | null;
  given_total: number | string | null;
  reserved_points: number | string | null;
  enforcement_state?: string;
};

type OpenClaimRow = {
  id: string;
  repository_name: string;
  issue_number: number | string;
  title: string;
  url: string;
  assignee_github_login: string;
  opening_name: string;
  opening_label: string;
  reserve_points: number | string;
};

type RegisteredRepositoryRow = {
  id: string;
  owner_name: string;
  visibility: string;
  active: boolean;
  opening_name: string;
  actual_name: string;
  opening_labels: unknown;
  unavailable_reason: string | null;
  reconciliation_state: string | null;
  reconciliation_last_failure_at: Date | string | null;
};

type EnforcementNoticeRow = {
  id: string;
  prior_state: string;
  new_state: string;
  reason: string;
  created_at: string | Date;
};

type MemberOpenAuditRow = {
  id: string;
  opened_at: string | Date;
};

type RecentSettlementRow = {
  id: string;
  status: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  pull_request_number: number | string;
  pull_request_title: string;
  pull_request_url: string;
  proof_sha256: string;
  credits: number | string;
  review_rounds: number | string;
  settled_at: string | Date;
};

type UnwritableClosureRow = {
  id: string;
  kind: UnwritableClosureProjection["kind"];
  reason: string;
  recorded_at: string | Date;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  pull_request_number: number | string | null;
  pull_request_title: string | null;
  pull_request_url: string | null;
  settlement_id: string | null;
  creditor_login: string | null;
  debtor_login: string | null;
  calibration_id: string | null;
  calibration_owner_login: string | null;
  viewer_can_request_correction: boolean;
  correction_state: "OPEN" | "GRANTED" | "DECLINED" | null;
  correction_requested_at: string | Date | null;
};

type EnforcementHistoryRow = {
  id: string;
  target_account_id: string;
  target_login: string;
  actor_login: string;
  prior_state: string;
  new_state: string;
  reason: string;
  recalibration_plan: unknown;
  created_at: string | Date;
};

type RecalibratingAccountRow = {
  id: string;
  github_login: string;
  confirmed_miscalibration_count: number | string;
};

type ModerationRepositoryRow = {
  id: string;
  owner_name: string;
};

/**
 * The member dashboard: one projection, one database snapshot.
 *
 * Loads materialized ledger and reservation values; overcommitment remains visible as
 * negative headroom. The six reads below all describe the same committed instant. Each
 * is its own autocommit statement, so without a shared snapshot a commit landing after
 * the first read splits the projection across two states of the ledger — a balance from
 * before it beside a settlement history from after it.
 */
export async function getDashboard(
  accountId: string,
  dependencies: DashboardQueryDependencies = {},
): Promise<DashboardProjection> {
  const sql = resolveSql(dependencies);
  const snapshotScope = dependencies.begin ?? defaultSnapshotScope(sql);
  return snapshotScope((txSql) => readDashboardProjection(txSql, accountId));
}

/** Reads the dashboard's six queries and builds their projection, all through one sql. */
async function readDashboardProjection(
  sql: DashboardSql,
  accountId: string,
): Promise<DashboardProjection> {
  const [row] = await sql<DashboardRow[]>`
    select
      coalesce((
        select balances.balance
        from balances
        where balances.account_id = ${accountId}
      ), 0)::integer as settled_balance,
      coalesce((
        select sum(ledger_entries.amount)
        from ledger_entries
        where ledger_entries.account_id = ${accountId}
          and ledger_entries.amount > 0
      ), 0)::integer as earned_total,
      abs(coalesce((
        select sum(ledger_entries.amount)
        from ledger_entries
        where ledger_entries.account_id = ${accountId}
          and ledger_entries.amount < 0
      ), 0))::integer as given_total,
      coalesce((
        select sum(issues.opening_reserve_points)
        from issues
        join registered_repositories as repositories on repositories.id = issues.repository_id
        join users as sponsors on sponsors.id = repositories.sponsor_id
        where repositories.sponsor_id = ${accountId}
          and issues.state = 'OPEN'
          and issues.claim_assignee_github_login is not null
          -- Claimed-ness is the login's existence; who claims is decided by the
          -- immutable account id (migrations 013 and 032). IS DISTINCT FROM so a
          -- claimed issue whose assignee id is not yet reconciled cannot prove
          -- self-assignment and stays reserved until GitHub backfills it.
          and issues.claim_assignee_github_user_id is distinct from sponsors.github_user_id
      ), 0)::integer as reserved_points,
      (select users.enforcement_state::text from users where users.id = ${accountId}) as enforcement_state
  `;
  const recentSettlementRows = await sql<RecentSettlementRow[]>`
    select
      settlements.id,
      settlements.status::text as status,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      settlements.proof_sha256,
      settlements.credits,
      settlements.review_rounds,
      settlements.created_at as settled_at
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where (settlements.creditor_id = ${accountId} or settlements.debtor_id = ${accountId})
      and settlements.status in ('SETTLED', 'UNCLAIMED', 'DONATED')
    order by settlements.created_at desc
    limit 5
  `;
  const openClaimRows = await sql<OpenClaimRow[]>`
    select
      issues.id,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title,
      issues.url,
      issues.claim_assignee_github_login as assignee_github_login,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      issues.opening_label,
      issues.opening_reserve_points as reserve_points
    from issues
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where repositories.sponsor_id = ${accountId}
      and issues.state = 'OPEN'
      and issues.claim_assignee_github_login is not null
    order by issues.created_at asc, issues.id
  `;
  // A repository owns at most one reconciliation job, enforced by a unique constraint, so a plain
  // left join cannot multiply the repository rows and needs no precedence ordering to pick a job.
  const registeredRepositoryRows = await sql<RegisteredRepositoryRow[]>`
    select
      repositories.id,
      repositories.owner_name,
      repositories.visibility::text,
      repositories.active,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      repositories.difficulty_scheme ->> 'actualName' as actual_name,
      repositories.difficulty_scheme -> 'openingLabels' as opening_labels,
      repositories.unavailable_reason,
      jobs.state::text as reconciliation_state,
      jobs.last_failure_at as reconciliation_last_failure_at
    from registered_repositories as repositories
    left join repository_reconciliation_jobs as jobs on jobs.repository_id = repositories.id
    where repositories.sponsor_id = ${accountId}
    order by repositories.owner_name, repositories.id
  `;
  const enforcementNoticeRows = await sql<EnforcementNoticeRow[]>`
    select id, prior_state::text, new_state::text, reason, created_at
    from moderation_events
    where target_user_id = ${accountId}
    order by created_at desc, id desc
    limit 10
  `;
  // At most one OPEN audit can exist per account — the partial unique index
  // calibration_audits_one_open_account (migration 006) covers (account_id) where
  // state = 'OPEN' — so this read cannot multiply rows and needs no precedence ordering
  // to pick one. The notice is the audit's identity and opening time alone: nothing
  // here consults the enforcement state or a moderator's text.
  const [openAuditRow] = await sql<MemberOpenAuditRow[]>`
    select id, opened_at
    from calibration_audits
    where calibration_audits.account_id = ${accountId}
      and calibration_audits.state = 'OPEN'
  `;

  const settledBalance = readNumber(row?.settled_balance ?? 0, "Settled balance");
  const reservedPoints = readNumber(row?.reserved_points ?? 0, "Reserved points");
  const projection: DashboardProjection = {
    settledBalance,
    earnedTotal: readNumber(row?.earned_total ?? 0, "Earned total"),
    givenTotal: readNumber(row?.given_total ?? 0, "Given total"),
    reservedPoints,
    availableHeadroom: settledBalance - reservedPoints,
    recentSettlements: recentSettlementRows.map(toRecentSettlementProjection),
    openClaims: openClaimRows.map((claim) => ({
      id: readText(claim.id, "Claim identifier"),
      repositoryName: readText(claim.repository_name, "Claim repository"),
      issueNumber: readNumber(claim.issue_number, "Claim issue number"),
      title: readText(claim.title, "Claim title"),
      url: readText(claim.url, "Claim URL"),
      assigneeGitHubLogin: readText(claim.assignee_github_login, "Claim assignee"),
      openingName: readText(claim.opening_name, "Claim opening catalog name"),
      openingLabel: readText(claim.opening_label, "Claim opening label"),
      reservePoints: readNumber(claim.reserve_points, "Claim reserve points"),
    })),
    registeredRepositories: registeredRepositoryRows.map((repository) => ({
      id: readText(repository.id, "Repository identifier"),
      ownerName: readText(repository.owner_name, "Repository name"),
      visibility: readText(repository.visibility, "Repository visibility"),
      active: repository.active,
      openingName: readText(repository.opening_name, "Repository opening catalog name"),
      actualName: readText(repository.actual_name, "Repository actual catalog name"),
      openingLabels: readOpeningLabelNames(repository.opening_labels, "Repository opening labels"),
      unavailableReason: repository.unavailable_reason === null
        ? null
        : readText(repository.unavailable_reason, "Repository unavailability reason"),
      reconciliationState: readReconciliationState(repository.reconciliation_state, "Repository reconciliation state"),
      reconciliationLastFailureAt: readNullableDate(repository.reconciliation_last_failure_at, "Repository reconciliation failure time"),
    })),
    enforcementNotices: enforcementNoticeRows.map((notice) => ({
      id: readText(notice.id, "Enforcement notice identifier"),
      priorState: readText(notice.prior_state, "Prior enforcement state"),
      newState: readText(notice.new_state, "New enforcement state"),
      reason: readText(notice.reason, "Enforcement reason"),
      createdAt: readTimestamp(notice.created_at, "Enforcement time"),
    })),
    openAudit: openAuditRow === undefined ? null : {
      id: readText(openAuditRow.id, "Open audit identifier"),
      openedAt: readTimestamp(openAuditRow.opened_at, "Open audit opening time"),
    },
  };
  if (row?.enforcement_state !== undefined) {
    projection.enforcementState = readText(row.enforcement_state, "Enforcement state");
  }
  return projection;
}

export async function listUnwritableClosures(
  viewerId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<UnwritableClosureQueues> {
  const sql = resolveSql(dependencies);
  const rows = await sql<UnwritableClosureRow[]>`
    select
      unwritable_closures.id,
      unwritable_closures.kind::text,
      unwritable_closures.reason,
      unwritable_closures.created_at as recorded_at,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      settlements.id as settlement_id,
      creditors.github_login as creditor_login,
      debtors.github_login as debtor_login,
      calibrations.id as calibration_id,
      calibration_owners.github_login as calibration_owner_login,
      case
        when settlements.id is not null then
          coalesce(settlements.creditor_id = ${viewerId}, false) or settlements.debtor_id = ${viewerId}
        when calibrations.id is not null then calibrations.user_id = ${viewerId}
        else false
      end as viewer_can_request_correction,
      latest_correction.state::text as correction_state,
      latest_correction.created_at as correction_requested_at
    from unwritable_closures
    join issues on issues.id = unwritable_closures.issue_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    left join pull_requests on pull_requests.id = unwritable_closures.pull_request_id
    left join settlements on settlements.issue_id = issues.id
    left join users as creditors on creditors.id = settlements.creditor_id
    left join users as debtors on debtors.id = settlements.debtor_id
    left join self_work_calibrations as calibrations on calibrations.issue_id = issues.id
    left join users as calibration_owners on calibration_owners.id = calibrations.user_id
    left join lateral (
      select settlement_override_requests.state, settlement_override_requests.created_at
      from settlement_override_requests
      where settlement_override_requests.issue_id = issues.id
      order by settlement_override_requests.created_at desc, settlement_override_requests.id desc
      limit 1
    ) as latest_correction on true
    -- An unlabelled self-work closure leaves a moderator nothing to price until an actual-catalog label is applied,
    -- so it is kept out of the queue; once a correction is granted it reaches history like any other.
    where not unwritable_closures.unlabelled_self_work or latest_correction.state = 'GRANTED'
    order by unwritable_closures.created_at desc, issues.github_issue_id asc
  `;

  const closures: UnwritableClosureProjection[] = rows.map((row) => ({
    id: readText(row.id, "Closure identifier"),
    kind: row.kind,
    reason: readText(row.reason, "Closure reason"),
    recordedAt: readTimestamp(row.recorded_at, "Closure recording time"),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    pullRequest: row.pull_request_number === null ? null : {
      number: readNumber(row.pull_request_number, "Pull request number"),
      title: readText(row.pull_request_title, "Pull request title"),
      url: readText(row.pull_request_url, "Pull request URL"),
    },
    settlementId: row.settlement_id === null ? null : readText(row.settlement_id, "Settlement identifier"),
    settlementParties: row.settlement_id === null ? null : {
      creditorLogin: row.creditor_login === null ? null : readText(row.creditor_login, "Creditor login"),
      debtorLogin: readText(row.debtor_login, "Debtor login"),
    },
    calibrationId: row.calibration_id === null ? null : readText(row.calibration_id, "Calibration identifier"),
    calibrationOwnerLogin: row.calibration_owner_login === null ? null : readText(row.calibration_owner_login, "Calibration owner login"),
    viewerCanRequestCorrection: row.viewer_can_request_correction,
    latestCorrection: row.correction_state === null ? null : {
      state: row.correction_state,
      requestedAt: readTimestamp(row.correction_requested_at!, "Correction request time"),
    },
  }));

  const queues: UnwritableClosureQueues = { queue: [], history: [] };
  for (const closure of closures) {
    if (closure.latestCorrection?.state === "GRANTED") {
      queues.history.push(closure);
    } else {
      queues.queue.push(closure);
    }
  }
  return queues;
}

export async function listEnforcementHistory(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<EnforcementHistoryProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<EnforcementHistoryRow[]>`
    select
      moderation_events.id,
      moderation_events.target_user_id as target_account_id,
      targets.github_login as target_login,
      actors.github_login as actor_login,
      moderation_events.prior_state::text,
      moderation_events.new_state::text,
      moderation_events.reason,
      moderation_events.recalibration_plan,
      moderation_events.created_at
    from moderation_events
    join users as targets on targets.id = moderation_events.target_user_id
    join users as actors on actors.id = moderation_events.actor_id
    order by moderation_events.created_at desc, moderation_events.id desc
    limit 100
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Moderation event identifier"),
    targetAccountId: readText(row.target_account_id, "Moderation target identifier"),
    targetLogin: readText(row.target_login, "Moderation target login"),
    actorLogin: readText(row.actor_login, "Moderation actor login"),
    priorState: readText(row.prior_state, "Prior enforcement state"),
    newState: readText(row.new_state, "New enforcement state"),
    reason: readText(row.reason, "Moderation reason"),
    recalibrationPlan: row.recalibration_plan,
    createdAt: readTimestamp(row.created_at, "Moderation event time"),
  }));
}

export async function listRecalibratingAccounts(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<RecalibratingAccountProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<RecalibratingAccountRow[]>`
    select id, github_login, confirmed_miscalibration_count
    from users
    where enforcement_state = 'RECALIBRATING'
    order by github_login, id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Recalibrating account identifier"),
    githubLogin: readText(row.github_login, "Recalibrating account login"),
    confirmedPatternCount: readNumber(row.confirmed_miscalibration_count, "Confirmed pattern count"),
  }));
}

export async function listModerationRepositories(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<ModerationRepositoryProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<ModerationRepositoryRow[]>`
    select id, owner_name
    from registered_repositories
    where active = true
    order by owner_name, id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Repository identifier"),
    ownerName: readText(row.owner_name, "Repository name"),
  }));
}

export function resolveSql(dependencies: Pick<DashboardQueryDependencies, "sql">): DashboardSql {
  return dependencies.sql ?? (getSql() as unknown as DashboardSql);
}

/**
 * The transaction options that give a projection one snapshot to read.
 *
 * `repeatable read` is the point: in `read committed` — PostgreSQL's default —
 * every statement takes its own snapshot, so a transaction there would still
 * tear. `read only` because a projection never writes, and `read only`
 * transactions neither assign an xid nor hold write locks. SERIALIZABLE would
 * buy nothing beyond that one snapshot and would charge dashboards
 * serialization-failure retries for it.
 */
const SNAPSHOT_SCOPE_OPTIONS = "read only isolation level repeatable read";

/**
 * The default snapshot scope for a resolved sql.
 *
 * The real postgres client carries a `begin`, so the projection's reads run
 * inside one read-only repeatable-read transaction on it. An injected seam
 * without a `begin` — the unit-test fakes — reads autocommit.
 */
export function defaultSnapshotScope(sql: DashboardSql): DashboardBegin {
  // Held in a const so the typeof narrowing survives into the returned closure;
  // narrowing a property access does not.
  const begin = (
    sql as {
      begin?: (options: string, run: (sql: DashboardSql) => Promise<unknown>) => Promise<unknown>;
    }
  ).begin;
  if (typeof begin === "function") {
    return <T>(run: (sql: DashboardSql) => Promise<T>): Promise<T> =>
      begin(SNAPSHOT_SCOPE_OPTIONS, run) as Promise<T>;
  }
  return (run) => run(sql);
}

function toRecentSettlementProjection(row: RecentSettlementRow): RecentSettlementProjection {
  return {
    id: readText(row.id, "Settlement identifier"),
    status: readSettlementStatus(row.status),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    pullRequestNumber: readNumber(row.pull_request_number, "Pull request number"),
    pullRequestTitle: readText(row.pull_request_title, "Pull request title"),
    pullRequestUrl: readText(row.pull_request_url, "Pull request URL"),
    proofSha256: readText(row.proof_sha256, "Settlement proof"),
    credits: readNumber(row.credits, "Credits"),
    reviewRounds: readNumber(row.review_rounds, "Review rounds"),
    settledAt: readTimestamp(row.settled_at, "Settlement time"),
  };
}

export function readNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} was not a number.`);
  }
  return parsed;
}

export function readText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} was not text.`);
  }
  return value;
}

/**
 * Null is the answer on the closure this product has to render — a settled
 * label the fold refused to write — so it passes through, but anything else
 * non-textual is a projection reading the wrong column and says so.
 */
export function readNullableText(value: unknown, label: string): string | null {
  return value === null ? null : readText(value, label);
}

/** The opening label names one stored scheme carries, in stored order. */
function readOpeningLabelNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} was not a list of label entries.`);
  }
  return value.map((entry) => readText((entry as { label?: unknown } | null)?.label, label));
}

/**
 * Keyed by the shared union, so the compiler is what notices a state added to `ReconciliationJobState`:
 * a missing key fails this build, where a hand-kept list would instead throw on the dashboard of
 * every sponsor who owns a repository in that state.
 */
const reconciliationJobStates: { [State in ReconciliationJobState]: State } = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  FAILED: "FAILED",
};

/**
 * The queue's state for one repository, where no row at all is the settled answer.
 * A job deletes its own row when it succeeds, so a missing row means the repository agrees with
 * GitHub rather than that its state is unknown. A state the queue cannot hold is a projection
 * reading the wrong column and says so.
 */
function readReconciliationState(value: unknown, label: string): "IDLE" | ReconciliationJobState {
  if (value === null) {
    return "IDLE";
  }
  const state = readText(value, label);
  for (const candidate of Object.values(reconciliationJobStates)) {
    if (state === candidate) {
      return candidate;
    }
  }
  throw new Error(`${label} was not a known job state.`);
}

/**
 * A timestamp the page renders rather than compares, kept as a `Date` because the driver hands
 * `timestamp with time zone` back as one and a string form would only be parsed again to format it.
 */
function readNullableDate(value: unknown, label: string): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(readText(value, label));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} was not a timestamp.`);
  }
  return parsed;
}

export function readTimestamp(value: string | Date, label: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new Error(`${label} was not a timestamp.`);
  }
  return value;
}

export function readNullableTimestamp(value: string | Date | null | undefined, label: string): string | null {
  return value === null || value === undefined ? null : readTimestamp(value, label);
}

export function readNullableMergeOid(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("Merge commit OID was invalid.");
  }
  return value;
}

export function readSettlementStatus(value: string): SettlementStatus {
  if (value === "SETTLED" || value === "UNSETTLED" || value === "UNCLAIMED" || value === "DONATED") {
    return value;
  }
  throw new Error("Settlement status was invalid.");
}
