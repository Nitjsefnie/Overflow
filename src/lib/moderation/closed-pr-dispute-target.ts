import { createHash } from "node:crypto";
import { z } from "zod";
import type { PullRequestState, TransactionClient } from "@/lib/db/types";
import { PostgresSponsorCredentialStore } from "@/lib/fold/sponsor-credential-store";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { GitHubGraphqlRequestError } from "@/lib/github/errors";
import { GitHubGateway } from "@/lib/github/client";
import { GitLabApiError } from "@/lib/gitlab/api-error";
import { GitLabGateway } from "@/lib/gitlab/client";
import type { GitHubPullRequest } from "@/lib/github/types";
import type { ClosedPrDisputeFilingInput, ClosedPrDisputeStoreResult } from "@/lib/moderation/closed-pr-dispute-service";

type Repository = { id: string; owner_name: string; provider: string; instance_url: string | null; sponsor_id: string; github_repository_id: string | number };
export type DisputeTarget = { id: string; author_id: string | null; issue_id: string | null; repository_id: string; state: PullRequestState } & Pick<Repository, "owner_name" | "provider" | "instance_url">;
type Target = { pullRequest: DisputeTarget; declaredLandingId: string | null };

type PullRequestUrl = { provider: string; origin: string; ownerName: string; number: number };
function parsePullRequestUrl(value: string): PullRequestUrl | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const github = url.origin === 'https://github.com';
  const match = (github ? /^\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/i : /^\/(.+)\/-\/merge_requests\/([1-9][0-9]*)\/?$/).exec(url.pathname);
  if (match === null) return null;
  const number = Number(match[2]);
  if (!Number.isSafeInteger(number) || number > 2_147_483_647) return null;
  return { provider: github ? 'github' : 'gitlab', origin: url.origin, ownerName: match[1], number };
}

export function landedPullRequestNumber(value: string, repository: Pick<Repository, 'provider' | 'owner_name' | 'instance_url'>): number | null {
  const parsed = parsePullRequestUrl(value);
  if (parsed === null || parsed.provider !== repository.provider
    || parsed.origin !== (repository.provider === 'github' ? 'https://github.com' : repository.instance_url)
    || (repository.provider === 'github' ? parsed.ownerName.toLowerCase() !== repository.owner_name.toLowerCase()
      : parsed.ownerName !== repository.owner_name)) return null;
  return parsed.number;
}

export async function resolveDisputeTarget(
  sql: TransactionClient, input: ClosedPrDisputeFilingInput & { accountId: string },
): Promise<ClosedPrDisputeStoreResult<Target>> {
  let repository: Repository | undefined;
  let number: number | undefined;
  if ((input.pullRequestUrl === undefined) === (input.pullRequestId === undefined)) return { kind: 'invalid_input' };
  if (input.pullRequestUrl !== undefined) {
    const parsed = parsePullRequestUrl(input.pullRequestUrl);
    if (parsed === null) return { kind: 'invalid_input' };
    [repository] = await sql<Repository[]>`select id, owner_name, provider, instance_url, sponsor_id, github_repository_id
      from registered_repositories where provider = ${parsed.provider}
      and ((${parsed.provider === 'github'} and lower(owner_name) = ${parsed.ownerName.toLowerCase()})
        or (${parsed.provider === 'gitlab'} and owner_name = ${parsed.ownerName} and instance_url = ${parsed.origin}))`;
    if (repository === undefined) return { kind: 'repository_not_registered' };
    number = parsed.number;
  } else if (!z.string().uuid().safeParse(input.pullRequestId).success) return { kind: 'invalid_input' };

  const [recorded] = await sql<DisputeTarget[]>`
    select pr.id, pr.author_id, pr.issue_id, pr.repository_id, pr.state,
      repositories.owner_name, repositories.provider, repositories.instance_url, repositories.sponsor_id,
      repositories.github_repository_id
    from pull_requests pr join registered_repositories repositories on repositories.id = pr.repository_id
    where ${input.pullRequestId !== undefined} and pr.id = ${input.pullRequestId ?? null}::uuid
      or (${input.pullRequestUrl !== undefined} and pr.repository_id = ${repository?.id ?? null}::uuid and pr.pull_request_number = ${number ?? null})
    for update of pr
  `;
  if (recorded !== undefined) return { kind: 'ok', value: { pullRequest: recorded, declaredLandingId: null } };
  if (repository === undefined || number === undefined) return { kind: 'pull_request_not_found' };

  const fetched = await fetchPullRequest(sql, repository, number);
  if (fetched === null) return { kind: 'unresolved_pull_request' };
  const { pr, diff } = fetched;
  if (pr.state === 'MERGED' || pr.mergedAt !== null || pr.mergeCommitOid !== null) return { kind: 'pull_request_merged' };
  if (pr.state !== 'CLOSED') return { kind: 'pull_request_not_closed' };
  // Match forge-person and the fold: GitHub uses users; GitLab uses the provider/instance/id triple.
  const [author] = repository.provider === 'github'
    ? await sql<{ id: string }[]>`select id from users where github_user_id = ${pr.authorGitHubUserId}`
    : await sql<{ id: string }[]>`select user_id as id from user_forge_identities
        where provider = 'gitlab' and instance_url = ${repository.instance_url} and forge_user_id = ${pr.authorGitHubUserId}`;
  if (author === undefined) return { kind: 'unlinked_pull_request_author' };
  if (author.id !== input.accountId) return { kind: 'not_pull_request_author' };
  if (input.landedPullRequestUrl !== undefined && input.landedCommitUrl !== undefined) return { kind: 'conflicting_landing_evidence' };
  if (input.landedCommitUrl !== undefined) return { kind: 'commit_landing_without_issue' };
  if (input.landedPullRequestUrl === undefined) return { kind: 'landing_required' };
  const landingNumber = landedPullRequestNumber(input.landedPullRequestUrl, repository);
  if (landingNumber === null) return { kind: URL.canParse(input.landedPullRequestUrl) ? 'landing_not_recorded' : 'invalid_input' };
  const [landing] = await sql<{ id: string; issue_id: string | null }[]>`select id, issue_id from pull_requests
    where repository_id = ${repository.id} and pull_request_number = ${landingNumber} and state = 'MERGED'`;
  if (landing === undefined) return { kind: 'landing_not_recorded' };
  if (landing.issue_id === null) return { kind: 'landing_issue_missing' };
  const [credited] = await sql`select id from closed_pr_dispute_requests where issue_id = ${landing.issue_id} and decision = 'GRANTED' limit 1`;
  if (credited !== undefined) return { kind: 'issue_already_credited' };

  const [row] = await sql<{ id: string }[]>`insert into pull_requests
    (github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, author_github_login, author_github_user_id, state, proof_sha256)
    values (${pr.id}, ${repository.id}, ${landing.issue_id}, ${number}, ${pr.url}, ${pr.title}, ${pr.body},
      ${author.id}, ${pr.authorLogin}, ${pr.authorGitHubUserId}, 'CLOSED', ${createHash('sha256').update(await diff()).digest('hex')}) returning id`;
  if (row === undefined) throw new Error('Closed PR insert returned no row.');
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${row.id}, ${landing.issue_id}, ${repository.id})`;
  return { kind: 'ok', value: { pullRequest: { ...repository, id: row.id, repository_id: repository.id,
    author_id: author.id, issue_id: landing.issue_id, state: 'CLOSED' }, declaredLandingId: landing.id } };
}

async function fetchPullRequest(sql: TransactionClient, repository: Repository, number: number): Promise<{
  pr: GitHubPullRequest; diff: () => Promise<string>;
} | null> {
  const slash = repository.owner_name.lastIndexOf('/');
  const reference = { owner: repository.owner_name.slice(0, slash), name: repository.owner_name.slice(slash + 1) };
  const credential = repository.provider === 'github'
    ? await new PostgresSponsorCredentialStore(sql, process.env.TOKEN_ENCRYPTION_KEY, process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS).getGitHubAccessToken(repository.sponsor_id)
    : (await new PostgresForgeIdentityStore(sql).getForgeToken(repository.sponsor_id, repository.instance_url!))?.token;
  if (!credential) throw new Error('Forge credential is unavailable for the pull request lookup.');
  const gateway = repository.provider === 'github'
    ? new GitHubGateway({ accessToken: credential, owner: repository.sponsor_id })
    : new GitLabGateway({ token: credential, instanceUrl: repository.instance_url! });
  const pr = await gateway.getPullRequest(reference, number).catch((error: unknown) => {
    if (error instanceof GitLabApiError && error.status === 404) return null;
    if (error instanceof GitHubGraphqlRequestError && error.status === 200 && !error.rateLimited
      && /^GitHub GraphQL request failed\. NOT_FOUND: Could not resolve to a (Repository|PullRequest)\b[^;]*$/.test(error.message)) return null;
    throw error;
  });
  if (pr === null) return null;
  if (pr.number !== number || pr.repositoryGitHubId !== Number(repository.github_repository_id)) {
    throw new Error('Forge returned a pull request from a different repository or number.');
  }
  return { pr, diff: () => gateway.getPullRequestDiff(reference, number) };
}
