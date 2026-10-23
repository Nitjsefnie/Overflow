import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { closeSql, getSql } from "@/lib/db/client";
import { exportAccount } from "@/lib/accounts/export";
import type { GitHubPullRequest } from "@/lib/github/types";
import { GitLabApiError } from "@/lib/gitlab/api-error";
import { GitLabGateway } from "@/lib/gitlab/client";
import { PostgresSponsorCredentialStore } from "@/lib/fold/sponsor-credential-store";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { ClosedPrDisputeService } from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";

let sql: Sql;
let sequence = 81_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "dispute_url", user: "dispute_url" });
  process.env.DATABASE_URL = started.databaseUrl;
  execFileSync("pnpm", ["db:migrate"], { env: { ...process.env, OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD: "skip" } });
  sql = getSql();
});
afterAll(async () => {
  await closeSql();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function service() { return new ClosedPrDisputeService(new PostgresClosedPrDisputeStore(sql)); }
async function fixture(provider = "github") {
  const forgeId = sequence++;
  const [account] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login)
    values (${forgeId}, ${`author-${forgeId}`}) returning id`;
  const ownerName = `owner/repository-${sequence++}`;
  const origin = provider === "github" ? "https://github.com" : "https://gitlab.example.test";
  const [repository] = await sql<{ id: string }[]>`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, provider, instance_url)
    values (${sequence++}, ${ownerName}, ${account.id}, 'PUBLIC', ${sequence++}, ${sql.json(validDifficultyScheme())},
      ${provider}, ${provider === "github" ? null : origin}) returning id`;
  const [issue] = await sql<{ id: string }[]>`insert into issues
    (github_issue_id, repository_id, issue_number, title, body, url, state, opening_label, opening_comparison_points, opening_reserve_points)
    values (${sequence++}, ${repository.id}, 1, 'Landing issue', '', ${origin}, 'CLOSED', 'M', 5, 5) returning id`;
  const marker = provider === "github" ? "pull" : "-/merge_requests";
  const url = `${origin}/${ownerName}/${marker}/41`;
  const landingUrl = `${origin}/${ownerName}/${marker}/42`;
  const [landing] = await sql<{ id: string }[]>`insert into pull_requests
    (github_pull_request_id, repository_id, issue_id, pull_request_number, title, body, url, state)
    values (${sequence++}, ${repository.id}, ${issue.id}, 42, 'Landing', '', ${landingUrl}, 'MERGED') returning id`;
  const rawDiff = `diff --git a/change b/change\n+contribution ${sequence++}\n`;
  const pr: GitHubPullRequest = { id: sequence++, number: 41, title: 'Unreferenced change', body: 'Work', url, state: 'CLOSED',
    mergedAt: null, mergeCommitOid: null, finalCommitAt: null, authorGitHubUserId: forgeId,
    authorLogin: 'renamed-author', repositoryGitHubId: Number((await sql`select github_repository_id from registered_repositories where id = ${repository.id}`)[0].github_repository_id),
    repositoryNameWithOwner: ownerName };
  vi.spyOn(PostgresSponsorCredentialStore.prototype, "getGitHubAccessToken").mockResolvedValue("test-token");
  vi.spyOn(PostgresForgeIdentityStore.prototype, "getForgeToken").mockResolvedValue({ token: "test-token", identityId: randomUUID() });
  vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    if (request.url === 'https://api.github.com/graphql') {
      const body = await request.json();
      expect(body.variables).toEqual({ owner: 'owner', name: ownerName.split('/')[1], pullRequestNumber: 41 });
      return Response.json({ data: { repository: { pullRequest: { databaseId: pr.id, number: pr.number, title: pr.title,
        body: pr.body, url: pr.url, state: pr.state, mergedAt: pr.mergedAt, mergeCommit: null, commits: { nodes: [] },
        author: { login: pr.authorLogin, databaseId: pr.authorGitHubUserId },
        repository: { databaseId: pr.repositoryGitHubId, nameWithOwner: ownerName } } } } });
    }
    if (request.url === `https://api.github.com/repos/${ownerName}/pulls/41` && request.headers.get('accept') === 'application/vnd.github.v3.diff') {
      return new Response(rawDiff);
    }
    throw new Error(`Unexpected forge request: ${request.url}`);
  });
  return { accountId: account.id, repositoryId: repository.id, issueId: issue.id, landingId: landing.id,
    url, landingUrl, rawDiff, pr, forgeId, origin, ownerName };
}
function filing(f: Awaited<ReturnType<typeof fixture>>) {
  return { pullRequestUrl: f.url, landedPullRequestUrl: f.landingUrl, reason: "My work landed." };
}
async function absent(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await sql`select id from pull_requests where repository_id = ${f.repositoryId} and pull_request_number = 41`).toEqual([]);
  expect(await sql`select id from closed_pr_dispute_requests where contributor_id = ${f.accountId}`).toEqual([]);
  expect(await sql`select id from moderation_events where target_user_id = ${f.accountId}`).toEqual([]);
}

describe("closed PR URL filing", () => {
  it("names a missing GitLab merge request", async () => {
    const f = await fixture("gitlab");
    vi.spyOn(GitLabGateway.prototype, "getPullRequest").mockRejectedValue(new GitLabApiError(404));
    await expect(service().fileDispute({ id: f.accountId }, filing(f))).rejects.toMatchObject({
      message: "The pull request URL could not be resolved on the forge.", code: "CONFLICT",
    });
    await absent(f);
  });

  it.each(["Repository", "PullRequest"])("names a definitively missing forge %s", async (object) => {
    const f = await fixture();
    vi.stubGlobal("fetch", async () => Response.json({ data: { repository: null }, errors: [
      { type: "NOT_FOUND", message: `Could not resolve to a ${object} with the number of 41.` },
    ] }));
    await expect(service().fileDispute({ id: f.accountId }, filing(f))).rejects.toMatchObject({
      message: "The pull request URL could not be resolved on the forge.", code: "CONFLICT",
    });
    await absent(f);
  });

  it("persists an unreferenced closed PR, raw-diff proof and issue link and includes it in the account export", async () => {
    const f = await fixture();
    const request = await service().fileDispute({ id: f.accountId }, filing(f));
    expect(request).toMatchObject({ contributorId: f.accountId, issueId: f.issueId, landedPullRequestId: f.landingId, state: "OPEN" });
    const [pr] = await sql`select * from pull_requests where id = ${request.pullRequestId}`;
    expect(pr).toMatchObject({ repository_id: f.repositoryId, issue_id: f.issueId, github_pull_request_id: String(f.pr.id),
      pull_request_number: 41, url: f.url, title: 'Unreferenced change', author_id: f.accountId,
      author_github_user_id: String(f.forgeId), author_github_login: 'renamed-author', state: 'CLOSED', merged_at: null,
      proof_sha256: createHash('sha256').update(f.rawDiff).digest('hex') });
    expect(await sql`select pull_request_id, issue_id, repository_id from pull_request_issues where pull_request_id = ${pr.id}`)
      .toEqual([{ pull_request_id: pr.id, issue_id: f.issueId, repository_id: f.repositoryId }]);
    const exported = await exportAccount(sql, f.forgeId);
    expect(exported?.authoredPullRequests).toEqual(expect.arrayContaining([expect.objectContaining({ id: pr.id })]));
  });
  it.each(["url", "uuid"])("keeps recorded PR filing and automatic landing unchanged (%s)", async (identifier) => {
    const f = await fixture();
    const [pr] = await sql<{ id: string }[]>`insert into pull_requests
      (github_pull_request_id, repository_id, issue_id, pull_request_number, title, body, url, author_id, state)
      values (${f.pr.id}, ${f.repositoryId}, ${f.issueId}, 41, 'Recorded', '', ${f.url}, ${f.accountId}, 'CLOSED') returning id`;
    vi.stubGlobal("fetch", () => { throw new Error("Recorded PR must not fetch the forge"); });
    const input = identifier === "url" ? { pullRequestUrl: f.url.toUpperCase().replace('HTTPS://GITHUB.COM', 'https://github.com') + '/' } : { pullRequestId: pr.id };
    expect(await service().fileDispute({ id: f.accountId }, { ...input, reason: "My work landed." }))
      .toMatchObject({ pullRequestId: pr.id, issueId: f.issueId, landedPullRequestId: f.landingId });
  });
  it.each([
    ['unregistered repository', 'The pull request repository is not registered with Overflow.'],
    ['open PR', 'The pull request is not closed.'],
    ['merged PR', 'The pull request has already been merged.'],
    ['unlinked author', 'The pull request author has no linked Overflow account.'],
    ['different author', 'The pull request was not authored by this account.'],
    ['missing landing', 'A landed pull request URL or commit URL is required.'],
    ['commit landing', 'A commit URL cannot identify an issue for an unrecorded pull request; supply a landed pull request URL.'],
    ['missing landed PR', 'The landed pull request URL does not resolve to a recorded merged pull request.'],
    ['open landed PR', 'The landed pull request URL does not resolve to a recorded merged pull request.'],
    ['closed landed PR', 'The landed pull request URL does not resolve to a recorded merged pull request.'],
    ['landing without issue', 'The landed pull request has no recorded issue.'],
    ['both landing URLs', 'Supply only one landing evidence URL.'],
  ])("names the refusal: %s", async (cause, message) => {
    const f = await fixture();
    const input: Record<string, string> = filing(f);
    if (cause === 'unregistered repository') input.pullRequestUrl = 'https://github.com/unregistered/repo/pull/41';
    if (cause === 'open PR') f.pr.state = 'OPEN';
    if (cause === 'merged PR') f.pr.state = 'MERGED';
    if (cause === 'unlinked author') f.pr.authorGitHubUserId = sequence++;
    if (cause === 'different author') {
      const id = sequence++;
      await sql`insert into users (github_user_id, github_login) values (${id}, 'other-author')`;
      f.pr.authorGitHubUserId = id;
    }
    if (cause === 'missing landing' || cause === 'commit landing') delete input.landedPullRequestUrl;
    if (cause === 'commit landing' || cause === 'both landing URLs') input.landedCommitUrl = `https://github.com/${f.ownerName}/commit/${'a'.repeat(40)}`;
    if (cause === 'missing landed PR') input.landedPullRequestUrl = `https://github.com/${f.ownerName}/pull/99`;
    if (cause === 'open landed PR') await sql`update pull_requests set state = 'OPEN' where id = ${f.landingId}`;
    if (cause === 'closed landed PR') await sql`update pull_requests set state = 'CLOSED' where id = ${f.landingId}`;
    if (cause === 'landing without issue') await sql`update pull_requests set issue_id = null where id = ${f.landingId}`;
    await expect(service().fileDispute({ id: f.accountId }, input as ReturnType<typeof filing>)).rejects.toMatchObject({ message });
    await absent(f);
  });
  it("rolls back the PR and link when dispute insertion fails", async () => {
    const f = await fixture();
    await sql.unsafe(`create function refuse_url_dispute() returns trigger language plpgsql as $$
      begin raise exception 'test filing failure'; end $$;
      create trigger refuse_url_dispute before insert on closed_pr_dispute_requests for each row execute function refuse_url_dispute()`);
    try {
      await expect(service().fileDispute({ id: f.accountId }, filing(f))).rejects.toThrow('test filing failure');
      await absent(f);
      expect(await sql`select * from pull_request_issues where repository_id = ${f.repositoryId}`).toEqual([]);
    } finally {
      await sql.unsafe('drop trigger refuse_url_dispute on closed_pr_dispute_requests; drop function refuse_url_dispute()');
    }
  });
  it.each(['gitlab', 'other-instance', 'other-provider'])("scopes GitLab numeric authorship to provider and instance (%s)", async (identity) => {
    const f = await fixture('gitlab');
    vi.spyOn(GitLabGateway.prototype, 'getPullRequest').mockResolvedValue({ ...f.pr, sourceSha: null, squashCommitSha: null });
    vi.spyOn(GitLabGateway.prototype, 'getPullRequestDiff').mockResolvedValue(f.rawDiff);
    if (identity !== 'other-provider') await sql`insert into user_forge_identities
      (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
      values (${f.accountId}, 'gitlab', ${identity === 'gitlab' ? f.origin : 'https://elsewhere.example.test'}, ${f.forgeId}, 'author', null, now())`;
    if (identity === 'gitlab') {
      expect(await service().fileDispute({ id: f.accountId }, filing(f))).toMatchObject({ issueId: f.issueId, landedPullRequestId: f.landingId });
    } else {
      await expect(service().fileDispute({ id: f.accountId }, filing(f))).rejects.toMatchObject({ message: 'The pull request author has no linked Overflow account.' });
      await absent(f);
    }
  });
});
