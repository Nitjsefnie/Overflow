import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { compareCalibration, type CalibrationPair } from "@/lib/calibration/statistics";
import { closeSql, getSql } from "@/lib/db/client";
import type { OpenAccountAuditStoreInput } from "@/lib/moderation/service";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import {
  PostgresRecalibrationCreditStore,
  type CreditAdjustmentLineRecord,
} from "@/lib/moderation/credit-adjustment-store";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 77_300_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

const SAMPLE_STARTED_AT = "2020-01-01T00:00:00.000Z";
const SAMPLE_ENDED_AT = "2030-01-01T00:00:00.000Z";

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

describe("PostgreSQL recalibration credit adjustments", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "credit_adjustment_store_test",
      user: "credit_adjustment_store_test",
      password: "credit_adjustment_store_test",
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

  it("previews no figure when the account has no substantiated audit", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    const targetId = await insertUser();

    await expect(store.loadRecalibrationPreview(targetId)).resolves.toEqual({ kind: "not_found" });
    await expect(store.loadRecalibrationPreview(randomUUID())).resolves.toEqual({ kind: "not_found" });
    await expect(store.listCreditAdjustments(targetId)).resolves.toEqual([]);
  });

  it("previews the stored-snapshot figure with per-creditor lines from resolved pairs", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    const fixture = await seedActionableCohort();
    const auditId = await openSubstantiatedAudit(fixture);

    const preview = await store.loadRecalibrationPreview(fixture.targetId);
    expect(preview.kind).toBe("ok");
    if (preview.kind !== "ok") {
      throw new Error("Expected the preview to load.");
    }

    expect(preview.value.audit).toEqual({ id: auditId, decidedAt: expect.any(String) });
    expect(preview.value.snapshot.targetAccountId).toBe(fixture.targetId);
    expect(preview.value.snapshot.selfWorkPairs).toHaveLength(10);
    expect(preview.value.snapshot.outsiderSettlementPairs).toHaveLength(10);
    expect(preview.value.actionability).toEqual({
      actionable: true,
      reason: "SELF_WORK_UNDERCREDITED_OUTSIDERS",
    });
    expect(preview.value.totals).toEqual({ selfSum: 10, selfCount: 10, outSum: 0, outCount: 10 });
    expect(preview.value.figure).toEqual({ gapPerPair: 1, pairCount: 10, totalAmount: 10 });
    expect(preview.value.lines).toHaveLength(10);
    expect(sumLinesFor(preview.value.lines, fixture.creditorAId)).toBe(6);
    expect(sumLinesFor(preview.value.lines, fixture.creditorBId)).toBe(4);
  });

  it("applies the adjustment: creditors credited, sponsor debited, one action event", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    const fixture = await seedActionableCohort();
    const auditId = await openSubstantiatedAudit(fixture);
    const accountIds = [fixture.targetId, fixture.creditorAId, fixture.creditorBId];

    const ledgerBefore = await readLedgerSums(accountIds);
    const result = await store.applyRecalibrationCreditAdjustment({
      actorId: fixture.moderatorId,
      targetAccountId: fixture.targetId,
      reason: "The stored cohort undercredited outsiders by one point per pair.",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("Expected the adjustment to apply.");
    }

    expect(result.value).toMatchObject({
      calibrationAuditId: auditId,
      targetAccountId: fixture.targetId,
      gapPerPair: 1,
      pairCount: 10,
      totalAmount: 10,
      reversalOf: null,
      reason: "The stored cohort undercredited outsiders by one point per pair.",
    });
    expect(result.value.id).toEqual(expect.any(String));
    expect(result.value.moderationEventId).toEqual(expect.any(String));
    expect(result.value.createdAt).toEqual(expect.any(String));
    expect(result.value.lines).toHaveLength(10);
    expect(result.value.lines.reduce((total, line) => total + line.amount, 0)).toBe(10);
    expect(sumLinesFor(result.value.lines, fixture.creditorAId)).toBe(6);
    expect(sumLinesFor(result.value.lines, fixture.creditorBId)).toBe(4);

    const ledgerAfter = await readLedgerSums(accountIds);
    expect(ledgerDelta(ledgerBefore, ledgerAfter, fixture.creditorAId)).toBe(6);
    expect(ledgerDelta(ledgerBefore, ledgerAfter, fixture.creditorBId)).toBe(4);
    expect(ledgerDelta(ledgerBefore, ledgerAfter, fixture.targetId)).toBe(-10);

    const targetState = await enforcementStateOf(fixture.targetId);
    const [event] = await sql<{
      prior_state: string;
      new_state: string;
      audit_id: string;
      reason: string;
      recalibration_plan: string | null;
    }[]>`
      select events.prior_state, events.new_state, events.audit_id, events.reason, events.recalibration_plan
      from moderation_events as events
      join moderation_credit_adjustments as adjustments on adjustments.moderation_event_id = events.id
      where adjustments.id = ${result.value.id}
    `;
    expect(event).toEqual({
      prior_state: targetState,
      new_state: targetState,
      audit_id: auditId,
      reason: "The stored cohort undercredited outsiders by one point per pair.",
      recalibration_plan: null,
    });
  });

  it("refuses a drifted snapshot with a conflict and writes nothing", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);

    const driftedSettlement = await seedActionableCohort();
    await openSubstantiatedAudit(driftedSettlement);
    await sql`
      update settlements
      set settled_points = 6, credits = 6
      where id = ${driftedSettlement.outsiderPairs[0]!.settlementId}
    `;
    const settledResult = await store.applyRecalibrationCreditAdjustment({
      actorId: driftedSettlement.moderatorId,
      targetAccountId: driftedSettlement.targetId,
      reason: "The stored cohort no longer matches its live settlement.",
    });
    expect(settledResult).toEqual({
      kind: "conflict",
      detail: { cause: "SNAPSHOT_DRIFT", description: expect.stringMatching(/settled difficulty/) },
    });

    const previewOnDrift = await store.loadRecalibrationPreview(driftedSettlement.targetId);
    expect(previewOnDrift.kind).toBe("conflict");

    const deletedSettlement = await seedActionableCohort();
    await openSubstantiatedAudit(deletedSettlement);
    await sql`
      delete from settlements where id = ${deletedSettlement.outsiderPairs[0]!.settlementId}
    `;
    const deletedResult = await store.applyRecalibrationCreditAdjustment({
      actorId: deletedSettlement.moderatorId,
      targetAccountId: deletedSettlement.targetId,
      reason: "The stored cohort's settlement no longer exists.",
    });
    expect(deletedResult).toEqual({
      kind: "conflict",
      detail: { cause: "SNAPSHOT_DRIFT", description: expect.stringMatching(/settlement/) },
    });

    const driftedSelfWork = await seedActionableCohort();
    await openSubstantiatedAudit(driftedSelfWork);
    await sql`
      update self_work_calibrations
      set actual_points = 6
      where user_id = ${driftedSelfWork.targetId} and actual_points = 5
    `;
    const selfWorkResult = await store.applyRecalibrationCreditAdjustment({
      actorId: driftedSelfWork.moderatorId,
      targetAccountId: driftedSelfWork.targetId,
      reason: "The stored self-work cohort no longer matches its live calibration.",
    });
    expect(selfWorkResult).toEqual({
      kind: "conflict",
      detail: { cause: "SNAPSHOT_DRIFT", description: expect.stringMatching(/settled difficulty/) },
    });

    await expect(sql<{ count: number }[]>`
      select count(*)::integer as count from moderation_credit_adjustments
      where target_account_id = any(${[
        driftedSettlement.targetId,
        deletedSettlement.targetId,
        driftedSelfWork.targetId,
      ]}::uuid[])
    `).resolves.toEqual([{ count: 0 }]);
    await expect(sql<{ count: number }[]>`
      select count(*)::integer as count
      from moderation_events
      where prior_state = new_state
        and target_user_id = any(${[
          driftedSettlement.targetId,
          deletedSettlement.targetId,
          driftedSelfWork.targetId,
        ]}::uuid[])
    `).resolves.toEqual([{ count: 0 }]);
  });

  it("confines a second apply for the same audit to a conflict", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    const fixture = await seedActionableCohort();
    await openSubstantiatedAudit(fixture);

    const first = await store.applyRecalibrationCreditAdjustment({
      actorId: fixture.moderatorId,
      targetAccountId: fixture.targetId,
      reason: "The first adjustment compensates the undercredited outsiders.",
    });
    expect(first.kind).toBe("ok");
    await expect(
      store.applyRecalibrationCreditAdjustment({
        actorId: fixture.moderatorId,
        targetAccountId: fixture.targetId,
        reason: "The second adjustment must lose to the partial unique index.",
      }),
    ).resolves.toEqual({ kind: "conflict", detail: { cause: "ALREADY_APPLIED" } });
    await expect(sql<{ count: number }[]>`
      select count(*)::integer as count
      from moderation_credit_adjustments
      where target_account_id = ${fixture.targetId}
    `).resolves.toEqual([{ count: 1 }]);
  });

  it("reverses the adjustment with mirrored negative lines and confines a second reversal to a conflict", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    const fixture = await seedActionableCohort();
    const auditId = await openSubstantiatedAudit(fixture);
    const accountIds = [fixture.targetId, fixture.creditorAId, fixture.creditorBId];

    const ledgerBefore = await readLedgerSums(accountIds);
    const applied = await store.applyRecalibrationCreditAdjustment({
      actorId: fixture.moderatorId,
      targetAccountId: fixture.targetId,
      reason: "The stored cohort undercredited outsiders by one point per pair.",
    });
    expect(applied.kind).toBe("ok");
    if (applied.kind !== "ok") {
      throw new Error("Expected the adjustment to apply.");
    }
    const originalDuringApply = await readAdjustmentRow(applied.value.id);
    const ledgerDuringApply = await readLedgerSums(accountIds);
    const expectedDuringApply = new Map(ledgerBefore);
    expectedDuringApply.set(fixture.creditorAId, (ledgerBefore.get(fixture.creditorAId) ?? 0) + 6);
    expectedDuringApply.set(fixture.creditorBId, (ledgerBefore.get(fixture.creditorBId) ?? 0) + 4);
    expectedDuringApply.set(fixture.targetId, (ledgerBefore.get(fixture.targetId) ?? 0) - 10);
    expect(ledgerDuringApply).toEqual(expectedDuringApply);

    const reversal = await store.reverseModerationCreditAdjustment({
      actorId: fixture.moderatorId,
      adjustmentId: applied.value.id,
      reason: "The adjustment compensated the wrong cohort window.",
    });
    expect(reversal.kind).toBe("ok");
    if (reversal.kind !== "ok") {
      throw new Error("Expected the reversal to apply.");
    }

    expect(reversal.value).toMatchObject({
      calibrationAuditId: auditId,
      targetAccountId: fixture.targetId,
      totalAmount: 10,
      reversalOf: applied.value.id,
      reason: "The adjustment compensated the wrong cohort window.",
    });
    expect(reversal.value.id).not.toBe(applied.value.id);
    expect(reversal.value.lines).toHaveLength(10);
    expect(reversal.value.lines.reduce((total, line) => total + line.amount, 0)).toBe(-10);
    expect(
      [...reversal.value.lines].sort(bySettlementId).map((line) => [line.settlementId, line.creditorId, line.amount]),
    ).toEqual(
      [...applied.value.lines].sort(bySettlementId).map((line) => [line.settlementId, line.creditorId, -line.amount]),
    );

    expect(await readLedgerSums(accountIds)).toEqual(ledgerBefore);

    expect(await readAdjustmentRow(applied.value.id)).toEqual(originalDuringApply);

    await expect(
      store.reverseModerationCreditAdjustment({
        actorId: fixture.moderatorId,
        adjustmentId: applied.value.id,
        reason: "A second reversal must lose to the partial unique index.",
      }),
    ).resolves.toEqual({ kind: "conflict", detail: { cause: "ALREADY_REVERSED" } });
    await expect(
      store.reverseModerationCreditAdjustment({
        actorId: fixture.moderatorId,
        adjustmentId: randomUUID(),
        reason: "A reversal of an unknown adjustment is not found.",
      }),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      store.reverseModerationCreditAdjustment({
        actorId: fixture.moderatorId,
        adjustmentId: reversal.value.id,
        reason: "A reversal row itself cannot be reversed.",
      }),
    ).resolves.toEqual({ kind: "conflict", detail: { cause: "ALREADY_REVERSED" } });
  });

  it("lists applied and reversed adjustments with their reversal linkage and lines", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    const fixture = await seedActionableCohort();
    await openSubstantiatedAudit(fixture);

    const applied = await store.applyRecalibrationCreditAdjustment({
      actorId: fixture.moderatorId,
      targetAccountId: fixture.targetId,
      reason: "The stored cohort undercredited outsiders by one point per pair.",
    });
    expect(applied.kind).toBe("ok");
    if (applied.kind !== "ok") {
      throw new Error("Expected the adjustment to apply.");
    }
    const reversal = await store.reverseModerationCreditAdjustment({
      actorId: fixture.moderatorId,
      adjustmentId: applied.value.id,
      reason: "The adjustment compensated the wrong cohort window.",
    });
    expect(reversal.kind).toBe("ok");
    if (reversal.kind !== "ok") {
      throw new Error("Expected the reversal to apply.");
    }

    const adjustments = await store.listCreditAdjustments(fixture.targetId);
    expect(adjustments).toHaveLength(2);
    const original = adjustments.find((record) => record.reversalOf === null);
    const mirrored = adjustments.find((record) => record.reversalOf === applied.value.id);
    expect(original).toEqual(applied.value);
    expect(mirrored).toEqual(reversal.value);
    expect(adjustments.map((record) => record.createdAt)).toEqual(
      [...adjustments.map((record) => record.createdAt)].sort().reverse(),
    );
    await expect(store.listCreditAdjustments(randomUUID())).resolves.toEqual([]);
  });

  it("refuses to apply when a positive gap rounds to a zero-point figure", async () => {
    const store = new PostgresRecalibrationCreditStore(sql);
    // self 10 pairs: one +1 delta and nine 0 deltas; outsider 13 pairs: one +1
    // and twelve 0. The gap is real and positive, but its figure rounds to zero.
    const selfWorkDeltas: Array<readonly [number, number]> = [
      [4, 5],
      ...Array.from({ length: 9 }, () => [4, 4] as const),
    ];
    const outsiderDeltas: Array<readonly [number, number]> = [
      [4, 5],
      ...Array.from({ length: 12 }, () => [4, 4] as const),
    ];
    const fixture = await seedCohort({ selfWorkDeltas, outsiderDeltas });
    await openSubstantiatedAudit(fixture);

    const preview = await store.loadRecalibrationPreview(fixture.targetId);
    expect(preview.kind).toBe("ok");
    if (preview.kind !== "ok") {
      throw new Error("Expected the preview to load.");
    }
    expect(preview.value.actionability).toEqual({
      actionable: true,
      reason: "SELF_WORK_UNDERCREDITED_OUTSIDERS",
    });
    expect(preview.value.figure).toEqual({ gapPerPair: 3 / 130, pairCount: 13, totalAmount: 0 });
    expect(preview.value.lines).toEqual([]);

    await expect(
      store.applyRecalibrationCreditAdjustment({
        actorId: fixture.moderatorId,
        targetAccountId: fixture.targetId,
        reason: "A zero-point figure compensates nobody.",
      }),
    ).resolves.toEqual({
      kind: "not_actionable",
      actionability: { actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" },
    });

    await expect(sql<{ count: number }[]>`
      select count(*)::integer as count from moderation_credit_adjustments
      where target_account_id = ${fixture.targetId}
    `).resolves.toEqual([{ count: 0 }]);
    await expect(sql<{ count: number }[]>`
      select count(*)::integer as count
      from moderation_events
      where prior_state = new_state and target_user_id = ${fixture.targetId}
    `).resolves.toEqual([{ count: 0 }]);
  });
});

type SeededOutsiderPair = { pair: CalibrationPair; settlementId: string; creditorId: string };

type CohortFixture = {
  moderatorId: string;
  targetId: string;
  repositoryId: string;
  creditorAId: string;
  creditorBId: string;
  selfWorkPairs: CalibrationPair[];
  outsiderPairs: SeededOutsiderPair[];
};

/**
 * Seeds one sponsor with two creditors and the issue/PR/self-work/settlement
 * rows a calibration pair needs, with per-pair offered/settled difficulties.
 */
async function seedCohort(input: {
  selfWorkDeltas: ReadonlyArray<readonly [number, number]>;
  outsiderDeltas: ReadonlyArray<readonly [number, number]>;
}): Promise<CohortFixture> {
  const moderatorId = await insertUser("MODERATOR");
  const targetId = await insertUser();
  const repositoryId = await insertRepository(await insertUser());
  const creditorAId = await insertUser();
  const creditorBId = await insertUser();

  const selfWorkPairs: CalibrationPair[] = [];
  for (const [offered, settled] of input.selfWorkDeltas) {
    selfWorkPairs.push(await seedSelfWorkPair({ targetId, repositoryId, offered, settled }));
  }
  const outsiderPairs: SeededOutsiderPair[] = [];
  for (const [index, [offered, settled]] of input.outsiderDeltas.entries()) {
    outsiderPairs.push(
      await seedOutsiderPair({
        targetId,
        repositoryId,
        creditorId: index < 6 ? creditorAId : creditorBId,
        offered,
        settled,
      }),
    );
  }
  return { moderatorId, targetId, repositoryId, creditorAId, creditorBId, selfWorkPairs, outsiderPairs };
}

async function seedActionableCohort(): Promise<CohortFixture> {
  // Self work settles one point above its openings (mean delta 1); outsider
  // settlements land exactly on them (mean delta 0). Ten pairs each keeps both
  // floors met, six/four splits the outsider settlements across two creditors.
  const selfWorkDeltas = Array.from({ length: 10 }, () => [4, 5] as const);
  const outsiderDeltas = Array.from({ length: 10 }, () => [4, 4] as const);
  return seedCohort({ selfWorkDeltas, outsiderDeltas });
}

async function seedSelfWorkPair(input: {
  targetId: string;
  repositoryId: string;
  offered: number;
  settled: number;
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
      ${"size/M"}, ${input.offered}, ${input.offered}
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await sql<{ id: string; merged_at: string | Date }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at, proof_sha256
    )
    values (
      ${githubPullRequestId}, ${input.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/overflow/pull/${githubPullRequestId}`}, ${"A merged contribution"},
      ${"Pull request evidence"}, ${input.targetId}, ${"MERGED"}, now(),
      ${proofFor(githubPullRequestId)}
    )
    returning id, merged_at
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
  `;
  await sql`
    insert into self_work_calibrations (
      pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
    )
    values (${pullRequest.id}, ${issue.id}, ${input.targetId}, ${input.offered}, ${input.settled})
  `;
  return {
    githubRepositoryId: await githubRepositoryIdFor(input.repositoryId),
    githubIssueId,
    githubPullRequestId,
    mergedAt: toIso(pullRequest.merged_at),
    proofSha256: proofFor(githubPullRequestId),
    offeredDifficulty: input.offered,
    settledDifficulty: input.settled,
  };
}

async function seedOutsiderPair(input: {
  targetId: string;
  repositoryId: string;
  creditorId: string;
  offered: number;
  settled: number;
}): Promise<SeededOutsiderPair> {
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${nextExternalId()}, ${"An account calibration issue"},
      ${"Issue evidence"}, ${`https://github.com/example/overflow/issues/${githubIssueId}`}, ${"CLOSED"},
      ${"size/M"}, ${input.offered}, ${input.offered}
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await sql<{ id: string; merged_at: string | Date }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at, proof_sha256
    )
    values (
      ${githubPullRequestId}, ${input.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/overflow/pull/${githubPullRequestId}`}, ${"A merged contribution"},
      ${"Pull request evidence"}, ${input.creditorId}, ${"MERGED"}, now(),
      ${proofFor(githubPullRequestId)}
    )
    returning id, merged_at
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
  `;
  const [settlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequest.id}, ${issue.id}, ${input.creditorId}, ${input.targetId}, ${input.offered},
      ${input.settled}, 0, ${input.settled}, ${proofFor(githubIssueId)}, ${"SETTLED"}
    )
    returning id
  `;
  return {
    pair: {
      githubRepositoryId: await githubRepositoryIdFor(input.repositoryId),
      githubIssueId,
      githubPullRequestId,
      mergedAt: toIso(pullRequest.merged_at),
      proofSha256: proofFor(githubIssueId),
      offeredDifficulty: input.offered,
      settledDifficulty: input.settled,
    },
    settlementId: settlement.id,
    creditorId: input.creditorId,
  };
}

async function openSubstantiatedAudit(fixture: CohortFixture): Promise<string> {
  const store = new PostgresModerationStore(sql);
  const outsiderSettlementPairs = fixture.outsiderPairs.map((entry) => entry.pair);
  const opened = await store.openAccountAudit({
    actorId: fixture.moderatorId,
    targetAccountId: fixture.targetId,
    repositoryId: fixture.repositoryId,
    reason: "The exact cohorts support an account-level review.",
    cohort: {
      targetAccountId: fixture.targetId,
      repositoryId: fixture.repositoryId,
      sampleStartedAt: SAMPLE_STARTED_AT,
      sampleEndedAt: SAMPLE_ENDED_AT,
      selfWorkPairs: fixture.selfWorkPairs,
      outsiderSettlementPairs,
      comparison: compareCalibration(fixture.selfWorkPairs, outsiderSettlementPairs),
    },
  } satisfies OpenAccountAuditStoreInput);
  expect(opened.kind).toBe("ok");
  if (opened.kind !== "ok") {
    throw new Error("Expected the audit to open.");
  }

  const substantiated = await store.substantiateAccountAudit({
    actorId: fixture.moderatorId,
    auditId: opened.value.id,
    reason: "Independent review confirms the account-level pattern.",
  });
  expect(substantiated.kind).toBe("ok");
  if (substantiated.kind !== "ok") {
    throw new Error("Expected the audit to substantiate.");
  }
  return opened.value.id;
}

async function insertUser(role: "MEMBER" | "MODERATOR" = "MEMBER"): Promise<string> {
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
      ${nextExternalId()}, ${sql.json(validDifficultyScheme())}::jsonb
    )
    returning id
  `;
  return repository.id;
}

async function githubRepositoryIdFor(repositoryId: string): Promise<number> {
  const [repository] = await sql<{ github_repository_id: number | string }[]>`
    select github_repository_id from registered_repositories where id = ${repositoryId}
  `;
  return Number(repository.github_repository_id);
}

async function readLedgerSums(accountIds: readonly string[]): Promise<Map<string, number>> {
  const rows = await sql<{ account_id: string; total: number }[]>`
    select account_id, sum(amount)::integer as total
    from ledger_entries
    where account_id = any(${accountIds}::uuid[])
    group by account_id
  `;
  return new Map(rows.map((row) => [row.account_id, row.total]));
}

function ledgerDelta(
  before: Map<string, number>,
  after: Map<string, number>,
  accountId: string,
): number {
  return (after.get(accountId) ?? 0) - (before.get(accountId) ?? 0);
}

async function enforcementStateOf(accountId: string): Promise<string> {
  const [row] = await sql<{ enforcement_state: string }[]>`
    select enforcement_state from users where id = ${accountId}
  `;
  return row.enforcement_state;
}

async function readAdjustmentRow(id: string) {
  const [row] = await sql<{
    id: string;
    moderation_event_id: string;
    calibration_audit_id: string;
    target_account_id: string;
    gap_per_pair: string;
    pair_count: number;
    total_amount: number;
    state: string;
    reversal_of: string | null;
    reason: string;
    created_at: Date;
  }[]>`
    select id, moderation_event_id, calibration_audit_id, target_account_id, gap_per_pair,
           pair_count, total_amount, state::text as state, reversal_of, reason, created_at
    from moderation_credit_adjustments
    where id = ${id}
  `;
  return row;
}

function sumLinesFor(
  lines: readonly CreditAdjustmentLineRecord[],
  creditorId: string,
): number {
  return lines
    .filter((line) => line.creditorId === creditorId)
    .reduce((total, line) => total + line.amount, 0);
}

function bySettlementId(
  left: CreditAdjustmentLineRecord,
  right: CreditAdjustmentLineRecord,
): number {
  return left.settlementId.localeCompare(right.settlementId);
}

function proofFor(identifier: number): string {
  return identifier.toString(16).padStart(64, "0");
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
