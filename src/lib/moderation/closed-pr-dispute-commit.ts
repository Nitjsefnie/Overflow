import type { TransactionClient } from "@/lib/db/types";
import { PostgresSponsorCredentialStore } from "@/lib/fold/sponsor-credential-store";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubGraphqlRequestError } from "@/lib/github/errors";

export type CommitAuthorResult =
  | { kind: "ok"; accountId: string }
  | { kind: "unresolved_commit_author" }
  | { kind: "unlinked_commit_author" };

export async function resolveLandedCommitAuthor(sql: TransactionClient, value: string): Promise<CommitAuthorResult> {
  const unresolved = { kind: "unresolved_commit_author" } as const;
  let url: URL;
  try { url = new URL(value); } catch { return unresolved; }
  if (url.username !== "" || url.password !== "" || url.protocol !== "https:") return unresolved;
  const github = url.origin === "https://github.com";
  const match = github
    ? /^\/([^/]+\/[^/]+)\/commit\/([a-f0-9]{7,40})\/?$/i.exec(url.pathname)
    : /^\/(.+)\/-\/commit\/([a-f0-9]{7,40})\/?$/i.exec(url.pathname);
  if (match === null) return unresolved;
  const [repository] = await sql<{ owner_name: string; sponsor_id: string }[]>`
    select owner_name, sponsor_id from registered_repositories
    where provider = ${github ? "github" : "gitlab"}
      and ((${github} and lower(owner_name) = ${match[1].toLowerCase()})
        or (${!github} and owner_name = ${match[1]} and instance_url = ${url.origin}))
  `;
  if (repository === undefined) return unresolved;
  // GitLab's commit API supplies name/email, not an authoritative forge user id.
  if (!github) return unresolved;
  const token = await new PostgresSponsorCredentialStore(sql,
    process.env.TOKEN_ENCRYPTION_KEY, process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
  ).getGitHubAccessToken(repository.sponsor_id);
  if (token === null) return unresolved;
  const [owner, name] = repository.owner_name.split("/");
  const forgeId = await new GitHubGateway({ accessToken: token, owner: repository.sponsor_id })
    .getCommitAuthor({ owner, name }, match[2]).catch((error: unknown) => {
      if (error instanceof GitHubGraphqlRequestError && error.status === 200 && !error.rateLimited
        && /^GitHub GraphQL request failed\. NOT_FOUND: Could not resolve to a (Repository|Commit)\b[^;]*$/.test(error.message)) {
        return null;
      }
      throw error;
    });
  if (forgeId === null) return unresolved;
  // Match the fold and forge-person procedure's GitHub numeric identity mapping.
  const [account] = await sql<{ id: string }[]>`select id from users where github_user_id = ${forgeId}`;
  return account === undefined ? { kind: "unlinked_commit_author" } : { kind: "ok", accountId: account.id };
}
