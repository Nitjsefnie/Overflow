import type { JSONValue } from "postgres";
import type { CalibrationPair } from "@/lib/calibration/statistics";
import { getSql } from "@/lib/db/client";
import type { EnforcementState, SqlClient, TransactionClient } from "@/lib/db/types";
import { isParticipationEligible } from "@/lib/db/types";
import {
  type AccountAudit,
  type CalibrationCohortSnapshot,
  type LoadedCalibrationCohort,
  type ModerationStore,
  type ModerationStoreResult,
  type OpenAccountAuditStoreInput,
  type RecalibrationClosure,
  type ModeratorRoleChange,
  type ModeratorSummary,
} from "@/lib/moderation/service";
import { normalizeModeratorGitHubUserIds } from "@/lib/moderation/roles";
import { deriveSubstantiatedState } from "@/lib/moderation/transitions";

type UserRow = {
  id: string;
  enforcement_state: EnforcementState;
  confirmed_miscalibration_count: number | string;
};

type AuditRow = {
  id: string;
  account_id: string;
  repository_id: string | null;
  state: "OPEN" | "DISMISSED" | "SUBSTANTIATED";
  prior_enforcement_state: EnforcementState;
  cohort_definition: unknown;
  cohort_statistics: unknown;
};

type CalibrationPairRow = {
  github_repository_id: number | string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  merged_at: string | Date;
  proof_sha256: string | null;
  offered_difficulty: number | string;
  settled_difficulty: number | string;
};

export class PostgresModerationStore implements ModerationStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async loadCalibrationCohort(input: {
    targetAccountId: string;
    repositoryId: string | null;
    sampleStartedAt: string;
    sampleEndedAt: string;
  }): Promise<LoadedCalibrationCohort | null> {
    const [target] = await this.sql<{ id: string }[]>`
      select id from users where id = ${input.targetAccountId} limit 1
    `;
    if (target === undefined) {
      return null;
    }

    const [selfWorkRows, outsiderRows] = await Promise.all([
      this.listSelfWorkPairs(input),
      this.listOutsiderSettlementPairs(input),
    ]);
    return {
      selfWorkPairs: selfWorkRows.map(toCalibrationPair),
      outsiderSettlementPairs: outsiderRows.map(toCalibrationPair),
    };
  }

  public async openAccountAudit(
    input: OpenAccountAuditStoreInput,
  ): Promise<ModerationStoreResult<AccountAudit>> {
    return this.sql.begin(async (transaction) => {
      const [target] = await transaction<UserRow[]>`
        select id, enforcement_state, confirmed_miscalibration_count
        from users
        where id = ${input.targetAccountId}
        for update
      `;
      if (target === undefined) {
        return { kind: "not_found" };
      }

      const [existingAudit] = await transaction<{ id: string }[]>`
        select id
        from calibration_audits
        where account_id = ${input.targetAccountId} and state = ${"OPEN"}
        for update
      `;
      if (existingAudit !== undefined) {
        return { kind: "conflict" };
      }

      const [audit] = await transaction<AuditRow[]>`
        insert into calibration_audits (
          account_id,
          repository_id,
          reporter_id,
          moderator_id,
          state,
          rationale,
          sample_started_at,
          sample_ended_at,
          settled_sample_size,
          prior_enforcement_state,
          cohort_definition,
          cohort_statistics
        )
        values (
          ${input.targetAccountId},
          ${input.repositoryId},
          ${input.actorId},
          ${input.actorId},
          ${"OPEN"},
          ${input.reason},
          ${input.cohort.sampleStartedAt},
          ${input.cohort.sampleEndedAt},
          ${input.cohort.outsiderSettlementPairs.length},
          ${target.enforcement_state},
          ${transaction.json(input.cohort as unknown as JSONValue)},
          ${transaction.json(input.cohort.comparison as unknown as JSONValue)}
        )
        returning id, account_id, repository_id, state, prior_enforcement_state, cohort_definition, cohort_statistics
      `;
      if (audit === undefined) {
        throw new Error("Calibration audit insert returned no row.");
      }

      const newState = enforcementStateForOpenAudit(target.enforcement_state);
      await transaction`
        update users
        set enforcement_state = ${newState}, updated_at = now()
        where id = ${input.targetAccountId}
      `;
      await insertModerationEvent(transaction, {
        targetUserId: input.targetAccountId,
        actorId: input.actorId,
        auditId: audit.id,
        priorState: target.enforcement_state,
        newState,
        reason: input.reason,
        cohort: input.cohort,
        recalibrationPlan: null,
      });
      return {
        kind: "ok",
        value: toAccountAudit(audit, newState, toSafeInteger(target.confirmed_miscalibration_count)),
      };
    }) as Promise<ModerationStoreResult<AccountAudit>>;
  }

  public async dismissAccountAudit(input: {
    actorId: string;
    auditId: string;
    reason: string;
  }): Promise<ModerationStoreResult<AccountAudit>> {
    return this.sql.begin(async (transaction) => {
      const locked = await lockTargetAndAudit(transaction, input.auditId);
      if (locked === null) {
        return { kind: "not_found" };
      }
      const { audit, target } = locked;
      if (audit.state !== "OPEN") {
        return { kind: "conflict" };
      }

      const newState = target.enforcement_state === enforcementStateForOpenAudit(audit.prior_enforcement_state)
        ? audit.prior_enforcement_state
        : target.enforcement_state;
      await transaction`
        update calibration_audits
        set state = ${"DISMISSED"}, decision = ${input.reason}, moderator_id = ${input.actorId}, decided_at = now()
        where id = ${audit.id}
      `;
      await transaction`
        update users
        set enforcement_state = ${newState}, updated_at = now()
        where id = ${target.id}
      `;
      const cohort = toCohortSnapshot(audit);
      await insertModerationEvent(transaction, {
        targetUserId: target.id,
        actorId: input.actorId,
        auditId: audit.id,
        priorState: target.enforcement_state,
        newState,
        reason: input.reason,
        cohort,
        recalibrationPlan: null,
      });
      return {
        kind: "ok",
        value: toAccountAudit(
          { ...audit, state: "DISMISSED" },
          newState,
          toSafeInteger(target.confirmed_miscalibration_count),
        ),
      };
    }) as Promise<ModerationStoreResult<AccountAudit>>;
  }

  public async substantiateAccountAudit(input: {
    actorId: string;
    auditId: string;
    reason: string;
  }): Promise<ModerationStoreResult<AccountAudit>> {
    return this.sql.begin(async (transaction) => {
      const locked = await lockTargetAndAudit(transaction, input.auditId);
      if (locked === null) {
        return { kind: "not_found" };
      }
      const { audit, target } = locked;
      if (audit.state !== "OPEN") {
        return { kind: "conflict" };
      }

      const confirmedPatternCount = toSafeInteger(target.confirmed_miscalibration_count) + 1;
      const newState = deriveSubstantiatedState(confirmedPatternCount);
      await transaction`
        update users
        set
          confirmed_miscalibration_count = ${confirmedPatternCount},
          enforcement_state = ${newState},
          updated_at = now()
        where id = ${target.id}
      `;
      await transaction`
        update calibration_audits
        set state = ${"SUBSTANTIATED"}, decision = ${input.reason}, moderator_id = ${input.actorId}, decided_at = now()
        where id = ${audit.id}
      `;
      if (newState === "RECALIBRATING" || newState === "BANNED") {
        await transaction`
          update registered_repositories
          set active = false, updated_at = now()
          where sponsor_id = ${target.id}
        `;
      }
      const cohort = toCohortSnapshot(audit);
      await insertModerationEvent(transaction, {
        targetUserId: target.id,
        actorId: input.actorId,
        auditId: audit.id,
        priorState: target.enforcement_state,
        newState,
        reason: input.reason,
        cohort,
        recalibrationPlan: null,
      });
      return {
        kind: "ok",
        value: toAccountAudit(
          { ...audit, state: "SUBSTANTIATED" },
          newState,
          confirmedPatternCount,
        ),
      };
    }) as Promise<ModerationStoreResult<AccountAudit>>;
  }

  public async closeRecalibration(input: {
    actorId: string;
    targetAccountId: string;
    plan: string;
  }): Promise<ModerationStoreResult<RecalibrationClosure>> {
    return this.sql.begin(async (transaction) => {
      const [target] = await transaction<UserRow[]>`
        select id, enforcement_state, confirmed_miscalibration_count
        from users
        where id = ${input.targetAccountId}
        for update
      `;
      if (target === undefined) {
        return { kind: "not_found" };
      }
      if (target.enforcement_state !== "RECALIBRATING") {
        return { kind: "invalid_state" };
      }

      const [audit] = await transaction<AuditRow[]>`
        select id, account_id, repository_id, state, prior_enforcement_state, cohort_definition, cohort_statistics
        from calibration_audits
        where account_id = ${target.id} and state = ${"SUBSTANTIATED"}
        order by decided_at desc nulls last, id desc
        limit 1
        for update
      `;
      if (audit === undefined) {
        return { kind: "not_found" };
      }

      await transaction`
        update users
        set enforcement_state = ${"ACTIVE"}, updated_at = now()
        where id = ${target.id}
      `;
      const reactivatedRepositories = await transaction<{ id: string }[]>`
        update registered_repositories
        set active = true, updated_at = now()
        where sponsor_id = ${target.id} and active = false
        returning id
      `;
      const cohort = toCohortSnapshot(audit);
      await insertModerationEvent(transaction, {
        targetUserId: target.id,
        actorId: input.actorId,
        auditId: audit.id,
        priorState: "RECALIBRATING",
        newState: "ACTIVE",
        reason: input.plan,
        cohort,
        recalibrationPlan: input.plan,
      });
      return {
        kind: "ok",
        value: {
          targetAccountId: target.id,
          priorState: "RECALIBRATING",
          targetState: "ACTIVE",
          confirmedPatternCount: toSafeInteger(target.confirmed_miscalibration_count),
          reactivatedRepositoryCount: reactivatedRepositories.length,
        },
      };
    }) as Promise<ModerationStoreResult<RecalibrationClosure>>;
  }

  public async listModerators(): Promise<ModeratorSummary[]> {
    const configured = normalizeModeratorGitHubUserIds(process.env.MODERATOR_GITHUB_USER_IDS);
    const rows = await this.sql<{ id: string; github_user_id: number | string; github_login: string }[]>`
      select id, github_user_id, github_login from users where role = 'MODERATOR' order by github_login asc, id asc
    `;
    return rows.map((row) => ({
      accountId: row.id,
      githubLogin: row.github_login,
      isConfigured: configured.has(toSafeInteger(row.github_user_id)),
    }));
  }

  public async setModeratorRole(input: {
    actorId: string;
    targetAccountId: string;
    moderator: boolean;
  }): Promise<ModerationStoreResult<ModeratorRoleChange>> {
    return this.sql.begin(async (transaction) => {
      const [target] = await transaction<{ id: string; github_login: string; role: "MEMBER" | "MODERATOR" }[]>`
        select id, github_login, role from users where id = ${input.targetAccountId} for update
      `;
      if (target === undefined) {
        return { kind: "not_found" };
      }

      // Counted inside the transaction, with the target row already locked, so
      // two moderators revoking each other at the same moment cannot both see a
      // survivor and leave the instance with none.
      if (!input.moderator) {
        const [remaining] = await transaction<{ count: string }[]>`
          select count(*)::text as count from users where role = 'MODERATOR' and id <> ${input.targetAccountId}
        `;
        if (toSafeInteger(remaining?.count ?? "0") === 0) {
          return { kind: "invalid_state" };
        }
      }

      const newRole = input.moderator ? "MODERATOR" : "MEMBER";
      const [changed] = await transaction<{ updated_at: string }[]>`
        update users set role = ${newRole}, updated_at = now()
        where id = ${input.targetAccountId}
        returning updated_at
      `;
      await transaction`
        insert into moderator_role_changes (target_account_id, actor_id, new_role)
        values (${input.targetAccountId}, ${input.actorId}, ${newRole})
      `;

      return {
        kind: "ok",
        value: {
          targetAccountId: target.id,
          targetGitHubLogin: target.github_login,
          role: newRole,
          actorId: input.actorId,
          changedAt: toTimestamp(changed?.updated_at ?? new Date()),
        },
      };
    }) as Promise<ModerationStoreResult<ModeratorRoleChange>>;
  }

  private async listSelfWorkPairs(input: {
    targetAccountId: string;
    repositoryId: string | null;
    sampleStartedAt: string;
    sampleEndedAt: string;
  }): Promise<CalibrationPairRow[]> {
    const repositoryPredicate = this.repositoryPredicate(input.repositoryId);
    return this.sql<CalibrationPairRow[]>`
      select
        repositories.github_repository_id,
        issues.github_issue_id,
        pull_requests.github_pull_request_id,
        pull_requests.merged_at,
        pull_requests.proof_sha256,
        self_work_calibrations.opening_comparison_points as offered_difficulty,
        self_work_calibrations.actual_points as settled_difficulty
      from self_work_calibrations
      join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
      join issues on issues.id = self_work_calibrations.issue_id
      join registered_repositories as repositories on repositories.id = issues.repository_id
      where self_work_calibrations.user_id = ${input.targetAccountId}
        ${repositoryPredicate}
        and self_work_calibrations.actual_points is not null
        and pull_requests.proof_sha256 is not null
        and pull_requests.merged_at >= ${input.sampleStartedAt}
        and pull_requests.merged_at < ${input.sampleEndedAt}
      order by repositories.github_repository_id, issues.github_issue_id, pull_requests.github_pull_request_id
    `;
  }

  private async listOutsiderSettlementPairs(input: {
    targetAccountId: string;
    repositoryId: string | null;
    sampleStartedAt: string;
    sampleEndedAt: string;
  }): Promise<CalibrationPairRow[]> {
    const repositoryPredicate = this.repositoryPredicate(input.repositoryId);
    return this.sql<CalibrationPairRow[]>`
      select
        repositories.github_repository_id,
        issues.github_issue_id,
        pull_requests.github_pull_request_id,
        pull_requests.merged_at,
        settlements.proof_sha256,
        settlements.opening_comparison_points as offered_difficulty,
        settlements.settled_points as settled_difficulty
      from settlements
      join pull_requests on pull_requests.id = settlements.pull_request_id
      join issues on issues.id = settlements.issue_id
      join registered_repositories as repositories on repositories.id = issues.repository_id
      where settlements.debtor_id = ${input.targetAccountId}
        ${repositoryPredicate}
        and settlements.creditor_id is not null
        and settlements.creditor_id <> ${input.targetAccountId}
        and settlements.status = ${"SETTLED"}
        and settlements.settled_points is not null
        and pull_requests.merged_at >= ${input.sampleStartedAt}
        and pull_requests.merged_at < ${input.sampleEndedAt}
      order by repositories.github_repository_id, issues.github_issue_id, pull_requests.github_pull_request_id
    `;
  }

  private repositoryPredicate(repositoryId: string | null) {
    return repositoryId === null ? this.sql`` : this.sql`and repositories.id = ${repositoryId}`;
  }
}

function enforcementStateForOpenAudit(priorState: EnforcementState): EnforcementState {
  return isParticipationEligible(priorState) ? "UNDER_AUDIT" : priorState;
}

async function insertModerationEvent(
  sql: TransactionClient,
  input: {
    targetUserId: string;
    actorId: string;
    auditId: string;
    priorState: EnforcementState;
    newState: EnforcementState;
    reason: string;
    cohort: CalibrationCohortSnapshot;
    recalibrationPlan: string | null;
  },
): Promise<void> {
  await sql`
    insert into moderation_events (
      target_user_id,
      actor_id,
      audit_id,
      prior_state,
      new_state,
      reason,
      cohort_definition,
      cohort_statistics,
      recalibration_plan
    )
    values (
      ${input.targetUserId},
      ${input.actorId},
      ${input.auditId},
      ${input.priorState},
      ${input.newState},
      ${input.reason},
      ${sql.json(input.cohort as unknown as JSONValue)},
      ${sql.json(input.cohort.comparison as unknown as JSONValue)},
      ${input.recalibrationPlan}
    )
  `;
}

async function lockTargetAndAudit(
  sql: TransactionClient,
  auditId: string,
): Promise<{ target: UserRow; audit: AuditRow } | null> {
  const [reference] = await sql<{ account_id: string }[]>`
    select account_id
    from calibration_audits
    where id = ${auditId}
    limit 1
  `;
  if (reference === undefined) {
    return null;
  }

  const [target] = await sql<UserRow[]>`
    select id, enforcement_state, confirmed_miscalibration_count
    from users
    where id = ${reference.account_id}
    for update
  `;
  if (target === undefined) {
    return null;
  }

  const [audit] = await sql<AuditRow[]>`
    select id, account_id, repository_id, state, prior_enforcement_state, cohort_definition, cohort_statistics
    from calibration_audits
    where id = ${auditId}
    for update
  `;
  if (audit === undefined) {
    return null;
  }
  return { target, audit };
}

function toAccountAudit(
  row: AuditRow,
  targetState: EnforcementState,
  confirmedPatternCount: number,
): AccountAudit {
  return {
    id: row.id,
    targetAccountId: row.account_id,
    repositoryId: row.repository_id,
    state: row.state,
    priorState: row.prior_enforcement_state,
    targetState,
    confirmedPatternCount,
    cohort: toCohortSnapshot(row),
  };
}

function toCohortSnapshot(row: Pick<AuditRow, "cohort_definition" | "cohort_statistics">): CalibrationCohortSnapshot {
  if (typeof row.cohort_definition !== "object" || row.cohort_definition === null) {
    throw new Error("Calibration audit cohort definition was invalid.");
  }
  if (typeof row.cohort_statistics !== "object" || row.cohort_statistics === null) {
    throw new Error("Calibration audit cohort statistics were invalid.");
  }
  return {
    ...(row.cohort_definition as Omit<CalibrationCohortSnapshot, "comparison">),
    comparison: row.cohort_statistics as CalibrationCohortSnapshot["comparison"],
  };
}

function toCalibrationPair(row: CalibrationPairRow): CalibrationPair {
  return {
    githubRepositoryId: toSafeInteger(row.github_repository_id),
    githubIssueId: toSafeInteger(row.github_issue_id),
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    mergedAt: toTimestamp(row.merged_at),
    proofSha256: toProofSha256(row.proof_sha256),
    offeredDifficulty: toSafeInteger(row.offered_difficulty),
    settledDifficulty: toSafeInteger(row.settled_difficulty),
  };
}

function toTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Database merge time was invalid.");
  }
  return date.toISOString();
}

function toProofSha256(value: string | null): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Database proof fingerprint was invalid.");
  }
  return value;
}

function toSafeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database record was invalid.");
  }
  return parsed;
}
