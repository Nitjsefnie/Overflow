import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { validDifficultyScheme } from "./difficulty-scheme";

let externalId = 17_190_000;
const nextId = () => ++externalId;

export type FixtureAccount = { id: string; login: string; repositoryId: string; ownerName: string };

/** An account sponsoring one repository holding `openIssues` open issues. */
export async function insertAccount(sql: Sql, openIssues = 0): Promise<FixtureAccount> {
  const githubId = nextId();
  const login = `team-${githubId}`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubId}, ${login}) returning id
  `;
  const ownerName = `${login}/work`;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${githubId}, ${ownerName}, ${user.id}, 'PUBLIC', ${githubId}, ${sql.json(validDifficultyScheme())}) returning id
  `;
  for (let count = 0; count < openIssues; count += 1) await insertIssue(sql, repository.id, "OPEN");
  return { id: user.id, login, repositoryId: repository.id, ownerName };
}

export async function insertIssue(sql: Sql, repositoryId: string, state: "OPEN" | "CLOSED"): Promise<string> {
  const id = nextId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points)
    values (${id}, ${repositoryId}, ${id}, ${`issue ${id}`}, '', ${`https://example.test/issues/${id}`}, ${state}, 'M', 5, 5)
    returning id
  `;
  return issue.id;
}

export async function insertPullRequest(
  sql: Sql, author: FixtureAccount, repositoryId: string, issueId: string, state: "MERGED" | "CLOSED", mergedAt: string | null,
): Promise<string> {
  const id = nextId();
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at)
    values (${id}, ${repositoryId}, ${issueId}, ${id}, ${`https://example.test/pull/${id}`}, 'work', '',
      ${author.id}, ${state}, ${mergedAt})
    returning id
  `;
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issueId}, ${repositoryId})`;
  return pullRequest.id;
}

/** `author`'s merged pull request in `debtor`'s repository, SETTLED for `credits`, crediting `teamId` when given. */
export async function insertSettlement(
  sql: Sql,
  { author, debtor, credits, mergedAt = "2026-01-01T00:00:00.000Z", teamId = null }:
    { author: FixtureAccount; debtor: FixtureAccount; credits: number; mergedAt?: string; teamId?: string | null },
): Promise<{ id: string; issueId: string; pullRequestId: string }> {
  const issueId = await insertIssue(sql, debtor.repositoryId, "CLOSED");
  const pullRequestId = await insertPullRequest(sql, author, debtor.repositoryId, issueId, "MERGED", mergedAt);
  const [settlement] = await sql<{ id: string }[]>`
    insert into settlements (pull_request_id, issue_id, creditor_id, debtor_id, team_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status)
    values (${pullRequestId}, ${issueId}, ${author.id}, ${debtor.id}, ${teamId}, 5, ${credits}, 0, ${credits},
      ${randomUUID().replaceAll("-", "").repeat(2)}, 'SETTLED')
    returning id
  `;
  return { id: settlement.id, issueId, pullRequestId };
}

/** Each account's balance, 0 for an account the ledger never names. */
export async function balancesOf(sql: Sql, ...accountIds: string[]): Promise<number[]> {
  const rows = await sql<{ account_id: string; balance: number }[]>`
    select account_id, balance from balances where account_id = any(${accountIds}::uuid[])
  `;
  return accountIds.map((id) => rows.find((row) => row.account_id === id)?.balance ?? 0);
}

/** An account's `account_credit_limits` row, or null when no credit event names it. */
export async function creditLimitOf(sql: Sql, accountId: string): Promise<{ repaidDebt: number; creditLimit: number } | null> {
  const [row] = await sql<{ repaid_debt: number; credit_limit: number }[]>`
    select repaid_debt::integer, credit_limit::integer from account_credit_limits where account_id = ${accountId}
  `;
  return row === undefined ? null : { repaidDebt: row.repaid_debt, creditLimit: row.credit_limit };
}
