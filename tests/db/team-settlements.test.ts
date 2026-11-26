import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimForgeIdentity, claimGitHubIdentity, reResolveIdentityClaims } from "@/lib/fold/identity-claims";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository } from "@/lib/fold/reconcile";
import type { FoldResult, FoldSettlement } from "@/lib/fold/repository-fold";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import { PostgresTeamStore } from "@/lib/teams/store";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";
import { balancesOf } from "../support/team-fixtures";
import { verifiedRepositoryAt } from "../support/verified-repository";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 17_195_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
const mergedAt = "2026-09-01T12:00:00Z";
const INSTANCE = "https://gitlab.team.example";

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "team_settlements", user: "team_settlements" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

type Account = { id: string; githubId: number; login: string };
type Repository = { id: string; ownerName: string; githubId: number; sponsor: Account };

async function account(): Promise<Account> {
  const githubId = externalId++;
  const login = `teamwork-${githubId}`;
  const [row] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login) values (${githubId}, ${login}) returning id`;
  return { id: row.id, githubId, login };
}

async function repository(sponsor: Account, provider: "github" | "gitlab" = "github"): Promise<Repository> {
  const githubId = externalId++;
  const ownerName = `team-owner/repo-${githubId}`;
  const [row] = await sql<{ id: string }[]>`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, provider, instance_url, forge_project_id)
    values (${githubId}, ${ownerName}, ${sponsor.id}, 'PUBLIC', ${githubId}, ${sql.json(validDifficultyScheme())}, ${provider},
      ${provider === "gitlab" ? INSTANCE : null}, ${provider === "gitlab" ? githubId : null}) returning id`;
  return { id: row.id, ownerName, githubId, sponsor };
}

/** A team led by `lead` since January, with each member's membership history written as given. */
async function team(lead: Account, ...members: [Account, string, string?][]): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into teams (lead_id, name, created_at)
    values (${lead.id}, ${`team ${externalId++}`}, '2026-01-01T00:00:00Z') returning id`;
  for (const [member, joinedAt, leftAt] of [[lead, "2026-01-01T00:00:00Z"], ...members] as [Account, string, string?][]) {
    await sql`insert into team_memberships (team_id, user_id, joined_at, left_at) values (${row.id}, ${member.id}, ${joinedAt}, ${leftAt ?? null})`;
  }
  return row.id;
}

function pullRequest(repo: Repository, author: { login: string; githubId: number }): GitHubPullRequest {
  const id = externalId++;
  return { id, number: id, title: "Team work", body: "", url: `https://github.com/${repo.ownerName}/pull/${id}`, state: "MERGED",
    mergedAt, mergeCommitOid: "a".repeat(40), finalCommitAt: "2026-09-01T11:00:00Z", authorLogin: author.login,
    authorGitHubUserId: author.githubId, repositoryGitHubId: repo.githubId, repositoryNameWithOwner: repo.ownerName };
}

/** A closed issue the sponsor priced at delivered/6, closed by `pr`. */
function closedIssue(repo: Repository, pr: GitHubPullRequest): GitHubIssue {
  const id = externalId++;
  const sponsor = { actorLogin: repo.sponsor.login, actorGitHubUserId: repo.sponsor.githubId };
  return { id, number: id, title: "Sponsored work", body: "", url: `https://github.com/${repo.ownerName}/issues/${id}`, state: "CLOSED",
    stateReason: "COMPLETED", updatedAt: "2026-09-01T12:05:00Z", createdAt: "2026-08-30T09:00:00Z", closedAt: "2026-09-01T12:05:00Z",
    authorLogin: repo.sponsor.login, authorGitHubUserId: repo.sponsor.githubId, claimAssigneeGitHubLogin: null,
    claimAssigneeGitHubUserId: null, labels: ["M", "delivered/6"], closingPullRequests: [pr],
    history: [
      { kind: "LABELED", id: `opening-${id}`, ...sponsor, label: "M", createdAt: "2026-08-30T10:00:00Z" },
      { kind: "LABELED", id: `actual-${id}`, ...sponsor, label: "delivered/6", createdAt: "2026-09-01T11:30:00Z" },
    ],
    comments: [{ id: `rationale-${id}`, databaseId: id, authorLogin: repo.sponsor.login, authorGitHubUserId: repo.sponsor.githubId,
      body: "Settled after reading the diff.", createdAt: "2026-09-01T11:40:00Z", lastEditedAt: null }] };
}

/** One real reconciliation of `repo` from `issues`, each pull request in `reviewed` carrying one review round. */
async function reconcile(repo: Repository, issues: GitHubIssue[], reviewed: GitHubPullRequest[] = []): Promise<void> {
  const store = new PostgresFoldStore(sql);
  vi.spyOn(store, "getGitHubAccessToken").mockResolvedValue("test-auth");
  await store.withRepositoryReconciliation(repo.id, () => store.setReconciliationCooldown(repo.id, null));
  const reviewedNumbers = new Set(reviewed.map((pr) => pr.number));
  const github = {
    getRepositoryById: verifiedRepositoryAt(repo.ownerName), listIssues: async () => issues, getIssue: async () => null,
    getPullRequestClosingIssues: async () => [], getPullRequestDiff: async (_repo: unknown, number: number) => `diff ${number}`,
    getPullRequestReviews: async (_repo: unknown, number: number) => reviewedNumbers.has(number)
      ? [{ id: number, state: "CHANGES_REQUESTED" as const, submittedAt: "2026-09-01T10:00:00Z", dismissal: null }] : [],
  };
  expect(await reconcileRepository({ store, github }, repo.id, { reason: "SWEEP" })).toMatchObject({ skipped: false });
}

async function settlementOf(pr: { id: number }) {
  const [row] = await sql<{ id: string; issue_id: string; pull_request_id: string; status: string; creditor_id: string | null;
    team_id: string | null; credits: number }[]>`
    select settlements.id, settlements.issue_id, settlements.pull_request_id, settlements.status::text as status,
      settlements.creditor_id, settlements.team_id, settlements.credits
    from settlements join pull_requests on pull_requests.id = settlements.pull_request_id
    where pull_requests.github_pull_request_id = ${pr.id}`;
  return row;
}

async function calibrationUsersOf(pr: { id: number }) {
  return (await sql<{ user_id: string }[]>`select self_work_calibrations.user_id from self_work_calibrations
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    where pull_requests.github_pull_request_id = ${pr.id}`).map((row) => row.user_id);
}

describe("a reconciled settlement of a team member's merged closing pull request", () => {
  it("credits the merge-time team, and every other author as today, through overrides, distributions and disputes", async () => {
    const [sponsor, lead, member, joinedLater, departed, outsider, moderator] = await Promise.all(Array.from({ length: 7 }, account));
    const teamId = await team(lead, [member, "2026-08-01T00:00:00Z"], [joinedLater, "2026-09-02T00:00:00Z"],
      [departed, "2026-07-01T00:00:00Z", "2026-08-15T00:00:00Z"]);
    const repo = await repository(sponsor);
    const prs = [member, joinedLater, departed, outsider].map((author) => pullRequest(repo, author));
    const issues = prs.map((pr) => closedIssue(repo, pr));
    await reconcile(repo, issues, [prs[0]!]);

    expect(await Promise.all(prs.map(settlementOf))).toEqual([
      expect.objectContaining({ status: "SETTLED", creditor_id: member.id, team_id: teamId, credits: 5 }),
      expect.objectContaining({ status: "SETTLED", creditor_id: joinedLater.id, team_id: null, credits: 6 }),
      expect.objectContaining({ status: "SETTLED", creditor_id: departed.id, team_id: null, credits: 6 }),
      expect.objectContaining({ status: "SETTLED", creditor_id: outsider.id, team_id: null, credits: 6 }),
    ]);
    expect(await balancesOf(sql, teamId, member.id, joinedLater.id, departed.id, outsider.id, sponsor.id))
      .toEqual([5, 0, 6, 6, 6, -23]);

    // An unchanged team settlement records no change; a team change alone is one, restored and recorded.
    const teamSettlement = (await settlementOf(prs[0]!))!;
    const changes = () => sql`select before_state->'teamId' as before, after_state->>'teamId' as after from reconciliation_changes
      where pull_request_id = ${teamSettlement.pull_request_id} and change_kind = 'CHANGE'`;
    await reconcile(repo, issues, [prs[0]!]);
    expect(await changes()).toEqual([]);
    await sql`update settlements set team_id = null where id = ${teamSettlement.id}`;
    await reconcile(repo, issues, [prs[0]!]);
    expect(await settlementOf(prs[0]!)).toMatchObject({ team_id: teamId, credits: 5 });
    expect(await changes()).toEqual([{ before: null, after: teamId }]);

    // A moderator's correction changes the credits, never the merge-time team.
    const overrides = new PostgresSettlementOverrideStore(sql);
    const request = await overrides.createRequest({ requesterId: member.id, target: { kind: "settlement", settlementId: teamSettlement.id },
      reason: "Delivered less than labelled." });
    if (request.kind !== "ok") throw new Error(`override refused: ${request.kind}`);
    await overrides.decideRequest({ actorId: moderator.id, requestId: request.value.id, decision: "GRANT", settledPoints: 3, reason: "Three." });
    await reconcile(repo, issues, [prs[0]!]);
    expect(await settlementOf(prs[0]!)).toMatchObject({ status: "SETTLED", team_id: teamId, credits: 2 });
    expect(await balancesOf(sql, teamId, member.id)).toEqual([2, 0]);

    // Distributed points stay with the member when a granted dispute then reverses the team's landing.
    expect(await new PostgresTeamStore(sql).distributeTeamPoints(lead.id, member.id, 2)).toMatchObject({ kind: "ok" });
    const [closed] = await sql<{ id: string }[]>`insert into pull_requests (github_pull_request_id, repository_id, issue_id,
      pull_request_number, url, title, body, author_id, state) values (${externalId}, ${repo.id}, ${teamSettlement.issue_id}, ${externalId++},
      'https://example.test/closed', 'original', '', ${outsider.id}, 'CLOSED') returning id`;
    await sql`insert into closed_pr_dispute_requests (contributor_id, pull_request_id, issue_id, landed_pull_request_id, request_reason,
      state, decision, decided_by, decided_reason, decided_at, moderator_figure, awarded_points)
      values (${outsider.id}, ${closed.id}, ${teamSettlement.issue_id}, ${teamSettlement.pull_request_id}, 'My work landed.',
        'DECIDED', 'GRANTED', ${moderator.id}, 'Copied.', '2026-10-01T00:00:00Z', 6, 6)`;
    expect(await balancesOf(sql, teamId, member.id)).toEqual([-2, 2]);
  });

  it("settles as self-work in a teammate's repository, and to the team in any other sponsor's", async () => {
    const [lead, author, teammate, otherTeamLead, otherTeamSponsor, formerTeammate] = await Promise.all(Array.from({ length: 6 }, account));
    const teamId = await team(lead, [author, "2026-08-01T00:00:00Z"], [teammate, "2026-07-01T00:00:00Z"],
      [formerTeammate, "2026-07-01T00:00:00Z", "2026-08-31T00:00:00Z"]);
    await team(otherTeamLead, [otherTeamSponsor, "2026-07-01T00:00:00Z"]);
    const [own, other, former] = [await repository(teammate), await repository(otherTeamSponsor), await repository(formerTeammate)];
    const [ownPr, otherPr, formerPr] = [own, other, former].map((repo) => pullRequest(repo, author));
    await reconcile(own, [closedIssue(own, ownPr!)]);
    await reconcile(other, [closedIssue(other, otherPr!)]);
    await reconcile(former, [closedIssue(former, formerPr!)]);

    expect(await settlementOf(ownPr!)).toBeUndefined();
    expect(await calibrationUsersOf(ownPr!)).toEqual([teammate.id]);
    expect(await settlementOf(otherPr!)).toMatchObject({ creditor_id: author.id, team_id: teamId, credits: 6 });
    expect(await settlementOf(formerPr!)).toMatchObject({ creditor_id: author.id, team_id: teamId, credits: 6 });
    expect(await balancesOf(sql, teamId, author.id, teammate.id)).toEqual([12, 0, 0]);
  });
});

describe("an identity claim of a team member's UNCLAIMED settlement", () => {
  it("lands the claimed GitHub work on the merge-time team, and a teammate-sponsored one as the sponsor's self-work", async () => {
    const [sponsor, lead, claimant, teammate] = await Promise.all(Array.from({ length: 4 }, account));
    const teamId = await team(lead, [claimant, "2026-08-01T00:00:00Z"], [teammate, "2026-07-01T00:00:00Z"]);
    const [repo, own] = [await repository(sponsor), await repository(teammate)];
    // GitHub reports an id no account carries yet, so both settlements fold UNCLAIMED.
    const unbound = { login: claimant.login, githubId: externalId++ };
    const [pr, ownPr] = [pullRequest(repo, unbound), pullRequest(own, unbound)];
    await reconcile(repo, [closedIssue(repo, pr)]);
    await reconcile(own, [closedIssue(own, ownPr)]);
    expect(await settlementOf(pr)).toMatchObject({ status: "UNCLAIMED", creditor_id: null, team_id: null });
    expect(await settlementOf(ownPr)).toMatchObject({ status: "UNCLAIMED", team_id: null });

    await sql`update users set github_user_id = ${unbound.githubId} where id = ${claimant.id}`;
    await claimGitHubIdentity(sql, claimant.id, unbound.githubId);
    expect(await settlementOf(pr)).toMatchObject({ status: "SETTLED", creditor_id: claimant.id, team_id: teamId, credits: 6 });
    expect(await settlementOf(ownPr)).toBeUndefined();
    expect(await calibrationUsersOf(ownPr)).toEqual([teammate.id]);
    expect(await balancesOf(sql, teamId, claimant.id)).toEqual([6, 0]);
  });

  it("re-resolves a stale fold the same way before it is published", async () => {
    const [sponsor, lead, claimant, teammate, departed, joinedLater, formerTeammate, joinedAtMerge, sponsorJoinedAtMerge,
      sponsorLeftAtMerge, sponsorJoinedLater, tied, otherLead] = await Promise.all(Array.from({ length: 13 }, account));
    // Each SQL bound has a near miss at the merge instant, for the claimant's team and for the sponsor's membership of it.
    const teamId = await team(lead, [claimant, "2026-08-01T00:00:00Z"], [teammate, "2026-07-01T00:00:00Z"],
      [departed, "2026-07-01T00:00:00Z", mergedAt], [joinedLater, "2026-09-01T12:00:01Z"],
      [formerTeammate, "2026-07-01T00:00:00Z", "2026-09-01T11:59:59Z"], [joinedAtMerge, mergedAt],
      [sponsorJoinedAtMerge, mergedAt], [sponsorLeftAtMerge, "2026-07-01T00:00:00Z", mergedAt], [sponsorJoinedLater, "2026-09-01T12:00:01Z"],
      [tied, "2026-08-10T00:00:00Z", "2026-09-02T00:00:00Z"]);
    // Two rows joined at one instant both cover the merge: the greater team id decides, as in the fold.
    const otherTeamId = await team(otherLead, [tied, "2026-08-10T00:00:00Z"]);
    const unclaimed = (githubIssueId: number, debtorId: string, author = claimant): FoldSettlement => ({
      githubIssueId, githubPullRequestId: githubIssueId + 1, provider: "github", instanceUrl: null, creditorId: null,
      creditorGitHubLogin: author.login, creditorGitHubUserId: author.githubId, debtorId, openingComparisonPoints: 5,
      settledLabel: "delivered/6", settledPoints: 6, settledLabelEventId: "label", settledLabelActorLogin: "sponsor",
      settledLabelAppliedAt: mergedAt, settledRationaleCommentId: "comment", settledRationaleActorLogin: "sponsor",
      settledRationaleCommentedAt: mergedAt, mergeCommitOid: "a".repeat(40), mergedAt, reviewRounds: 1, credits: 5,
      proofSha256: "b".repeat(64), status: "UNCLAIMED",
    });
    const stale: FoldResult = { issues: [], pullRequests: [], selfWorkCalibrations: [], unwritableClosures: [], policyViolations: [],
      ledgerEntries: [], settlements: [unclaimed(1, sponsor.id), unclaimed(3, teammate.id), unclaimed(5, sponsor.id, departed),
        unclaimed(7, sponsor.id, joinedLater), unclaimed(9, formerTeammate.id), unclaimed(11, sponsor.id, joinedAtMerge),
        unclaimed(13, sponsorJoinedAtMerge.id), unclaimed(15, sponsorLeftAtMerge.id), unclaimed(17, sponsorJoinedLater.id),
        unclaimed(19, sponsor.id, tied)] };

    const resolved = await sql.begin((transaction) => reResolveIdentityClaims(transaction, stale)) as FoldResult;
    expect(resolved.settlements).toEqual([
      { ...unclaimed(1, sponsor.id), creditorId: claimant.id, teamId, status: "SETTLED", credits: 5 },
      { ...unclaimed(5, sponsor.id, departed), creditorId: departed.id, status: "SETTLED", credits: 5 },
      { ...unclaimed(7, sponsor.id, joinedLater), creditorId: joinedLater.id, status: "SETTLED", credits: 5 },
      { ...unclaimed(9, formerTeammate.id), creditorId: claimant.id, teamId, status: "SETTLED", credits: 5 },
      { ...unclaimed(11, sponsor.id, joinedAtMerge), creditorId: joinedAtMerge.id, teamId, status: "SETTLED", credits: 5 },
      { ...unclaimed(15, sponsorLeftAtMerge.id), creditorId: claimant.id, teamId, status: "SETTLED", credits: 5 },
      { ...unclaimed(17, sponsorJoinedLater.id), creditorId: claimant.id, teamId, status: "SETTLED", credits: 5 },
      { ...unclaimed(19, sponsor.id, tied), creditorId: tied.id, teamId: [teamId, otherTeamId].sort()[1], status: "SETTLED", credits: 5 },
    ]);
    expect(resolved.selfWorkCalibrations).toEqual([
      expect.objectContaining({ githubIssueId: 3, userId: teammate.id, actualPoints: 6 }),
      expect.objectContaining({ githubIssueId: 13, userId: sponsorJoinedAtMerge.id, actualPoints: 6 }),
    ]);
  });

  it("lands a linked GitLab identity's claimed work on the team, which the fold's lookup also reads", async () => {
    const [sponsor, lead, claimant] = await Promise.all(Array.from({ length: 3 }, account));
    const teamId = await team(lead, [claimant, "2026-08-01T00:00:00Z"]);
    const repo = await repository(sponsor, "gitlab");
    const forgeUserId = externalId++;
    const [issue] = await sql<{ id: string }[]>`insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points)
      values (${externalId}, ${repo.id}, ${externalId++}, 'GitLab work', '', 'https://example.test/i', 'CLOSED', 'M', 5, 5) returning id`;
    const [mr] = await sql<{ id: string }[]>`insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number,
      url, title, body, state, merged_at) values (${externalId}, ${repo.id}, ${issue.id}, ${externalId++}, 'https://example.test/mr', 'mr', '',
      'MERGED', ${mergedAt}) returning id`;
    await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id) values (${mr.id}, ${issue.id}, ${repo.id})`;
    await sql`insert into settlements (pull_request_id, issue_id, creditor_github_login, creditor_github_user_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, provider, instance_url)
      values (${mr.id}, ${issue.id}, 'gitlabber', ${forgeUserId}, ${sponsor.id}, 5, 6, 0, 6, ${"c".repeat(64)}, 'UNCLAIMED', 'gitlab', ${INSTANCE})`;

    await claimForgeIdentity(sql, { userId: claimant.id, instanceUrl: INSTANCE, forgeUserId });
    expect(await sql`select status::text as status, creditor_id, team_id from settlements where pull_request_id = ${mr.id}`)
      .toEqual([{ status: "SETTLED", creditor_id: claimant.id, team_id: teamId }]);

    await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
      values (${claimant.id}, 'gitlab', ${INSTANCE}, ${forgeUserId}, 'gitlabber', 'v1.test.envelope', now())`;
    const [identity] = await new PostgresFoldStore(sql).findForgeIdentitiesByForgeUserIds(repo.id, [forgeUserId]);
    expect(identity?.user.teamMemberships).toEqual([{ teamId, joinedAt: "2026-08-01T00:00:00.000000Z", leftAt: null }]);
  });
});
