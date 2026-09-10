import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimGitHubIdentity, PostgresFoldStore } from "@/lib/fold/postgres-store";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

/**
 * The ordering this suite pins: a fold snapshot is published while a
 * contributor's Overflow account does not exist yet, the account is then
 * created and its identity claimed, and the SAME stale snapshot is published
 * again through a fresh run. Materialization must re-resolve the claim inside
 * the publication transaction instead of replaying the snapshot's UNCLAIMED
 * state over the claimed rows.
 */
describe("identity claims survive republication of a stale fold", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "identity_claim_publication_test",
      user: "identity_claim_publication_test",
      password: "identity_claim_publication_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("keeps a claimed settlement SETTLED when a stale snapshot is republished", async () => {
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);

    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
    `;
    await claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "SETTLED", creditor_id: contributor.id }),
    ]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    const settlementChanges = (await changesFor(second.runId)).filter(
      (change) => change.entity_kind === "SETTLEMENT",
    );
    expect(settlementChanges).toEqual([]);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "SETTLED",
        creditor_id: contributor.id,
        fold_revision: FOLD_REVISION,
      }),
    ]);
    // Callers retain and reuse folds across runs, so the resolution must have
    // produced a fresh object instead of rewriting the snapshot in place.
    expect(scenario.fold.settlements[0]?.status).toBe("UNCLAIMED");
    expect(scenario.fold.settlements[0]?.creditorId).toBeNull();
    expect(scenario.fold.pullRequests[0]?.authorId).toBeNull();
  });

  it("keeps a claimed self-work calibration when a stale snapshot is republished", async () => {
    // Self-work means the claimed identity is the settlement's debtor, so the
    // debtor's users row already carries the github id: a fixed publication
    // resolves the snapshot's self-work shape immediately, an unfixed one
    // leaves the UNCLAIMED settlement for the claim to move. Either way the
    // claim converges the tables to the same claimed state.
    const scenario = await createUnclaimedScenario(sql, { creditorGitHubUserId: "sponsor" });
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    await claimGitHubIdentity(sql, scenario.sponsor.id, scenario.creditorGitHubId);
    const claimedCalibration = expect.objectContaining({
      user_id: scenario.sponsor.id,
      opening_comparison_points: 5,
      actual_points: 6,
    });
    expect(await settlementRows(scenario.repositoryId)).toEqual([]);
    expect(await calibrationRows(scenario.repositoryId)).toEqual([claimedCalibration]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    // The stale snapshot names a settlement this issue no longer has and no
    // calibration: replaying it verbatim would re-insert the settlement and
    // delete the calibration the claim produced.
    expect(await settlementRows(scenario.repositoryId)).toEqual([]);
    expect(await calibrationRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        user_id: scenario.sponsor.id,
        opening_comparison_points: 5,
        actual_points: 6,
        fold_revision: FOLD_REVISION,
      }),
    ]);
  });

  it("preserves a claimed pull request author when a stale snapshot is republished", async () => {
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
    `;
    await claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: contributor.id }),
    ]);

    await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: contributor.id }),
    ]);
  });

  it("leaves a settlement UNCLAIMED when the mapped user is not participation-eligible at merge time", async () => {
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    // No moderation events exist, so enforcement_state_at falls back to the
    // users row itself: a banned creditor is not eligible at mergedAt, and the
    // claim's own guards leave the settlement untouched.
    const [banned] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login, enforcement_state)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}, 'BANNED'::enforcement_state)
      returning id
    `;
    await claimGitHubIdentity(sql, banned.id, scenario.creditorGitHubId);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "UNCLAIMED",
        creditor_id: null,
        fold_revision: FOLD_REVISION,
      }),
    ]);
  });

  it("publishes an UNCLAIMED settlement unchanged when the github id maps to no user", async () => {
    const scenario = await createUnclaimedScenario(sql);
    const { deltas } = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(deltas).toEqual({ adds: 1, changes: 0, removals: 0 });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "UNCLAIMED",
        creditor_id: null,
        credits: 6,
        fold_revision: FOLD_REVISION,
      }),
    ]);
  });
});

let externalId = 5_000_000;

/**
 * One registered repository whose fold records one merged pull request
 * closing one issue with a settled label, and one UNCLAIMED settlement: the
 * creditor has no users row yet, so the snapshot carries only their GitHub
 * identity. Modeled on the materializeRepositoryFixture shape, which this
 * suite cannot use because its settlements are already SETTLED.
 */
async function createUnclaimedScenario(
  sql: Sql,
  options?: { creditorGitHubUserId?: "sponsor" },
) {
  const sponsorGitHubId = externalId++;
  const creditorGitHubId = options?.creditorGitHubUserId === "sponsor"
    ? sponsorGitHubId
    : externalId++;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${sponsorGitHubId}, ${`sponsor-${sponsorGitHubId}`}) returning id
  `;
  const repositoryGitHubId = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${repositoryGitHubId}, ${`owner/repo-${repositoryGitHubId}`}, ${sponsor.id}, 'PUBLIC',
      ${externalId++}, ${sql.json(validDifficultyScheme())}
    ) returning id
  `;
  const githubIssueId = externalId++;
  const githubPullRequestId = externalId++;
  const mergedAt = "2026-09-01T12:00:00.000Z";
  const mergeCommitOid = "b".repeat(40);
  const proofSha256 = repositoryGitHubId.toString(16).padStart(64, "0");
  const creditorLogin = `unclaimed-${creditorGitHubId}`;
  // An UNCLAIMED settlement carries the claim formula itself:
  // max(0, settled points - review rounds) with no creditor to credit.
  const settledEvidence = {
    settledLabel: "delivered/6", settledPoints: 6,
    settledLabelEventId: "actual", settledLabelActorLogin: `sponsor-${sponsorGitHubId}`,
    settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
    settledRationaleCommentId: "rationale", settledRationaleActorLogin: `sponsor-${sponsorGitHubId}`,
    settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
  };
  const fold: FoldResult = {
    issues: [{
      githubIssueId, number: 1, title: "Identity claim fixture", body: "", url: "https://example.test/issue",
      state: "CLOSED", updatedAt: "2026-09-01T12:05:00.000Z", openingLabel: "M", openingComparisonPoints: 5,
      openingReservePoints: 5, ownerGitHubLogin: `sponsor-${sponsorGitHubId}`,
      openingSourceEventId: `opening-${githubIssueId}`, openingSourceActorLogin: `sponsor-${sponsorGitHubId}`,
      openingSourceAt: "2026-09-01T08:00:00.000Z",
      claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null, ...settledEvidence,
    }],
    pullRequests: [{
      githubPullRequestId, number: 11, title: "Identity claim fixture", body: "", url: "https://example.test/pr",
      state: "MERGED", mergedAt, mergeCommitOid, finalCommitAt: "2026-09-01T10:00:00.000Z",
      authorId: null, authorGitHubLogin: creditorLogin, authorGitHubUserId: creditorGitHubId,
      proofSha256, githubIssueIds: [githubIssueId], reviewRounds: [],
    }],
    settlements: [{
      githubIssueId, githubPullRequestId, creditorId: null,
      creditorGitHubLogin: creditorLogin, creditorGitHubUserId: creditorGitHubId,
      debtorId: sponsor.id, openingComparisonPoints: 5, ...settledEvidence,
      mergeCommitOid, mergedAt, reviewRounds: 0, credits: 6, proofSha256, status: "UNCLAIMED",
    }],
    selfWorkCalibrations: [], unwritableClosures: [], policyViolations: [], ledgerEntries: [],
  };
  const store = new PostgresFoldStore(sql);
  const repositoryId = repository.id;
  return {
    repositoryId, store, fold, sponsor, sponsorGitHubId, creditorGitHubId,
    githubIssueId, githubPullRequestId,
  };
}

async function publish(store: PostgresFoldStore, repositoryId: string, fold: FoldResult) {
  const runId = await store.beginRun(repositoryId);
  const deltas = await store.withRepositoryReconciliation(
    repositoryId,
    async () => store.materialize({ repositoryId, runId, fold }),
  );
  return { runId, deltas };
}

function changesFor(runId: string) {
  return sql<{ entity_kind: string; change_kind: string; before_state: unknown; after_state: unknown }[]>`
    select entity_kind, change_kind, before_state, after_state
    from reconciliation_changes where reconciliation_run_id = ${runId}
  `;
}

function settlementRows(repositoryId: string) {
  return sql`
    select settlements.* from settlements
    join issues on issues.id = settlements.issue_id
    where issues.repository_id = ${repositoryId}
  `;
}

function calibrationRows(repositoryId: string) {
  return sql`
    select self_work_calibrations.* from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.repository_id = ${repositoryId}
  `;
}

function pullRequestRows(repositoryId: string) {
  return sql`
    select pull_requests.* from pull_requests
    where pull_requests.repository_id = ${repositoryId}
  `;
}
