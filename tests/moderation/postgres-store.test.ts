import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import type { CalibrationPair } from "@/lib/calibration/statistics";
import { closeSql, getSql } from "@/lib/db/client";
import { isParticipationEligible } from "@/lib/db/types";
import type { OpenAccountAuditStoreInput } from "@/lib/moderation/service";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { RepositoryRegistrationEnforcementError } from "@/lib/repositories/register";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 40_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("PostgreSQL account moderation transitions", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_moderation_test",
      user: "overflow_moderation_test",
      password: "overflow_moderation_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("locks account and audit transitions, preserves evidence, and applies the account-level enforcement ladder", async () => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");
    const primaryRepositoryId = await insertRepository(targetId);
    const secondaryRepositoryId = await insertRepository(targetId);
    const insertedPairs = await insertCalibrationPairs({ targetId, repositoryId: primaryRepositoryId, count: 10 });

    const store = new PostgresModerationStore(sql);
    const sampleStartedAt = "2020-01-01T00:00:00.000Z";
    const sampleEndedAt = "2030-01-01T00:00:00.000Z";
    const loaded = await store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: primaryRepositoryId,
      sampleStartedAt,
      sampleEndedAt,
    });

    expect(loaded).not.toBeNull();
    expect(loaded).toEqual(insertedPairs);
    expect(loaded?.selfWorkPairs).toHaveLength(10);
    expect(loaded?.outsiderSettlementPairs).toHaveLength(10);

    const openInput = auditInput({
      actorId: moderatorId,
      targetAccountId: targetId,
      repositoryId: primaryRepositoryId,
      sampleStartedAt,
      sampleEndedAt,
      selfWorkPairs: loaded!.selfWorkPairs,
      outsiderSettlementPairs: loaded!.outsiderSettlementPairs,
    });
    const settlementsBefore = await settlementFacts();
    const ledgerBefore = await ledgerFacts();
    const selfWorkBefore = await sql<{ count: number }[]>`
      select count(*)::integer as count from self_work_calibrations where user_id = ${targetId}
    `;

    const opened = await store.openAccountAudit(openInput);
    expect(opened.kind).toBe("ok");
    if (opened.kind !== "ok") {
      throw new Error("Expected the initial audit to open.");
    }
    expect(await targetState(targetId)).toEqual({ state: "UNDER_AUDIT", confirmedCount: 0 });
    await expect(store.openAccountAudit(openInput)).resolves.toEqual({ kind: "conflict" });

    const concurrentSubstantiations = await Promise.all([
      store.substantiateAccountAudit({
        actorId: moderatorId,
        auditId: opened.value.id,
        reason: "The first independently reviewed cohort confirms the pattern.",
      }),
      store.substantiateAccountAudit({
        actorId: moderatorId,
        auditId: opened.value.id,
        reason: "The competing transition must not increment the count twice.",
      }),
    ]);
    expect(concurrentSubstantiations.map((result) => result.kind).sort()).toEqual(["conflict", "ok"]);
    expect(await targetState(targetId)).toEqual({ state: "WARNED", confirmedCount: 1 });
    expect(await repositoryStates(targetId)).toEqual(expectedRepositoryStates([
      { id: primaryRepositoryId, active: true },
      { id: secondaryRepositoryId, active: true },
    ]));
    await expect(
      store.closeRecalibration({
        actorId: moderatorId,
        targetAccountId: targetId,
        plan: "This must not close before the account enters recalibration.",
      }),
    ).resolves.toEqual({ kind: "invalid_state" });

    const reopenedForDismissal = await openAudit(store, openInput);
    const dismissed = await store.dismissAccountAudit({
      actorId: moderatorId,
      auditId: reopenedForDismissal.id,
      reason: "The second review did not establish an account-level pattern.",
    });
    expect(dismissed).toMatchObject({ kind: "ok", value: { state: "DISMISSED", targetState: "WARNED" } });
    expect(await targetState(targetId)).toEqual({ state: "WARNED", confirmedCount: 1 });

    const reopenedForRecalibration = await openAudit(store, openInput);
    const recalibrating = await store.substantiateAccountAudit({
      actorId: moderatorId,
      auditId: reopenedForRecalibration.id,
      reason: "The second confirmed account-level pattern requires recalibration.",
    });
    expect(recalibrating).toMatchObject({
      kind: "ok",
      value: { state: "SUBSTANTIATED", targetState: "RECALIBRATING", confirmedPatternCount: 2 },
    });
    expect(await targetState(targetId)).toEqual({ state: "RECALIBRATING", confirmedCount: 2 });
    expect(await repositoryStates(targetId)).toEqual(expectedRepositoryStates([
      { id: primaryRepositoryId, active: false },
      { id: secondaryRepositoryId, active: false },
    ]));

    const closed = await store.closeRecalibration({
      actorId: moderatorId,
      targetAccountId: targetId,
      plan: "Compare each opening label with ten completed contributions before new sponsorship activity.",
    });
    expect(closed).toMatchObject({
      kind: "ok",
      value: { targetState: "ACTIVE", confirmedPatternCount: 2, reactivatedRepositoryCount: 2 },
    });
    expect(await targetState(targetId)).toEqual({ state: "ACTIVE", confirmedCount: 2 });
    expect(await repositoryStates(targetId)).toEqual(expectedRepositoryStates([
      { id: primaryRepositoryId, active: true },
      { id: secondaryRepositoryId, active: true },
    ]));

    const reopenedForBan = await openAudit(store, openInput);
    const banned = await store.substantiateAccountAudit({
      actorId: moderatorId,
      auditId: reopenedForBan.id,
      reason: "The third confirmed account-level pattern requires a ban.",
    });
    expect(banned).toMatchObject({
      kind: "ok",
      value: { targetState: "BANNED", confirmedPatternCount: 3 },
    });
    expect(await targetState(targetId)).toEqual({ state: "BANNED", confirmedCount: 3 });
    expect(await repositoryStates(targetId)).toEqual(expectedRepositoryStates([
      { id: primaryRepositoryId, active: false },
      { id: secondaryRepositoryId, active: false },
    ]));

    const registrationStore = new PostgresRepositoryStore(sql);
    await expect(registrationStore.getEnforcementState(targetId)).resolves.toBe("BANNED");
    await expect(
      registrationStore.createRepository({
        githubRepositoryId: nextExternalId(),
        ownerName: "example/banned-registration",
        sponsorId: targetId,
        visibility: "PUBLIC",
        githubWebhookId: nextExternalId(),
        difficultyScheme: difficultyScheme(),
      }),
    ).rejects.toBeInstanceOf(RepositoryRegistrationEnforcementError);

    expect(await settlementFacts()).toEqual(settlementsBefore);
    expect(await ledgerFacts()).toEqual(ledgerBefore);
    await expect(sql<{ count: number }[]>`
      select count(*)::integer as count from self_work_calibrations where user_id = ${targetId}
    `).resolves.toEqual(selfWorkBefore);

    const events = await sql<{
      actor_id: string;
      prior_state: string;
      new_state: string;
      reason: string;
      cohort_definition: {
        sampleStartedAt?: unknown;
        sampleEndedAt?: unknown;
        selfWorkPairs?: Array<{ proofSha256?: unknown; mergedAt?: unknown }>;
        outsiderSettlementPairs?: Array<{ proofSha256?: unknown; mergedAt?: unknown }>;
      };
      cohort_statistics: { selfWork?: { count?: number }; outsider?: { count?: number } };
      recalibration_plan: string | null;
    }[]>`
      select actor_id, prior_state, new_state, reason, cohort_definition, cohort_statistics, recalibration_plan
      from moderation_events
      where target_user_id = ${targetId}
      order by created_at, id
    `;
    expect(events).toHaveLength(9);
    expect(events.every((event) => event.actor_id === moderatorId && event.reason.trim().length > 0)).toBe(true);
    expect(events.every((event) => event.cohort_definition.selfWorkPairs?.length === 10)).toBe(true);
    expect(events.every((event) => event.cohort_definition.outsiderSettlementPairs?.length === 10)).toBe(true);
    expect(events.every((event) => event.cohort_definition.selfWorkPairs?.every((pair) => typeof pair.proofSha256 === "string"))).toBe(true);
    expect(events.every((event) => event.cohort_definition.outsiderSettlementPairs?.every((pair) => typeof pair.proofSha256 === "string"))).toBe(true);
    expect(events.every((event) => event.cohort_definition.sampleStartedAt === sampleStartedAt)).toBe(true);
    expect(events.every((event) => event.cohort_definition.sampleEndedAt === sampleEndedAt)).toBe(true);
    expect(events.every((event) => event.cohort_definition.selfWorkPairs?.every((pair) => typeof pair.mergedAt === "string"))).toBe(true);
    expect(events.every((event) => event.cohort_definition.outsiderSettlementPairs?.every((pair) => typeof pair.mergedAt === "string"))).toBe(true);
    expect(events.every((event) => event.cohort_statistics.selfWork?.count === 10)).toBe(true);
    expect(events.every((event) => event.cohort_statistics.outsider?.count === 10)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        prior_state: "RECALIBRATING",
        new_state: "ACTIVE",
        recalibration_plan: "Compare each opening label with ten completed contributions before new sponsorship activity.",
      }),
    );
  }, 60_000);

  it.each([
    ["ACTIVE", 0, "UNDER_AUDIT", true, "WARNED"],
    ["WARNED", 1, "UNDER_AUDIT", true, "RECALIBRATING"],
    ["UNDER_AUDIT", 1, "UNDER_AUDIT", true, "RECALIBRATING"],
    ["RECALIBRATING", 2, "RECALIBRATING", false, "BANNED"],
    ["BANNED", 3, "BANNED", false, "BANNED"],
  ] as const)("opening an audit preserves participation restrictions for %s", async (
    priorState, confirmedCount, openedState, eligible, substantiatedState,
  ) => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");
    const repositoryId = await insertRepository(targetId);
    const pairs = await insertCalibrationPairs({ targetId, repositoryId, count: 10 });
    await sql`
      update users
      set enforcement_state = ${priorState}, confirmed_miscalibration_count = ${confirmedCount}
      where id = ${targetId}
    `;
    const store = new PostgresModerationStore(sql);
    const input = auditInput({
      actorId: moderatorId,
      targetAccountId: targetId,
      repositoryId,
      sampleStartedAt: "2020-01-01T00:00:00.000Z",
      sampleEndedAt: "2030-01-01T00:00:00.000Z",
      ...pairs,
    });

    const opened = await openAudit(store, input);
    expect(await targetState(targetId)).toEqual({ state: openedState, confirmedCount });
    expect(opened).toMatchObject({
      state: "OPEN", targetState: openedState, confirmedPatternCount: confirmedCount,
    });
    expect(isParticipationEligible(opened.targetState)).toBe(eligible);
    await expect(sql`
      select state, prior_enforcement_state from calibration_audits where id = ${opened.id}
    `).resolves.toEqual([{ state: "OPEN", prior_enforcement_state: priorState }]);
    await expect(sql`
      select prior_state, new_state from moderation_events where audit_id = ${opened.id}
    `).resolves.toEqual([{ prior_state: priorState, new_state: openedState }]);
    await expect(sql`
      select participation_eligible_at(${targetId}, now()) as eligible
    `).resolves.toEqual([{ eligible }]);

    const dismissed = await store.dismissAccountAudit({
      actorId: moderatorId,
      auditId: opened.id,
      reason: "This cohort did not substantiate another pattern.",
    });
    expect(dismissed).toMatchObject({
      kind: "ok",
      value: { state: "DISMISSED", targetState: priorState, confirmedPatternCount: confirmedCount },
    });
    expect(await targetState(targetId)).toEqual({ state: priorState, confirmedCount });
    await expect(sql`
      select prior_state, new_state from moderation_events
      where audit_id = ${opened.id} and reason = ${"This cohort did not substantiate another pattern."}
    `).resolves.toEqual([{ prior_state: openedState, new_state: priorState }]);

    const reopened = await openAudit(store, input);
    const substantiated = await store.substantiateAccountAudit({
      actorId: moderatorId,
      auditId: reopened.id,
      reason: "Independent review confirms another account-level pattern.",
    });
    expect(substantiated).toMatchObject({
      kind: "ok",
      value: {
        state: "SUBSTANTIATED", targetState: substantiatedState, confirmedPatternCount: confirmedCount + 1,
      },
    });
    expect(await targetState(targetId)).toEqual({ state: substantiatedState, confirmedCount: confirmedCount + 1 });
    await expect(sql`
      select prior_state, new_state from moderation_events
      where audit_id = ${reopened.id} and reason = ${"Independent review confirms another account-level pattern."}
    `).resolves.toEqual([{ prior_state: openedState, new_state: substantiatedState }]);
  });

  it("uses immutable merge time for identical account-wide and repository-scoped cohorts across rebuild timestamps", async () => {
    const targetId = await insertUser("MEMBER");
    const primaryRepositoryId = await insertRepository(targetId);
    const secondaryRepositoryId = await insertRepository(targetId);
    const primaryPairs = await insertCalibrationPairs({ targetId, repositoryId: primaryRepositoryId, count: 1 });
    await rebuildCalibrationFacts(primaryRepositoryId, "2040-01-01T00:00:00.000Z");
    const store = new PostgresModerationStore(sql);
    const sampleStartedAt = "2020-01-01T00:00:00.000Z";
    const sampleEndedAt = "2030-01-01T00:00:00.000Z";

    const scopedBeforeSecondaryMaterialization = await store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: primaryRepositoryId,
      sampleStartedAt,
      sampleEndedAt,
    });
    const accountWideBeforeSecondaryMaterialization = await store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: null,
      sampleStartedAt,
      sampleEndedAt,
    });

    expect(scopedBeforeSecondaryMaterialization).toEqual(primaryPairs);
    expect(accountWideBeforeSecondaryMaterialization).toEqual(primaryPairs);

    await rebuildCalibrationFacts(primaryRepositoryId, "2010-01-01T00:00:00.000Z");
    await expect(store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: primaryRepositoryId,
      sampleStartedAt,
      sampleEndedAt,
    })).resolves.toEqual(primaryPairs);
    await expect(store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: null,
      sampleStartedAt,
      sampleEndedAt,
    })).resolves.toEqual(primaryPairs);

    const secondaryPairs = await insertCalibrationPairs({ targetId, repositoryId: secondaryRepositoryId, count: 1 });
    const accountWide = await store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: null,
      sampleStartedAt,
      sampleEndedAt,
    });
    const scopedAfterSecondaryMaterialization = await store.loadCalibrationCohort({
      targetAccountId: targetId,
      repositoryId: primaryRepositoryId,
      sampleStartedAt,
      sampleEndedAt,
    });

    expect(accountWide).toEqual({
      selfWorkPairs: sortCalibrationPairs([...primaryPairs.selfWorkPairs, ...secondaryPairs.selfWorkPairs]),
      outsiderSettlementPairs: sortCalibrationPairs([
        ...primaryPairs.outsiderSettlementPairs,
        ...secondaryPairs.outsiderSettlementPairs,
      ]),
    });
    expect(scopedAfterSecondaryMaterialization).toEqual(primaryPairs);
  });

  it.each([
    ["WARNED", true],
    ["UNDER_AUDIT", true],
    ["RECALIBRATING", false],
    ["BANNED", false],
  ] as const)("the atomic registration guard permits %s exactly when participation is allowed", async (state, allowed) => {
    const sponsorId = await insertUser("MEMBER");
    const githubRepositoryId = nextExternalId();
    const registrationStore = new PostgresRepositoryStore(sql);

    await sql`
      update users set enforcement_state = ${state} where id = ${sponsorId}
    `;

    const registration = {
      githubRepositoryId,
      ownerName: `example/registration-${githubRepositoryId}`,
      sponsorId,
      visibility: "PUBLIC" as const,
      githubWebhookId: nextExternalId(),
      difficultyScheme: difficultyScheme(),
    };

    if (!allowed) {
      await expect(registrationStore.createRepository(registration)).rejects.toBeInstanceOf(
        RepositoryRegistrationEnforcementError,
      );
      return;
    }

    await expect(registrationStore.createRepository(registration)).resolves.toMatchObject({
      githubRepositoryId,
      sponsorId,
    });
  });
});

async function openAudit(store: PostgresModerationStore, input: OpenAccountAuditStoreInput) {
  const result = await store.openAccountAudit(input);
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") {
    throw new Error("Expected the audit to open.");
  }
  return result.value;
}

function auditInput(input: {
  actorId: string;
  targetAccountId: string;
  repositoryId: string;
  sampleStartedAt: string;
  sampleEndedAt: string;
  selfWorkPairs: readonly CalibrationPair[];
  outsiderSettlementPairs: readonly CalibrationPair[];
}): OpenAccountAuditStoreInput {
  return {
    actorId: input.actorId,
    targetAccountId: input.targetAccountId,
    repositoryId: input.repositoryId,
    reason: "The exact cohorts support an account-level review.",
    cohort: {
      targetAccountId: input.targetAccountId,
      repositoryId: input.repositoryId,
      sampleStartedAt: input.sampleStartedAt,
      sampleEndedAt: input.sampleEndedAt,
      selfWorkPairs: input.selfWorkPairs,
      outsiderSettlementPairs: input.outsiderSettlementPairs,
      comparison: {
        selfWork: { count: 10, meanDelta: 1, medianDelta: 1 },
        outsider: { count: 10, meanDelta: 1, medianDelta: 1 },
        differenceBetweenMeans: 0,
      },
    },
  };
}

async function insertCalibrationPairs(input: {
  targetId: string;
  repositoryId: string;
  count: number;
}): Promise<{ selfWorkPairs: CalibrationPair[]; outsiderSettlementPairs: CalibrationPair[] }> {
  const selfWorkPairs: CalibrationPair[] = [];
  const outsiderSettlementPairs: CalibrationPair[] = [];
  for (let index = 0; index < input.count; index += 1) {
    selfWorkPairs.push(await insertPair({ targetId: input.targetId, repositoryId: input.repositoryId, selfWork: true }));
    outsiderSettlementPairs.push(await insertPair({ targetId: input.targetId, repositoryId: input.repositoryId, selfWork: false }));
  }
  return { selfWorkPairs, outsiderSettlementPairs };
}

async function insertPair(input: {
  targetId: string;
  repositoryId: string;
  selfWork: boolean;
}): Promise<CalibrationPair> {
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${nextExternalId()}, ${"An account calibration issue"},
      ${"Issue evidence"}, ${`https://github.com/example/overflow/issues/${githubIssueId}`}, ${"CLOSED"},
      ${"size/M"}, 4, 4
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const authorId = input.selfWork ? input.targetId : await insertUser("MEMBER");
  const [pullRequest] = await sql<{ id: string; merged_at: string | Date }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at, proof_sha256
    )
    values (
      ${githubPullRequestId}, ${input.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/overflow/pull/${githubPullRequestId}`}, ${"A merged contribution"},
      ${"Pull request evidence"}, ${authorId}, ${"MERGED"}, now(),
      ${proofFor(githubPullRequestId)}
    )
    returning id, merged_at
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
  `;

  if (input.selfWork) {
    await sql`
      insert into self_work_calibrations (
        pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
      )
      values (${pullRequest.id}, ${issue.id}, ${input.targetId}, 4, 5)
    `;
    return {
      githubRepositoryId: await githubRepositoryIdFor(input.repositoryId),
      githubIssueId,
      githubPullRequestId,
      mergedAt: toIso(pullRequest.merged_at),
      proofSha256: proofFor(githubPullRequestId),
      offeredDifficulty: 4,
      settledDifficulty: 5,
    };
  }

  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequest.id}, ${issue.id}, ${authorId}, ${input.targetId}, 4,
      5, 0, 5, ${proofFor(githubIssueId)}, ${"SETTLED"}
    )
  `;
  return {
    githubRepositoryId: await githubRepositoryIdFor(input.repositoryId),
    githubIssueId,
    githubPullRequestId,
    mergedAt: toIso(pullRequest.merged_at),
    proofSha256: proofFor(githubIssueId),
    offeredDifficulty: 4,
    settledDifficulty: 5,
  };
}

async function insertUser(role: "MEMBER" | "MODERATOR"): Promise<string> {
  const githubUserId = nextExternalId();
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, role)
    values (${githubUserId}, ${`member-${githubUserId}`}, ${role})
    returning id
  `;
  return user.id;
}

async function insertRepository(sponsorId: string): Promise<string> {
  const githubRepositoryId = nextExternalId();
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${githubRepositoryId}, ${`example/repository-${githubRepositoryId}`}, ${sponsorId}, ${"PUBLIC"},
      ${nextExternalId()}, ${sql.json(difficultyScheme())}
    )
    returning id
  `;
  return repository.id;
}

async function targetState(targetId: string): Promise<{ state: string; confirmedCount: number }> {
  const [user] = await sql<{ enforcement_state: string; confirmed_miscalibration_count: number }[]>`
    select enforcement_state, confirmed_miscalibration_count from users where id = ${targetId}
  `;
  return { state: user.enforcement_state, confirmedCount: user.confirmed_miscalibration_count };
}

async function repositoryStates(targetId: string): Promise<Array<{ id: string; active: boolean }>> {
  return sql<{ id: string; active: boolean }[]>`
    select id, active from registered_repositories where sponsor_id = ${targetId} order by id
  `;
}

function expectedRepositoryStates(states: Array<{ id: string; active: boolean }>) {
  return [...states].sort((left, right) => left.id.localeCompare(right.id));
}

function sortCalibrationPairs(pairs: readonly CalibrationPair[]): CalibrationPair[] {
  return [...pairs].sort((left, right) => (
    left.githubRepositoryId - right.githubRepositoryId
    || left.githubIssueId - right.githubIssueId
    || left.githubPullRequestId - right.githubPullRequestId
  ));
}

async function githubRepositoryIdFor(repositoryId: string): Promise<number> {
  const [repository] = await sql<{ github_repository_id: number | string }[]>`
    select github_repository_id from registered_repositories where id = ${repositoryId}
  `;
  return Number(repository.github_repository_id);
}

async function rebuildCalibrationFacts(repositoryId: string, createdAt: string): Promise<void> {
  const selfWork = await sql<{
    pull_request_id: string;
    issue_id: string;
    user_id: string;
    opening_comparison_points: number;
    actual_points: number | null;
  }[]>`
    select pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
    from self_work_calibrations
    where issue_id in (select id from issues where repository_id = ${repositoryId})
  `;
  const outsiderSettlements = await sql<{
    pull_request_id: string;
    issue_id: string;
    creditor_id: string | null;
    creditor_github_login: string | null;
    debtor_id: string;
    opening_comparison_points: number;
    settled_points: number | null;
    review_rounds: number;
    credits: number;
    proof_sha256: string;
    status: "SETTLED" | "UNSETTLED" | "UNCLAIMED";
  }[]>`
    select pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
           opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    from settlements
    where issue_id in (select id from issues where repository_id = ${repositoryId})
  `;

  await sql.begin(async (transaction) => {
    await transaction`
      delete from self_work_calibrations
      where issue_id in (select id from issues where repository_id = ${repositoryId})
    `;
    await transaction`
      delete from settlements
      where issue_id in (select id from issues where repository_id = ${repositoryId})
    `;
    for (const row of selfWork) {
      await transaction`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, created_at
        ) values (
          ${row.pull_request_id}, ${row.issue_id}, ${row.user_id}, ${row.opening_comparison_points},
          ${row.actual_points}, ${createdAt}
        )
      `;
    }
    for (const row of outsiderSettlements) {
      await transaction`
        insert into settlements (
          pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
          opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, created_at
        ) values (
          ${row.pull_request_id}, ${row.issue_id}, ${row.creditor_id}, ${row.creditor_github_login}, ${row.debtor_id},
          ${row.opening_comparison_points}, ${row.settled_points}, ${row.review_rounds}, ${row.credits},
          ${row.proof_sha256}, ${row.status}, ${createdAt}
        )
      `;
    }
  });
}

async function settlementFacts() {
  return sql<{
    id: string;
    opening_comparison_points: number;
    settled_points: number | null;
    credits: number;
    status: string;
  }[]>`
    select id, opening_comparison_points, settled_points, credits, status from settlements order by id
  `;
}

async function ledgerFacts() {
  return sql<{ settlement_id: string; account_id: string; amount: number }[]>`
    select settlement_id, account_id, amount from ledger_entries order by settlement_id, account_id
  `;
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [{ label: "size/M", comparisonPoints: 4, reservePoints: 4 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function proofFor(identifier: number): string {
  return identifier.toString(16).padStart(64, "0");
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}
