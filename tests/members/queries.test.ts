import postgres, { type Sql } from "postgres";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/migrate";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { closeSql, getSql } from "@/lib/db/client";
import { getDashboard } from "@/lib/dashboard/queries";
import { listMemberStandings, type MemberStandingsSql } from "@/lib/members/queries";

type QueryCapture = { text: string; values: unknown[] };

function sqlHarness(responses: unknown[][]): { sql: MemberStandingsSql; captures: QueryCapture[] } {
  const captures: QueryCapture[] = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    captures.push({ text: strings.join("?"), values });
    const response = responses.shift();
    if (response === undefined) {
      throw new Error("Unexpected member standings query.");
    }
    return response;
  }) as MemberStandingsSql;
  return { sql, captures };
}

describe("member standings projections", () => {
  it("maps each ledger row onto the account's earned, given and net totals", async () => {
    const { sql } = sqlHarness([
      [
        { id: "account-1", github_login: "mira", earned_total: 12, given_total: 6 },
        { id: "account-2", github_login: "quinn", earned_total: "4", given_total: "0" },
      ],
    ]);

    await expect(listMemberStandings({ sql })).resolves.toEqual([
      { accountId: "account-1", githubLogin: "mira", earnedTotal: 12, givenTotal: 6, netBalance: 6 },
      { accountId: "account-2", githubLogin: "quinn", earnedTotal: 4, givenTotal: 0, netBalance: 4 },
    ]);
  });

  it("reads every standing in one query that joins users to their ledger entries", async () => {
    const { sql, captures } = sqlHarness([[]]);

    await listMemberStandings({ sql });

    expect(captures).toHaveLength(1);
    const query = captures[0]!.text;
    expect(query).toMatch(/from users\s+join ledger_entries on ledger_entries\.account_id = users\.id/i);
  });

  it("computes the two totals with the dashboard arithmetic", async () => {
    const { sql, captures } = sqlHarness([[]]);

    await listMemberStandings({ sql });

    const query = captures[0]!.text;
    expect(query).toContain(
      "coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount > 0), 0)",
    );
    expect(query).toContain(
      "abs(coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount < 0), 0))",
    );
  });

  it("orders by the combined earned and given volume descending, logins ascending on a tie", async () => {
    const { sql, captures } = sqlHarness([[]]);

    await listMemberStandings({ sql });

    const query = captures[0]!.text.replace(/\s+/g, " ").trim();
    const orderClause = query.slice(query.toLocaleLowerCase().indexOf("order by"));
    expect(orderClause).toContain(
      "coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount > 0), 0)",
    );
    expect(orderClause).toContain(
      "+ abs(coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount < 0), 0))",
    );
    expect(orderClause.toLocaleLowerCase()).toMatch(/\) desc, users\.github_login asc$/);
  });

  it("is a global view and not scoped to any viewer", async () => {
    const { sql, captures } = sqlHarness([[]]);

    await listMemberStandings({ sql });

    expect(captures[0]!.values).toEqual([]);
  });
});

describe("member standings in PostgreSQL", () => {
  let database: StartedPostgres | undefined;
  let sql: Sql;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const logins = ["alpha", "mira", "pat", "quinn", "zeta"];
  const accountIds: Record<string, string> = {};

  beforeAll(async () => {
    database = await startPostgresContainer({
      database: "members_standings",
      user: "members_test",
      password: "members_test",
    });
    process.env.DATABASE_URL = database.databaseUrl;
    sql = getSql();
    await runMigrations();
    await runMigrations();

    for (const login of [...logins, "nobody"]) {
      accountIds[login] = await insertStandingsUser(sql, login);
    }
    // Volumes: mira 18, zeta 12, alpha 6, then a 4/4 tie between pat and quinn
    // that only the ascending-login tie-break can settle. "nobody" holds no
    // ledger entry and must not appear at all.
    await insertSettledPair(sql, { creditorId: accountIds.mira!, debtorId: accountIds.zeta!, credits: 6 });
    await insertSettledPair(sql, { creditorId: accountIds.mira!, debtorId: accountIds.alpha!, credits: 6 });
    await insertSettledPair(sql, { creditorId: accountIds.zeta!, debtorId: accountIds.mira!, credits: 6 });
    await insertSettledPair(sql, { creditorId: accountIds.pat!, debtorId: accountIds.quinn!, credits: 4 });
  });

  afterAll(async () => {
    await closeSql();
    await database?.container.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("agrees with the dashboard projection for every account holding a ledger entry", async () => {
    const standings = await listMemberStandings({ sql: sql as unknown as MemberStandingsSql });
    const byLogin = new Map(standings.map((standing) => [standing.githubLogin, standing]));

    expect(standings.map((standing) => standing.githubLogin)).toEqual([
      "mira", "zeta", "alpha", "pat", "quinn",
    ]);
    expect(byLogin.get("nobody")).toBeUndefined();

    for (const login of logins) {
      const standing = byLogin.get(login)!;
      const dashboard = await getDashboard(standing.accountId);
      expect(standing.earnedTotal).toBe(dashboard.earnedTotal);
      expect(standing.givenTotal).toBe(dashboard.givenTotal);
      expect(standing.netBalance).toBe(dashboard.settledBalance);
    }

    expect(byLogin.get("mira")).toEqual({
      accountId: accountIds.mira, githubLogin: "mira", earnedTotal: 12, givenTotal: 6, netBalance: 6,
    });
    expect(byLogin.get("zeta")).toEqual({
      accountId: accountIds.zeta, githubLogin: "zeta", earnedTotal: 6, givenTotal: 6, netBalance: 0,
    });
    expect(byLogin.get("alpha")).toEqual({
      accountId: accountIds.alpha, githubLogin: "alpha", earnedTotal: 0, givenTotal: 6, netBalance: -6,
    });
    expect(byLogin.get("pat")).toEqual({
      accountId: accountIds.pat, githubLogin: "pat", earnedTotal: 4, givenTotal: 0, netBalance: 4,
    });
    expect(byLogin.get("quinn")).toEqual({
      accountId: accountIds.quinn, githubLogin: "quinn", earnedTotal: 0, givenTotal: 4, netBalance: -4,
    });
  });

  it("breaks an earned-plus-given tie by login ascending", async () => {
    const standings = await listMemberStandings({ sql: sql as unknown as MemberStandingsSql });

    expect(standings.map((standing) => standing.githubLogin)).toEqual([
      "mira", "zeta", "alpha", "pat", "quinn",
    ]);
    const volumes = standings.map((standing) => standing.earnedTotal + standing.givenTotal);
    expect(volumes).toEqual([18, 12, 6, 4, 4]);
  });
});

let externalId = 5_000_000;

function nextExternalId(): number {
  return externalId++;
}

async function insertStandingsUser(client: Sql, githubLogin: string): Promise<string> {
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${nextExternalId()}, ${githubLogin})
    returning id
  `;
  return user.id;
}

/**
 * One settled settlement with its own repository, issue and merged pull request, so exactly one
 * creditor/debtor pair moves `credits` in the ledger and nothing else in the seeded database
 * disturbs the arithmetic.
 */
async function insertSettledPair(
  client: Sql,
  parties: { creditorId: string; debtorId: string; credits: number },
): Promise<void> {
  const githubRepositoryId = nextExternalId();
  const [repository] = await client<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${githubRepositoryId}, ${`standings-${githubRepositoryId}/repo`}, ${parties.debtorId}, ${"PUBLIC"},
      ${nextExternalId()}, ${client.json(validDifficultyScheme())}::jsonb
    )
    returning id
  `;
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    ) values (
      ${githubIssueId}, ${repository.id}, ${nextExternalId()}, ${"A settled issue"}, ${"Settlement evidence"},
      ${`https://github.com/standings/repo/issues/${githubIssueId}`}, ${"CLOSED"}, ${"size/M"}, 5, 5
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await client<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, author_id, state,
      merged_at
    ) values (
      ${githubPullRequestId}, ${repository.id}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/standings/repo/pull/${githubPullRequestId}`}, ${"A merged contribution"},
      ${"Pull request evidence"}, ${parties.creditorId}, ${"MERGED"}, now()
    )
    returning id
  `;
  await client`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${repository.id})
  `;
  await client`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    ) values (
      ${pullRequest.id}, ${issue.id}, ${parties.creditorId}, ${parties.debtorId}, 5, ${parties.credits}, 0,
      ${parties.credits}, ${nextExternalId().toString(16).padStart(64, "0")}, ${"SETTLED"}
    )
  `;
}
