import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { hashApiToken } from "@/lib/security/api-token";
import {
  DEFAULT_SEED_OPTIONS,
  benchApiToken,
  benchMemberLogin,
  benchSessionCookieName,
  expectedOpenBoardRows,
  mintBenchSessionCookie,
  parseSeedArgs,
  planSeedWorld,
  seedBoardBenchmark,
  type SeedOptions,
} from "../../scripts/seed-board-benchmark";

const SMALL_WORLD: SeedOptions = {
  repositories: 4,
  openIssues: 40,
  sponsors: 8,
  settlementsPerSponsor: 6,
  underwaterRepos: 2,
};

describe("seed world planning", () => {
  it("plans the same world twice from the same options", () => {
    expect(planSeedWorld(SMALL_WORLD)).toEqual(planSeedWorld(SMALL_WORLD));
  });

  it("plans every account, repository, issue, pull request and settlement the options name", () => {
    const world = planSeedWorld(SMALL_WORLD);

    expect(world.users).toHaveLength(SMALL_WORLD.sponsors + 1); // sponsors + the bench member
    expect(world.repositories).toHaveLength(SMALL_WORLD.repositories);
    expect(world.issues.filter((issue) => issue.state === "OPEN")).toHaveLength(SMALL_WORLD.openIssues);
    expect(world.issues.filter((issue) => issue.state === "CLOSED")).toHaveLength(
      SMALL_WORLD.sponsors * SMALL_WORLD.settlementsPerSponsor,
    );
    expect(world.pullRequests).toHaveLength(SMALL_WORLD.sponsors * SMALL_WORLD.settlementsPerSponsor);
    expect(world.settlements).toHaveLength(SMALL_WORLD.sponsors * SMALL_WORLD.settlementsPerSponsor);
  });

  it("never settles between an account and itself", () => {
    const world = planSeedWorld(SMALL_WORLD);
    for (const settlement of world.settlements) {
      expect(settlement.creditorId).not.toBe(settlement.debtorId);
    }
  });

  it("expects one board row per open issue on a solvent sponsor's repository, plus one repayment issue per underwater sponsor", () => {
    // 40 open issues over 4 repositories: 10 each. Sponsors 2 and 3 (the owners of the last
    // two repositories) are underwater, so their repositories show exactly their one repayment
    // opening each, while the two solvent sponsors' repositories show all 10 of their issues.
    expect(expectedOpenBoardRows(SMALL_WORLD)).toBe(22);
  });

  it("expects the whole board when no sponsor is underwater", () => {
    expect(expectedOpenBoardRows({ ...SMALL_WORLD, underwaterRepos: 0 })).toBe(40);
  });

  it("counts the round-robin remainder repository when its sponsor is solvent", () => {
    // 41 open issues over 4 repositories: repository 0 holds 11, the rest 10.
    // Repository 3's owner is underwater, so the solvent remainder
    // repository's extra issue must still appear: 11 + 10 + 10 + 1 repayment.
    const uneven = { ...SMALL_WORLD, openIssues: 41, underwaterRepos: 1 };
    expect(expectedOpenBoardRows(uneven)).toBe(32);
  });

  it("refuses underwater sponsors beyond the repositories or a sponsor set too small to spare a solvent creditor", () => {
    expect(() => planSeedWorld({ ...SMALL_WORLD, underwaterRepos: 5 })).toThrow(RangeError);
    expect(() => planSeedWorld({ ...SMALL_WORLD, sponsors: 3, underwaterRepos: 2 })).toThrow(RangeError);
  });
});

describe("seed argument parsing", () => {
  it("falls back to the benchmark scale when a flag is absent or malformed", () => {
    expect(parseSeedArgs([])).toEqual(DEFAULT_SEED_OPTIONS);
    expect(parseSeedArgs(["--open-issues", "0", "--sponsors", "not-a-number"])).toEqual(DEFAULT_SEED_OPTIONS);
  });

  it("reads every scale flag and the database url", () => {
    const parsed = parseSeedArgs([
      "--repositories", "3",
      "--open-issues", "90",
      "--sponsors", "12",
      "--settlements-per-sponsor", "4",
      "--underwater-repos", "1",
      "--database-url", "postgresql://x",
    ]);
    expect(parsed).toEqual({
      repositories: 3,
      openIssues: 90,
      sponsors: 12,
      settlementsPerSponsor: 4,
      underwaterRepos: 1,
      databaseUrl: "postgresql://x",
    });
  });
});

describe("session cookie minting", () => {
  it("mints the cookie value the app's AUTH_SECRET decrypts, naming the bench member", async () => {
    // The absolute lifetime (issue 1043) bounds a session to 30 days from its
    // sign-in instant, so the mint records the wall clock it ran at — a fixed
    // date would be born expired.
    const beforeSeconds = Math.floor(Date.now() / 1000);
    const cookie = await mintBenchSessionCookie("bench-secret", "00000000-0000-0000-0000-1000000000c9", 0);
    const afterSeconds = Math.floor(Date.now() / 1000);
    const decoded = await decodeBenchCookie(cookie, "bench-secret");
    expect(decoded?.userId).toBe("00000000-0000-0000-0000-1000000000c9");
    expect(decoded?.sub).toBe("00000000-0000-0000-0000-1000000000c9");
    expect(decoded?.name).toBe(benchMemberLogin());
    expect(decoded?.role).toBe("MEMBER");
    expect(decoded?.authenticatedAt).toBeGreaterThanOrEqual(beforeSeconds);
    expect(decoded?.authenticatedAt).toBeLessThanOrEqual(afterSeconds);
    // The epoch claim the session guard compares at refresh: whatever the
    // caller read from the account's row is what the cookie must carry.
    expect(decoded?.sessionEpoch).toBe(0);
  });

  it("stamps the session epoch it is handed, not a constant", async () => {
    const cookie = await mintBenchSessionCookie("bench-secret", "00000000-0000-0000-0000-1000000000c9", 7);
    const decoded = await decodeBenchCookie(cookie, "bench-secret");
    expect(decoded?.sessionEpoch).toBe(7);
  });

  it("names the cookie the production session strategy reads", () => {
    expect(benchSessionCookieName()).toBe("authjs.session-token");
  });

  it("mints a bearer token the app's own reader accepts, hashing to the stored credential", () => {
    const { token, tokenHash } = benchApiToken();
    const readerHash = hashApiToken(token);
    expect(readerHash).not.toBeNull();
    expect(Buffer.from(readerHash!).equals(tokenHash)).toBe(true);
  });
});

describe("seeding against PostgreSQL", () => {
  let sql: Sql;
  let container: Awaited<ReturnType<typeof startPostgresContainer>>["container"] | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "seed_board_benchmark", user: "seed_board_benchmark", password: "seed_board_benchmark",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    await seedBoardBenchmark(SMALL_WORLD);
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("reports the bench member's session epoch from the row it wrote", async () => {
    // The epoch a minted cookie must carry is whatever the seed wrote, never
    // an assumed default: the seed reads the member row back and reports it,
    // and a cookie minted with that epoch survives the session guard.
    const result = await seedBoardBenchmark(SMALL_WORLD);

    const [row] = await sql<{ session_epoch: number }[]>`
      select session_epoch from users where id = ${result.memberUserId}
    `;
    expect(result.memberSessionEpoch).toBe(row!.session_epoch);

    const cookie = await mintBenchSessionCookie("bench-secret", result.memberUserId, result.memberSessionEpoch);
    const decoded = await decodeBenchCookie(cookie, "bench-secret");
    expect(decoded?.sessionEpoch).toBe(row!.session_epoch);
  });

  it("inserts every row the plan names", async () => {
    const [counts] = await sql<{ users: number; repositories: number; open_issues: number; settled_issues: number; settlements: number; tokens: number }[]>`
      select
        (select count(*) from users)::int as users,
        (select count(*) from registered_repositories)::int as repositories,
        (select count(*) from issues where state = 'OPEN')::int as open_issues,
        (select count(*) from issues where state = 'CLOSED')::int as settled_issues,
        (select count(*) from settlements where status = 'SETTLED')::int as settlements,
        (select count(*) from api_tokens)::int as tokens
    `;
    expect(counts).toEqual({
      users: SMALL_WORLD.sponsors + 1,
      repositories: SMALL_WORLD.repositories,
      open_issues: SMALL_WORLD.openIssues,
      settled_issues: SMALL_WORLD.sponsors * SMALL_WORLD.settlementsPerSponsor,
      settlements: SMALL_WORLD.sponsors * SMALL_WORLD.settlementsPerSponsor,
      tokens: 1,
    });
  });

  it("reseeds to the identical world, ids included", async () => {
    const fingerprint = () =>
      sql<{ digest: string }[]>`select md5(string_agg(id::text, ',' order by id)) as digest from issues`;
    const before = await fingerprint();
    await seedBoardBenchmark(SMALL_WORLD);
    expect(await fingerprint()).toEqual(before);

    const [counts] = await sql<{ issues: number; settlements: number }[]>`
      select (select count(*) from issues)::int as issues, (select count(*) from settlements)::int as settlements
    `;
    expect(counts).toEqual({ issues: 88, settlements: 48 });
  });

  it("mints exactly the deterministic bearer token", async () => {
    const [row] = await sql<{ token_hash: Buffer }[]>`
      select token_hash from api_tokens
    `;
    expect(Buffer.from(row.token_hash).equals(benchApiToken().tokenHash)).toBe(true);
  });

  it("leaves the board at the planned row count for the bench member", async () => {
    const { listEligibleIssues } = await import("@/lib/dashboard/eligible-issues");
    const [member] = await sql<{ id: string }[]>`
      select id from users where github_login = ${benchMemberLogin()}
    `;
    const board = await listEligibleIssues(member.id);
    expect(board).toHaveLength(expectedOpenBoardRows(SMALL_WORLD));
  });

  it("lists every sponsor with a ledger entry and never the bench member", async () => {
    const { listMemberStandings } = await import("@/lib/members/queries");
    const standings = await listMemberStandings();
    expect(standings).toHaveLength(SMALL_WORLD.sponsors);
    expect(standings.map((standing) => standing.githubLogin)).not.toContain(benchMemberLogin());
  });

  it("pushes the underwater repo owners under a credit limit of 10 while solvent repayers earn a higher one", async () => {
    const world = planSeedWorld(SMALL_WORLD);
    const underwater = await sql<{ credit_limit: number }[]>`
      select credit_limit from account_credit_limits
      where account_id = any(${world.users
        .filter((user) => user.underwater)
        .map((user) => user.id)}::uuid[])
    `;
    expect(underwater).toHaveLength(2);
    expect(underwater.map((row) => Number(row.credit_limit)).sort((a, b) => a - b)).toEqual([10, 10]);

    const [solvent] = await sql<{ credit_limit: number }[]>`
      select credit_limit from account_credit_limits
      where account_id = ${world.users.find((user) => !user.underwater)!.id}
    `;
    expect(Number(solvent.credit_limit)).toBeGreaterThan(10);
  });
});

describe("seeding above the pull_request_issues bind-parameter ceiling", () => {
  // 220 sponsors × 101 settlements = 22,220 pull requests, so the unchunked
  // pull_request_issues insert binds 66,660 parameters — over Postgres's
  // 65,535 limit (issue 909) while staying far below the 36,000-settlement
  // reproduction scale, keeping this container run cheap.
  const ABOVE_CEILING: SeedOptions = {
    repositories: 4,
    openIssues: 8,
    sponsors: 220,
    settlementsPerSponsor: 101,
    underwaterRepos: 0,
  };

  let sql: Sql;
  let container: Awaited<ReturnType<typeof startPostgresContainer>>["container"] | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "seed_board_benchmark_ceiling", user: "seed_board_benchmark", password: "seed_board_benchmark",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    await seedBoardBenchmark(ABOVE_CEILING);
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("seeds every pull_request_issues row above the 65,535-parameter limit", async () => {
    const [row] = await sql<{ pull_request_issues: number }[]>`
      select count(*)::int as pull_request_issues from pull_request_issues
    `;
    expect(row.pull_request_issues).toBe(ABOVE_CEILING.sponsors * ABOVE_CEILING.settlementsPerSponsor);
  });
});

async function decodeBenchCookie(cookie: string, secret: string) {
  const { decode } = await import("next-auth/jwt");
  return await decode({
    token: cookie.replace(/^authjs\.session-token=/, ""),
    secret,
    salt: benchSessionCookieName(),
  });
}
