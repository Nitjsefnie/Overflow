import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues, type EligibleIssueFilters } from "@/lib/dashboard/queries";

let sql: Sql;
let container: StartedTestContainer | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;
let externalId = 9_586_000;
const nextId = () => ++externalId;

describe("completed-work receiving limits against PostgreSQL", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "sponsor_credit_limit", user: "sponsor_credit_limit", password: "sponsor_credit_limit",
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

  it("keeps an exhausted sponsor discoverable to a contributor with no repositories", async () => {
    const sponsor = await account();
    const worker = await account();
    const viewerExternalId = nextId();
    const [viewer] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${viewerExternalId}, ${`contributor-${viewerExternalId}`}) returning id
    `;
    await issue(sponsor.repositoryId, "OPEN");
    await settle(worker, sponsor, 10, 1);
    const visible = await listEligibleIssues(viewer.id, { repository: sponsor.ownerName });
    expect(visible.map((row) => row.id)).toEqual([sponsor.issueId]);
    expect(visible[0]).toMatchObject({ claimState: "OPEN", availableHeadroom: -10 });
  });

  it("keeps one issue per exhausted sponsor after an outsider drains the market", async () => {
    const alice = await account();
    const bob = await account();
    const outsider = await account();
    const aliceNext = await issue(alice.repositoryId, "OPEN");
    await issue(bob.repositoryId, "OPEN");
    const market = async (viewer: Account) => (await listEligibleIssues(viewer.id))
      .filter((row) => [alice.login, bob.login].includes(row.sponsorLogin!))
      .map((row) => row.id);
    expect(await market(outsider)).toHaveLength(4);
    await settle(outsider, alice, 10, 1);
    await settle(outsider, bob, 10, 2);
    expect(await creditState(outsider)).toEqual({ balance: 20, repaidDebt: 0, creditLimit: 10 });
    expect(await market(outsider)).toEqual([alice.issueId, bob.issueId]);
    expect(await market(alice)).toEqual([bob.issueId]);
    expect(await market(bob)).toEqual([alice.issueId]);
    // Completing more outsider work can deepen debt, but rolls the one open slot forward.
    await settle(outsider, alice, 5, 3, alice.issueId);
    expect(await market(outsider)).toEqual([bob.issueId, aliceNext]);
    expect(await creditState(alice)).toEqual({ balance: -15, repaidDebt: 0, creditLimit: 10 });
  });

  it("chooses one exception across repositories and labels before presentation filters, then restores ordinary discovery on repayment", async () => {
    const sponsor = await account();
    const second = await account();
    const worker = await account();
    await sql`update registered_repositories set sponsor_id = ${sponsor.id} where id = ${second.repositoryId}`;
    const expensive = await issue(sponsor.repositoryId, "OPEN", { points: 10, label: "L" });
    // A newer cheap issue wins over the older five-point issues in either repository.
    const canonical = await issue(second.repositoryId, "OPEN", { points: 1, label: "S" });
    const visible = async (filters: EligibleIssueFilters = {}) => (await listEligibleIssues(worker.id, filters))
      .filter((row) => row.sponsorLogin === sponsor.login).map((row) => row.id);
    const all = [sponsor.issueId, second.issueId, expensive, canonical];
    expect((await visible()).sort()).toEqual([...all].sort());
    await settle(worker, sponsor, 10, 1);
    expect(await visible()).toEqual([canonical]);
    expect(await visible({ repository: sponsor.ownerName })).toEqual([]);
    expect(await visible({ openingLabel: "M" })).toEqual([]);
    expect(await visible({ repository: second.ownerName, openingLabel: "M" })).toEqual([]);
    expect(await visible({ repository: second.ownerName, openingLabel: "S" })).toEqual([canonical]);
    await settle(sponsor, worker, 1, 2);
    expect(await creditState(sponsor)).toEqual({ balance: -9, repaidDebt: 1, creditLimit: 10 });
    expect((await visible()).sort()).toEqual([...all].sort());
  });

  it("rolls the exception past claims and closures while retaining claimed views and reservations", async () => {
    const sponsor = await account();
    const worker = await account();
    const next = await issue(sponsor.repositoryId, "OPEN");
    const last = await issue(sponsor.repositoryId, "OPEN");
    await settle(worker, sponsor, 10, 1);
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
    await sql`update issues set claim_assignee_github_login = ${worker.login},
      claim_assignee_github_user_id = ${worker.githubId} where id = ${sponsor.issueId}`;
    expect(await board(sponsor, worker)).toEqual([next]);
    expect(await board(sponsor, worker, { claimState: "CLAIMED" })).toEqual([sponsor.issueId]);
    expect(await board(sponsor, worker, { claimState: "ALL" })).toEqual([sponsor.issueId, next]);
    const rows = await listEligibleIssues(worker.id, { repository: sponsor.ownerName, claimState: "ALL" });
    expect(rows.map((row) => row.availableHeadroom)).toEqual([-15, -15]);
    await sql`update issues set state = 'CLOSED' where id = ${next}`;
    expect(await board(sponsor, worker)).toEqual([last]);
    await sql`update issues set state = 'CLOSED' where id = ${sponsor.issueId}`;
    expect(await board(sponsor, worker, { claimState: "CLAIMED" })).toEqual([]);
    expect(await board(sponsor, worker, { claimState: "ALL" })).toEqual([last]);
  });

  it("preserves viewer, active-repository and enforcement exclusions for exceptions", async () => {
    const sponsor = await account();
    const inactive = await account();
    const worker = await account();
    await sql`update registered_repositories set sponsor_id = ${sponsor.id}, active = false
      where id = ${inactive.repositoryId}`;
    await issue(inactive.repositoryId, "OPEN", { points: 1, label: "S" });
    await settle(worker, sponsor, 10, 1);
    for (const state of ["ACTIVE", "WARNED", "UNDER_AUDIT"]) {
      await sql`update users set enforcement_state = ${state} where id = ${sponsor.id}`;
      expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
      expect(await board(inactive, worker)).toEqual([]);
      expect(await board(sponsor, sponsor, { claimState: "ALL" })).toEqual([]);
    }
    for (const state of ["RECALIBRATING", "BANNED"]) {
      await sql`update users set enforcement_state = ${state} where id = ${sponsor.id}`;
      expect(await board(sponsor, worker, { claimState: "ALL" })).toEqual([]);
    }
  });

  it("breaks equal prices by age, then immutable provider, instance, project and issue identity", async () => {
    const sponsor = await account();
    const worker = await account();
    const githubLater = await account();
    const gitlabLaterInstance = await account();
    const gitlabLaterProject = await account();
    const gitlabFirst = await account();
    const repositories = [githubLater, gitlabLaterInstance, gitlabLaterProject, gitlabFirst];
    for (const repository of repositories) {
      await sql`update registered_repositories set sponsor_id = ${sponsor.id} where id = ${repository.repositoryId}`;
    }
    // GitHub must win on provider even when its instance sorts after GitLab's.
    await sql`update registered_repositories set instance_url = 'https://zz.example'
      where id in (${sponsor.repositoryId}, ${githubLater.repositoryId})`;
    await sql`update registered_repositories set provider = 'gitlab', instance_url = 'https://z.example',
      forge_project_id = 1 where id = ${gitlabLaterInstance.repositoryId}`;
    await sql`update registered_repositories set provider = 'gitlab', instance_url = 'https://a.example',
      forge_project_id = 20 where id = ${gitlabLaterProject.repositoryId}`;
    await sql`update registered_repositories set provider = 'gitlab', instance_url = 'https://a.example',
      forge_project_id = 10 where id = ${gitlabFirst.repositoryId}`;
    const lowerIssueNumber = await issue(sponsor.repositoryId, "OPEN");
    await sql`update issues set issue_number = 1 where id = ${lowerIssueNumber}`;
    // The later GitHub repository must lose even with a lower issue number.
    await sql`update issues set issue_number = 2 where id = ${githubLater.issueId}`;
    const ids = [sponsor.issueId, lowerIssueNumber, ...repositories.map((repository) => repository.issueId)];
    await sql`update issues set created_at = '2026-01-02' where id in ${sql(ids)}`;
    // Age precedes even the forge provider key.
    await sql`update issues set created_at = '2026-01-01' where id = ${gitlabLaterInstance.issueId}`;
    await settle(worker, sponsor, 10, 1);
    const visible = async () => (await listEligibleIssues(worker.id))
      .filter((row) => row.sponsorLogin === sponsor.login).map((row) => row.id);
    expect(await visible()).toEqual([gitlabLaterInstance.issueId]);
    await sql`update issues set created_at = '2026-01-02' where id = ${gitlabLaterInstance.issueId}`;
    // Insertion order, UUIDs, names and global GitHub issue ids cannot break a tie.
    await sql`update registered_repositories set owner_name = ${`zzz-${nextId()}/renamed`}
      where id = ${sponsor.repositoryId}`;
    const [recreated] = await sql<{ id: string }[]>`
      update issues set id = gen_random_uuid(), title = 'renamed canonical issue'
      where id = ${lowerIssueNumber} returning id
    `;
    const expectedOrder = [recreated.id, sponsor.issueId, githubLater.issueId,
      gitlabFirst.issueId, gitlabLaterProject.issueId, gitlabLaterInstance.issueId];
    for (const expected of expectedOrder) {
      expect(await visible()).toEqual([expected]);
      await sql`update issues set state = 'CLOSED' where id = ${expected}`;
    }
    expect(await visible()).toEqual([]);
  });

  it("grows the limit after ten repaid credits so a later -10 balance stays discoverable", async () => {
    // A fixed -10 cutoff would leave only the exception after a debt/repayment cycle.
    const sponsor = await account();
    const worker = await account();
    const secondIssue = await issue(sponsor.repositoryId, "OPEN");
    await settle(worker, sponsor, 10, 1);
    await settle(sponsor, worker, 10, 2);
    await settle(worker, sponsor, 10, 3);
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId, secondIssue]);
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 10, creditLimit: 11 });
  });

  it("keeps claims valid past the cutoff and restores discovery after a partial repayment", async () => {
    const sponsor = await account();
    const worker = await account();
    expect(await creditState(sponsor)).toEqual({ balance: 0, repaidDebt: 0, creditLimit: 10 });
    const claimedIssue = await issue(sponsor.repositoryId, "OPEN");
    await sql`update issues set claim_assignee_github_login = ${worker.login},
      claim_assignee_github_user_id = ${worker.githubId} where id = ${claimedIssue}`;
    // Reservations do not consume the limit, even when they exceed it.
    for (let index = 0; index < 3; index++) {
      const reserved = await issue(sponsor.repositoryId, "OPEN");
      await sql`update issues set claim_assignee_github_login = ${worker.login},
        claim_assignee_github_user_id = ${worker.githubId} where id = ${reserved}`;
    }
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
    expect(await creditState(sponsor)).toEqual({ balance: 0, repaidDebt: 0, creditLimit: 10 });
    await settle(worker, sponsor, 10, 1);
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
    expect(await board(sponsor, worker, { claimState: "ALL" })).toContain(claimedIssue);
    expect(await board(sponsor, worker, { claimState: "CLAIMED" })).toContain(claimedIssue);
    await settle(worker, sponsor, 5, 2, claimedIssue);
    expect(await creditState(sponsor)).toEqual({ balance: -15, repaidDebt: 0, creditLimit: 10 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
    await settle(sponsor, worker, 6, 3);
    expect(await creditState(sponsor)).toEqual({ balance: -9, repaidDebt: 6, creditLimit: 10 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
  });
  it("counts only debt repaid, accumulates partial cycles and floors each ten-credit increase", async () => {
    const sponsor = await account();
    const worker = await account();
    await settle(sponsor, worker, 10, 1);
    expect(await creditState(sponsor)).toEqual({ balance: 10, repaidDebt: 0, creditLimit: 10 });
    await settle(worker, sponsor, 10, 2);
    await settle(worker, sponsor, 5, 3);
    await settle(sponsor, worker, 10, 4);
    expect(await creditState(sponsor)).toEqual({ balance: 5, repaidDebt: 5, creditLimit: 10 });
    await settle(worker, sponsor, 10, 5);
    await settle(sponsor, worker, 4, 6);
    expect(await creditState(sponsor)).toEqual({ balance: -1, repaidDebt: 9, creditLimit: 10 });
    await settle(sponsor, worker, 10, 7);
    expect(await creditState(sponsor)).toEqual({ balance: 9, repaidDebt: 10, creditLimit: 11 });
    await settle(worker, sponsor, 10, 8);
    await settle(worker, sponsor, 10, 9);
    expect(await creditState(sponsor)).toEqual({ balance: -11, repaidDebt: 10, creditLimit: 11 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
    await settle(sponsor, worker, 10, 10);
    expect(await creditState(sponsor)).toEqual({ balance: -1, repaidDebt: 20, creditLimit: 12 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
  });

  it("recomputes corrected history and preserves limits through full materializer re-derivation", async () => {
    const sponsor = await account();
    const worker = await account();
    await settle(worker, sponsor, 10, 1);
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    const contribution = fold.settlements[0];
    contribution.creditorId = sponsor.id;
    contribution.creditorGitHubLogin = sponsor.login;
    contribution.creditorGitHubUserId = sponsor.githubId;
    Object.assign(fold.pullRequests[0], {
      authorId: sponsor.id, authorGitHubLogin: sponsor.login, authorGitHubUserId: sponsor.githubId,
    });
    const publish = async () => {
      const runId = await store.beginRun(repositoryId, { rederivation: true });
      return store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold }));
    };
    await publish();
    expect(await creditState(sponsor)).toEqual({ balance: -4, repaidDebt: 6, creditLimit: 10 });
    // Correcting the effective amount rewrites its historical repayment.
    contribution.credits = contribution.settledPoints = 10;
    await publish();
    await settle(worker, sponsor, 10, 280);
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 10, creditLimit: 11 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
    await publish();
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 10, creditLimit: 11 });
    // Force the materializer to recreate the derived row with a new UUID and
    // creation time; immutable merge provenance must still determine repayment.
    await sql`delete from settlements where issue_id in (select id from issues where repository_id = ${repositoryId})`;
    await publish();
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 10, creditLimit: 11 });
    contribution.credits = contribution.settledPoints = 6;
    await publish();
    expect(await creditState(sponsor)).toEqual({ balance: -14, repaidDebt: 6, creditLimit: 10 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
  });

  it("does not repay debt or grow the limit for completed self-work", async () => {
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    const sponsor = { id: fold.selfWorkCalibrations[0].userId };
    expect(await creditState(sponsor)).toEqual({ balance: -6, repaidDebt: 0, creditLimit: 10 });
    fold.selfWorkCalibrations[0].actualPoints = 10;
    const runId = await store.beginRun(repositoryId);
    await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold }));
    expect(await sql`select actual_points from self_work_calibrations where user_id = ${sponsor.id}`)
      .toEqual([{ actual_points: 10 }]);
    expect(await creditState(sponsor)).toEqual({ balance: -6, repaidDebt: 0, creditLimit: 10 });
  });

  it("counts contributions against the balance after moderation but never counts a reversal as repayment", async () => {
    const sponsor = await account();
    const worker = await account();
    const debt = await settle(worker, sponsor, 10, 1);
    await settle(sponsor, worker, 10, 2);
    const adjustmentId = await adjustment(sponsor, worker, debt.id, 10, 3);
    await settle(sponsor, worker, 10, 4);
    // The contribution repaid ten credits of adjusted debt, too.
    expect(await creditState(sponsor)).toEqual({ balance: 0, repaidDebt: 20, creditLimit: 12 });
    await adjustment(sponsor, worker, debt.id, -10, 5, adjustmentId);
    expect(await creditState(sponsor)).toEqual({ balance: 10, repaidDebt: 20, creditLimit: 12 });
  });

  it("does not grow either limit from adjustment credits or reversal credits received while indebted", async () => {
    const sponsor = await account();
    const worker = await account();
    const other = await account();
    await settle(other, worker, 10, -1);
    await settle(other, worker, 10, 0);
    const debt = await settle(worker, sponsor, 10, 1);
    const adjustmentId = await adjustment(sponsor, worker, debt.id, 10, 2);
    expect(await creditState(worker)).toEqual({ balance: 0, repaidDebt: 10, creditLimit: 11 });
    await adjustment(sponsor, worker, debt.id, -10, 3, adjustmentId);
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 0, creditLimit: 10 });
    expect(await creditState(worker)).toEqual({ balance: -10, repaidDebt: 10, creditLimit: 11 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
  });

  it("replays late-arriving settlements by merge time rather than materialization time", async () => {
    const sponsor = await account();
    const worker = await account();
    await settle(worker, sponsor, 10, 2);
    await settle(sponsor, worker, 10, 3);
    expect(await creditState(sponsor)).toEqual({ balance: 0, repaidDebt: 10, creditLimit: 11 });
    await settle(sponsor, worker, 10, 1);
    expect(await creditState(sponsor)).toEqual({ balance: 10, repaidDebt: 0, creditLimit: 10 });
  });

  it("breaks equal merge times by immutable source keys independent of local row identity", async () => {
    // The sponsor's repository has the smaller forge id. Its debit sorts
    // before the worker repository's credit, even though the credit arrives first.
    const sponsor = await account();
    const worker = await account();
    const credit = await settle(sponsor, worker, 10, 1);
    const debit = await settle(worker, sponsor, 10, 1);
    expect(await creditState(sponsor)).toEqual({ balance: 0, repaidDebt: 10, creditLimit: 11 });
    await sql`update settlements set id = gen_random_uuid(), created_at = '2030-01-01' where id = ${debit.id}`;
    await sql`update settlements set id = gen_random_uuid(), created_at = '2020-01-01' where id = ${credit.id}`;
    expect(await creditState(sponsor)).toEqual({ balance: 0, repaidDebt: 10, creditLimit: 11 });
  });

  it("replays undated debt before dated work even after the historical row is recreated", async () => {
    const sponsor = await account();
    const worker = await account();
    const undated = await settle(worker, sponsor, 10, 1);
    await sql`update pull_requests set merged_at = null where id = ${undated.pullRequestId}`;
    await settle(sponsor, worker, 10, 2);
    await settle(worker, sponsor, 10, 3);
    // NULLS LAST would replay the earning before either debit: no demonstrated
    // repayment and a limit of ten at the final -10 balance.
    const facts = async () => ({ state: await creditState(sponsor), visible: await board(sponsor, worker) });
    const expected = {
      state: { balance: -10, repaidDebt: 10, creditLimit: 11 }, visible: [sponsor.issueId],
    };
    expect(await facts()).toEqual(expected);

    const [recreated] = await sql<{ id: string }[]>`
      with removed as (
        delete from settlements where id = ${undated.id} returning *
      )
      insert into settlements (
        pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
        settled_points, review_rounds, credits, proof_sha256, status, created_at
      )
      select pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
        settled_points, review_rounds, credits, proof_sha256, status, '2040-01-01'::timestamptz
      from removed returning id
    `;
    expect(recreated.id).not.toBe(undated.id);
    expect(await facts()).toEqual(expected);
  });

  it("ignores unsettled, unclaimed and zero-credit work when deriving repayment", async () => {
    const sponsor = await account();
    const worker = await account();
    await settle(worker, sponsor, 10, 1);
    const contribution = await settle(sponsor, worker, 10, 2);
    await sql`update settlements set status = 'UNSETTLED', settled_points = null, credits = 0 where id = ${contribution.id}`;
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 0, creditLimit: 10 });
    await sql`update settlements set status = 'UNCLAIMED', creditor_id = null,
      creditor_github_login = ${sponsor.login}, settled_points = 10, credits = 10 where id = ${contribution.id}`;
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 0, creditLimit: 10 });
    await sql`update settlements set status = 'SETTLED', creditor_id = ${sponsor.id},
      review_rounds = 10, credits = 0 where id = ${contribution.id}`;
    expect(await creditState(sponsor)).toEqual({ balance: -10, repaidDebt: 0, creditLimit: 10 });
    expect(await board(sponsor, worker)).toEqual([sponsor.issueId]);
  });
});

type Account = { id: string; githubId: number; login: string; repositoryId: string; ownerName: string; issueId: string };

async function account(): Promise<Account> {
  const githubId = nextId();
  const login = `limit-${githubId}`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubId}, ${login}) returning id
  `;
  const ownerName = `${login}/work`;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (${nextId()}, ${ownerName}, ${user.id}, 'PUBLIC', ${nextId()}, ${sql.json(validDifficultyScheme())})
    returning id
  `;
  const issueId = await issue(repository.id, "OPEN");
  return { id: user.id, githubId, login, repositoryId: repository.id, ownerName, issueId };
}

async function issue(
  repositoryId: string,
  state: "OPEN" | "CLOSED",
  rating = { points: 5, label: "M" },
): Promise<string> {
  const id = nextId();
  const [row] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    ) values (${id}, ${repositoryId}, ${id}, ${`issue ${id}`}, '', ${`https://github.com/limit/work/issues/${id}`},
      ${state}, ${rating.label}, ${rating.points}, ${rating.points}) returning id
  `;
  return row.id;
}

async function settle(creditor: Account, debtor: Account, credits: number, day: number, existingIssueId?: string) {
  const issueId = existingIssueId ?? await issue(debtor.repositoryId, "CLOSED");
  if (existingIssueId !== undefined) await sql`update issues set state = 'CLOSED' where id = ${issueId}`;
  const external = nextId();
  const mergedAt = new Date(Date.UTC(2026, 0, day)).toISOString();
  const [pull] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, state, merged_at
    ) values (${external}, ${debtor.repositoryId}, ${issueId}, ${external},
      ${`https://github.com/limit/work/pull/${external}`}, 'completed contribution', '', 'MERGED', ${mergedAt})
    returning id
  `;
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pull.id}, ${issueId}, ${debtor.repositoryId})`;
  const [settlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status
    ) values (${pull.id}, ${issueId}, ${creditor.id}, ${debtor.id}, 5, ${credits}, 0, ${credits},
      ${external.toString(16).padStart(64, "0")}, 'SETTLED') returning id
  `;
  return { id: settlement.id, pullRequestId: pull.id, issueId };
}

async function board(sponsor: Account, viewer: Account, filters: EligibleIssueFilters = {}) {
  return (await listEligibleIssues(viewer.id, { repository: sponsor.ownerName, ...filters })).map((row) => row.id);
}

async function creditState(account: { id: string }) {
  const [row] = await sql`
    select coalesce(balances.balance, 0) as balance,
      coalesce(limits.repaid_debt, 0) as repaid_debt, coalesce(limits.credit_limit, 10) as credit_limit
    from users
    left join balances on balances.account_id = users.id
    left join account_credit_limits as limits on limits.account_id = users.id
    where users.id = ${account.id}
  `;
  return { balance: Number(row.balance), repaidDebt: Number(row.repaid_debt), creditLimit: Number(row.credit_limit) };
}

async function adjustment(sponsor: Account, worker: Account, settlementId: string, amount: number, day: number, reversalOf?: string) {
  const [event] = await sql<{ id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (${sponsor.id}, ${worker.id}, 'ACTIVE', 'UNDER_AUDIT', 'fixture audit') returning id
  `;
  const [audit] = reversalOf === undefined ? await sql<{ id: string }[]>`
    insert into calibration_audits (account_id, reporter_id, rationale, sample_started_at, sample_ended_at, settled_sample_size)
    values (${sponsor.id}, ${worker.id}, 'fixture sample', '2025-01-01', '2025-02-01', 1) returning id
  ` : await sql<{ id: string }[]>`select calibration_audit_id as id from moderation_credit_adjustments where id = ${reversalOf}`;
  const [row] = await sql<{ id: string }[]>`
    insert into moderation_credit_adjustments (
      moderation_event_id, calibration_audit_id, target_account_id, gap_per_pair, pair_count,
      total_amount, reason, created_at, reversal_of
    ) values (${event.id}, ${audit.id}, ${sponsor.id}, ${Math.abs(amount)}, 1, ${Math.abs(amount)},
      'fixture adjustment', ${new Date(Date.UTC(2026, 0, day)).toISOString()}, ${reversalOf ?? null}) returning id
  `;
  await sql`insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
    values (${row.id}, ${settlementId}, ${worker.id}, ${amount})`;
  return row.id;
}
