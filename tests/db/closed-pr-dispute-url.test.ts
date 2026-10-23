import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { closeSql, getSql } from "@/lib/db/client";
import { exportAccount } from "@/lib/accounts/export";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { GitHubApiError, GitHubGraphqlRequestError } from "@/lib/github/errors";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository } from "@/lib/fold/reconcile";
import { GitLabApiError } from "@/lib/gitlab/api-error";
import { GitLabGateway } from "@/lib/gitlab/client";
import { PostgresSponsorCredentialStore } from "@/lib/fold/sponsor-credential-store";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { ClosedPrDisputeService } from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { verifiedRepositoryAt } from "../support/verified-repository";

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
  it("refuses an already credited landing issue before persisting an unrecorded PR", async () => {
    const f = await fixture();
    const [other] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login)
      values (${sequence++}, 'prior-contributor') returning id`;
    const [priorPr] = await sql<{ id: string }[]>`insert into pull_requests
      (github_pull_request_id, repository_id, issue_id, pull_request_number, title, body, url, author_id, state)
      values (${sequence++}, ${f.repositoryId}, ${f.issueId}, 43, 'Prior contribution', '',
        ${f.url.replace('/41', '/43')}, ${other.id}, 'CLOSED') returning id`;
    await sql`insert into closed_pr_dispute_requests
      (contributor_id, pull_request_id, issue_id, landed_pull_request_id, request_reason,
       state, decision, decided_by, decided_reason, decided_at, moderator_figure, awarded_points)
      values (${other.id}, ${priorPr.id}, ${f.issueId}, ${f.landingId}, 'Prior claim',
        'DECIDED', 'GRANTED', ${other.id}, 'Prior grant', now(), 1, 0)`;
    await expect(service().fileDispute({ id: f.accountId }, filing(f))).rejects.toMatchObject({
      code: 'CONFLICT', message: 'this issue has already been credited through a granted dispute',
    });
    await absent(f);
    expect(await sql`select * from pull_request_issues where repository_id = ${f.repositoryId}`).toEqual([]);
  });

  it.each([
    { provider: 'github', kind: 'healthy', cached: false, leg: 'reviews' },
    { provider: 'github', kind: '404', cached: false, leg: 'reviews' },
    { provider: 'gitlab', kind: '404', cached: false, leg: 'reviews' },
    { provider: 'gitlab', kind: '404', cached: true, leg: 'reviews' },
    { provider: 'gitlab', kind: '404', cached: true, leg: 'diff' },
    { provider: 'github', kind: '404', cached: true, leg: 'reviews' },
    { provider: 'github', kind: '404', cached: true, leg: 'diff' },
    { provider: 'github', kind: 'repository', cached: true, leg: 'reviews' },
    { provider: 'github', kind: 'pull request', cached: true, leg: 'reviews' },
    { provider: 'gitlab', kind: 'server', cached: true, leg: 'reviews' },
    { provider: 'github', kind: 'server', cached: true, leg: 'reviews' },
    { provider: 'github', kind: 'transport', cached: true, leg: 'reviews' },
    { provider: 'github', kind: 'rate limit', cached: true, leg: 'reviews' },
    { provider: 'gitlab', kind: 'closing 404', cached: false, leg: 'reviews' },
  ])("collects dispute evidence and preserves sweep failure semantics ($provider/$kind, cached=$cached, $leg)", async ({ provider, kind, cached, leg }) => {
    const available = kind === 'healthy';
    const fatal = ['server', 'transport', 'rate limit', 'closing 404'].includes(kind);
    const f = await fixture(provider);
    if (provider === 'gitlab') {
      await sql`insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, verified_at)
        values (${f.accountId}, 'gitlab', ${f.origin}, ${f.forgeId}, 'author', now())`;
      vi.spyOn(GitLabGateway.prototype, 'getPullRequest').mockResolvedValue({ ...f.pr, sourceSha: null, squashCommitSha: null });
      vi.spyOn(GitLabGateway.prototype, 'getPullRequestDiff').mockResolvedValue(f.rawDiff);
    }
    const request = await service().fileDispute({ id: f.accountId }, filing(f));
    const evidence = () => sql`select payload from repository_reconciliation_evidence_facts
      where repository_id = ${f.repositoryId} and kind = 'pull_request' and subject_key = ${String(f.pr.id)}`;
    expect(await evidence()).toEqual([]);
    const [storedIssue] = await sql`select github_issue_id from issues where id = ${f.issueId}`;
    const [storedLanding] = await sql`select github_pull_request_id from pull_requests where id = ${f.landingId}`;
    const landing: GitHubPullRequest = { ...f.pr, id: Number(storedLanding.github_pull_request_id), number: 42,
      url: f.landingUrl, state: 'MERGED', mergedAt: '2026-09-01T12:00:00Z',
      mergeCommitOid: 'a'.repeat(40), finalCommitAt: '2026-09-01T11:00:00Z' };
    const issue: GitHubIssue = { id: Number(storedIssue.github_issue_id), number: 1, title: 'Landing issue', body: '',
      url: `https://github.com/${f.ownerName}/issues/1`, state: 'OPEN', stateReason: null,
      updatedAt: '2026-09-01T12:05:00Z', createdAt: '2026-08-30T09:00:00Z', closedAt: null,
      authorLogin: f.pr.authorLogin, authorGitHubUserId: f.forgeId, claimAssigneeGitHubLogin: null,
      claimAssigneeGitHubUserId: null, labels: ['M'], comments: [],
      history: [{ kind: 'LABELED', id: 'opening', actorLogin: f.pr.authorLogin,
        actorGitHubUserId: f.forgeId, label: 'M', createdAt: '2026-08-30T10:00:00Z' }],
      closingPullRequests: [landing] };
    const reviews = [{ id: 901, state: 'CHANGES_REQUESTED' as const, submittedAt: '2026-09-01T10:00:00Z', dismissal: null }];
    let rawDiff = f.rawDiff;
    let failing = !available && !cached;
    const fail = () => {
      if (kind === 'transport') throw new Error('GitHub request failed: fixture');
      if (['repository', 'pull request', 'rate limit'].includes(kind)) throw new GitHubGraphqlRequestError(
        `GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a ${kind === 'pull request' ? 'PullRequest' : 'Repository'} with the name 'fixture'.`,
        kind === 'rate limit', kind === 'rate limit' ? 120 : null, 200,
      );
      if (provider === 'gitlab') throw new GitLabApiError(kind === 'server' ? 503 : 404);
      throw new GitHubApiError(kind === 'server' ? 503 : 404);
    };
    const targetNumber = kind === 'closing 404' ? 42 : 41;
    const readReviews = vi.fn(async (_repo: unknown, number: number) => {
      if (number === targetNumber && failing && leg === 'reviews') fail();
      return number === 41 ? reviews : [];
    });
    const gateway = {
      getRepositoryById: verifiedRepositoryAt(f.ownerName), listIssues: async () => [issue],
      getIssue: async () => null, getPullRequestClosingIssues: async () => [],
      getPullRequestReviews: readReviews, getPullRequestDiff: async (_repo: unknown, number: number) => {
        if (number === targetNumber && failing && leg === 'diff') fail();
        return number === 41 ? rawDiff : 'landing diff';
      },
    };
    const foldStore = new PostgresFoldStore(sql);
    vi.spyOn(foldStore, 'getGitHubAccessToken').mockResolvedValue('test-auth');
    const sweep = async (partial = false) => {
      await foldStore.withRepositoryReconciliation(f.repositoryId, () => foldStore.setReconciliationCooldown(f.repositoryId, null));
      return reconcileRepository({ store: foldStore, github: partial ? { ...gateway, listIssues: async () => [] } : gateway },
        f.repositoryId, { reason: partial ? 'WEBHOOK' : 'SWEEP' });
    };
    if (cached) expect(await sweep()).toMatchObject({ skipped: false });
    const priorFacts = cached ? await evidence() : [];
    if (cached) expect(priorFacts).toHaveLength(1);
    if (cached) failing = true;
    if (fatal) {
      readReviews.mockClear();
      await expect(sweep(cached)).rejects.toMatchObject({ message: 'Unable to reconcile repository.',
        ...(kind === 'rate limit' ? { rateLimited: true, retryAfterSeconds: 120, notBefore: expect.any(Date) } : {}),
      });
      expect(readReviews.mock.calls.filter(call => call[1] === targetNumber))
        .toHaveLength(provider === 'github' && ['server', 'transport'].includes(kind) ? 3 : 1);
      expect(await evidence()).toEqual(priorFacts);
      return;
    }
    expect(await sweep(cached)).toMatchObject({ skipped: false });
    const [moderator] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login, role)
      values (${sequence++}, 'grant-moderator', 'MODERATOR') returning id`;
    const decision = { requestId: request.id, moderatorAccountId: moderator.id,
      decision: 'GRANTED' as const, figure: 6, decidedReason: 'Original work landed.' };
    if (!available) {
      expect(await evidence()).toEqual([]);
      expect(await sql`select payload from repository_reconciliation_evidence_facts
        where repository_id = ${f.repositoryId} and kind = 'pull_request' and subject_key = ${String(landing.id)}`)
        .toEqual([expect.objectContaining({ payload: expect.objectContaining({ rawDiff: 'landing diff' }) })]);
      expect((await service().listDisputes()).find(row => row.id === request.id)?.comparison?.closedPullRequest)
        .toMatchObject({ number: 41, title: f.pr.title, reviews: null, rawDiff: null });
      expect(await new PostgresClosedPrDisputeStore(sql).decideDispute(decision)).toEqual({ kind: 'insufficient_evidence' });
      return;
    }
    expect(await evidence()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reviews, rawDiff }) })]);
    expect((await service().listDisputes()).find(row => row.id === request.id)?.comparison?.closedPullRequest)
      .toMatchObject({ number: 41, reviews, rawDiff });
    expect(readReviews.mock.calls.map(call => call[1]).sort()).toEqual([41, 42]);
    readReviews.mockClear();
    reviews.push({ ...reviews[0], id: 902, submittedAt: '2026-09-02T10:00:00Z' });
    rawDiff = 'updated disputed diff';
    expect(await sweep(true)).toMatchObject({ skipped: false });
    expect(readReviews.mock.calls.map(call => call[1])).toEqual([41]);
    expect(await evidence()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reviews, rawDiff }) })]);
    expect(await new PostgresClosedPrDisputeStore(sql).decideDispute(decision))
      .toMatchObject({ kind: 'ok', value: { decision: 'GRANTED', awardedPoints: 4 } });
    // A decided request and a closing reference share one refresh; removing the reference still retains it.
    issue.closingPullRequests.push(f.pr);
    readReviews.mockClear();
    expect(await sweep()).toMatchObject({ skipped: false });
    expect(readReviews.mock.calls.map(call => call[1]).sort()).toEqual([41, 42]);
    issue.closingPullRequests = [landing];
    expect(await sweep()).toMatchObject({ skipped: false });
    expect(await evidence()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ reviews, rawDiff }) })]);
  });

  it("refuses an unrecorded PR after sponsor unregistration before fetching the forge", async () => {
    const f = await fixture();
    await sql`update registered_repositories set active = false, unregistered_at = now() where id = ${f.repositoryId}`;
    const forgeFetch = vi.fn(fetch);
    vi.stubGlobal("fetch", forgeFetch);
    await expect(service().fileDispute({ id: f.accountId }, filing(f))).rejects.toMatchObject({
      code: "CONFLICT", message: "The pull request repository is not registered with Overflow.",
    });
    expect(forgeFetch).not.toHaveBeenCalled();
    await absent(f);
    expect(await sql`select * from pull_request_issues where repository_id = ${f.repositoryId}`).toEqual([]);
  });

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

  it.each([true, false])("persists an unreferenced closed PR while registration stands, including moderation inactivity (active=%s)", async (active) => {
    const f = await fixture();
    await sql`update registered_repositories set active = ${active} where id = ${f.repositoryId}`;
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
  it.each([
    { identifier: "url", unregistered: false }, { identifier: "uuid", unregistered: false },
    { identifier: "url", unregistered: true }, { identifier: "uuid", unregistered: true },
  ])("keeps recorded PR filing and automatic landing unchanged ($identifier, unregistered=$unregistered)", async ({ identifier, unregistered }) => {
    const f = await fixture();
    if (unregistered) await sql`update registered_repositories set active = false, unregistered_at = now() where id = ${f.repositoryId}`;
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
    ['missing landing', 'A landed pull request URL is required for an unrecorded pull request.'],
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
