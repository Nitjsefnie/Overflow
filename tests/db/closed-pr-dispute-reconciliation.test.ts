import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository } from "@/lib/fold/reconcile";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { ClosedPrDisputeService } from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";
import { verifiedRepositoryAt } from "../support/verified-repository";

let container: StartedTestContainer;
let sql: Sql;
let externalId = 83_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "dispute_producer", user: "dispute_producer" });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  execFileSync("pnpm", ["db:migrate"], { env: { ...process.env, OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD: "skip" } });
  sql = getSql();
});
afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

it.each([false, true])("reconciles closed evidence through materialization, filing and grant (supplied landing=%s)", async (supplied) => {
  const ids = [externalId++, externalId++, externalId++];
  const users = [];
  for (const id of ids) {
    const [user] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login)
      values (${id}, ${`producer-${id}`}) returning id`;
    users.push(user.id);
  }
  await sql`update users set role = 'MEMBER' where role = 'MODERATOR'`;
  await sql`update users set role = 'MODERATOR' where id = ${users[2]}`;
  const repositoryKey = externalId++;
  const ownerName = `owner/producer-${repositoryKey}`;
  const [repo] = await sql<{ id: string }[]>`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${repositoryKey}, ${ownerName}, ${users[0]}, 'PUBLIC', ${repositoryKey}, ${sql.json(validDifficultyScheme())}) returning id`;
  const landing: GitHubPullRequest = {
    id: externalId++, number: 11, title: "Landed implementation", body: "", url: `https://github.com/${ownerName}/pull/11`,
    state: "MERGED", mergedAt: "2026-09-01T12:00:00Z", mergeCommitOid: "a".repeat(40), finalCommitAt: "2026-09-01T11:00:00Z",
    authorLogin: `producer-${ids[0]}`, authorGitHubUserId: ids[0], repositoryGitHubId: repositoryKey, repositoryNameWithOwner: ownerName,
  };
  const closed: GitHubPullRequest = { ...landing, id: externalId++, number: 12, title: "Original contribution",
    url: `https://github.com/${ownerName}/pull/12`, state: "CLOSED", mergedAt: null, mergeCommitOid: null, finalCommitAt: null,
    authorLogin: `producer-${ids[1]}`, authorGitHubUserId: ids[1] };
  function issue(number: number, prs: GitHubPullRequest[]): GitHubIssue {
    return { id: externalId++, number, title: "Sponsored work", body: "", url: `https://github.com/${ownerName}/issues/${number}`,
      state: "OPEN", stateReason: null, updatedAt: "2026-09-01T12:05:00Z", createdAt: "2026-08-30T09:00:00Z", closedAt: null,
      authorLogin: `producer-${ids[0]}`, authorGitHubUserId: ids[0], claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null, labels: ["M"], comments: [],
      history: [{ kind: "LABELED", id: `opening-${number}`, actorLogin: `producer-${ids[0]}`, actorGitHubUserId: ids[0],
        label: "M", createdAt: "2026-08-30T10:00:00Z" }], closingPullRequests: prs };
  }
  const issues = supplied ? [issue(1, [closed]), issue(2, [landing])] : [issue(1, [closed, landing])];
  const foldStore = new PostgresFoldStore(sql);
  vi.spyOn(foldStore, "getGitHubAccessToken").mockResolvedValue("test-auth");
  const gateway = {
    getRepositoryById: verifiedRepositoryAt(ownerName), listIssues: async () => issues,
    getIssue: async () => null, getPullRequestClosingIssues: async () => [],
    getPullRequestReviews: async () => [{ id: 123, state: "CHANGES_REQUESTED" as const, submittedAt: "2026-09-01T10:00:00Z", dismissal: null }],
    getPullRequestDiff: async (_repo: unknown, number: number) => `diff for PR ${number}`,
  };
  expect(await reconcileRepository({ store: foldStore, github: gateway }, repo.id, { reason: "SWEEP" })).toMatchObject({ skipped: false });
  const prs = await sql<{ id: string; state: string; author_id: string; pull_request_number: number }[]>`
    select id, state, author_id, pull_request_number from pull_requests where repository_id = ${repo.id}`;
  expect(prs).toHaveLength(2);
  const source = prs.find((pr) => pr.pull_request_number === 12)!;
  expect(source).toMatchObject({ state: "CLOSED", author_id: users[1] });
  const cached = await foldStore.getReconciliationEvidence(repo.id);
  expect(cached?.pullRequests.find((pr) => pr.id === closed.id)).toMatchObject({ rawDiff: "diff for PR 12", reviews: [{ id: 123 }] });
  expect(await sql`select id from settlements where pull_request_id = ${source.id}`).toEqual([]);
  const service = new ClosedPrDisputeService(new PostgresClosedPrDisputeStore(sql));
  const request = await service.fileDispute({ id: users[1] }, { pullRequestId: source.id, reason: "Original work landed.",
    ...(supplied ? { landedPullRequestUrl: landing.url } : {}) });
  expect(request.landedPullRequestId).toBe(prs.find((pr) => pr.pull_request_number === 11)!.id);
  expect(await service.decideDispute(request.id, { id: users[2] }, { decision: "GRANTED", figure: 6, decidedReason: "Same work confirmed." }))
    .toMatchObject({ awardedPoints: 5, decision: "GRANTED" });
  const listed = (await service.listDisputes()).find((row) => row.id === request.id)!;
  expect(listed.comparison).toMatchObject({
    closedPullRequest: { number: 12, title: "Original contribution", url: closed.url, rawDiff: "diff for PR 12", reviews: [{ id: 123 }] },
    landedPullRequest: { number: 11, title: "Landed implementation", url: landing.url, rawDiff: "diff for PR 11" },
  });
  // A partial pass must keep both the cached closed candidate and its review fact.
  await foldStore.withRepositoryReconciliation(repo.id, () => foldStore.setReconciliationCooldown(repo.id, null));
  expect(await reconcileRepository({ store: foldStore, github: { ...gateway, listIssues: async () => [] } }, repo.id, { reason: "WEBHOOK" }))
    .toMatchObject({ skipped: false });
  expect((await foldStore.getReconciliationEvidence(repo.id))?.pullRequests.map((pr) => pr.id)).toContain(closed.id);
});
