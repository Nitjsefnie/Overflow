import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
// @ts-expect-error -- untyped .mjs script module
import { BOARD_FIXTURE_ISSUE_TITLE, seedBoardFixtureCard, seedFixtureUsers } from "../../scripts/page-geometry-fixtures.mjs";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * The board fixture's fixed row identities, pinned here by their literals the
 * way the session fixture's ids are pinned in check-page-geometry-session:
 * the seeder must create exactly these rows, so the test knows them apart
 * from the seeder's own return value.
 */
const SPONSOR_FIXTURE_USER_ID = "00000000-0000-4000-8000-000000001067";
const REPOSITORY_FIXTURE_ID = "00000000-0000-4000-8000-000000001068";
const ISSUE_FIXTURE_ID = "00000000-0000-4000-8000-000000001069";

/**
 * The one long unbroken title the /issues overflow is measured against
 * (issue 1067): the audit's 256-character issue title, byte for byte.
 */
const EXPECTED_TITLE = "a".repeat(256);

describe("seedBoardFixtureCard (issue 1067)", () => {
  let container: StartedTestContainer | undefined;
  let sql: Sql;
  let databaseUrl: string;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "geometry_board_fixture_test",
      user: "geometry_board_fixture_test",
      password: "geometry_board_fixture_test",
    });
    container = started.container;
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    // The second run replays every migration against the installed schema, the
    // same re-runnability guard the other container suites apply.
    await runMigrationsTwice();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("seeds the sponsor, repository and issue rows, then repeats with the same ids and no new rows", async () => {
    const first = await seedBoardFixtureCard({ databaseUrl });
    expect(first).toEqual({
      sponsorUserId: SPONSOR_FIXTURE_USER_ID,
      repositoryId: REPOSITORY_FIXTURE_ID,
      issueId: ISSUE_FIXTURE_ID,
    });

    const countsAfterFirst = await readCounts();

    const second = await seedBoardFixtureCard({ databaseUrl });
    expect(second).toEqual(first);
    await expect(readCounts()).resolves.toEqual(countsAfterFirst);
  });

  it("seeds the rows the board statement's WHERE clauses admit for the fixture member", async () => {
    // Both fixtures together are exactly what the /issues page renders for
    // the seeded member: the board read is the contract the gate measures.
    await seedFixtureUsers({ databaseUrl });
    await seedBoardFixtureCard({ databaseUrl });

    const issues = await listEligibleIssues("00000000-0000-4000-8000-00000000453a", {}, {
      sql: sql as unknown as DashboardSql,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      repositoryName: "geometry-fixture-owner",
      issueNumber: 1,
      title: EXPECTED_TITLE,
      openingLabel: "medium",
      comparisonPoints: 3,
      reservePoints: 3,
      claimState: "OPEN",
      sponsorLogin: "geometry-fixture-sponsor",
      availableHeadroom: 0,
    });
    expect(issues[0].title.length).toBe(256);
    expect(BOARD_FIXTURE_ISSUE_TITLE).toBe(EXPECTED_TITLE);
  });

  it("repairs a drifted title on the next seed", async () => {
    await sql`update issues set title = 'drifted' where id = ${ISSUE_FIXTURE_ID}`;

    await seedBoardFixtureCard({ databaseUrl });

    const [row] = await sql<{ title: string }[]>`
      select title from issues where id = ${ISSUE_FIXTURE_ID}
    `;
    expect(row.title).toBe(EXPECTED_TITLE);
  });

  it("repairs a repository whose availability and scheme drifted, on the next seed", async () => {
    // Every leg the conflict path restores, drifted at once: an inactive
    // repository with an availability pair and a foreign opening name. Any
    // leg left unrepaired keeps the card off the /issues board — the 320px
    // row would then pass vacuously against an empty board.
    await sql`
      update registered_repositories
      set active = false, unavailable_reason = 'NOT_FOUND', unavailable_since = now(),
        difficulty_scheme = jsonb_set(difficulty_scheme, '{openingName}', '"Other"')
      where id = ${REPOSITORY_FIXTURE_ID}
    `;

    await seedBoardFixtureCard({ databaseUrl });

    const [row] = await sql<{
      active: boolean;
      unavailableReason: string | null;
      unavailableSince: Date | null;
      openingName: string;
    }[]>`
      select active, unavailable_reason as "unavailableReason", unavailable_since as "unavailableSince",
        difficulty_scheme ->> 'openingName' as "openingName"
      from registered_repositories where id = ${REPOSITORY_FIXTURE_ID}
    `;
    expect(row).toEqual({
      active: true,
      unavailableReason: null,
      unavailableSince: null,
      openingName: "Offered",
    });
  });

  it("repairs an issue whose state drifted to CLOSED, on the next seed", async () => {
    await sql`update issues set state = 'CLOSED' where id = ${ISSUE_FIXTURE_ID}`;

    await seedBoardFixtureCard({ databaseUrl });

    const [row] = await sql<{ state: string }[]>`
      select state::text as state from issues where id = ${ISSUE_FIXTURE_ID}
    `;
    expect(row.state).toBe("OPEN");
  });

  it("repairs a sponsor whose enforcement state drifted off ACTIVE", async () => {
    await sql`update users set enforcement_state = 'BANNED' where id = ${SPONSOR_FIXTURE_USER_ID}`;

    await seedBoardFixtureCard({ databaseUrl });

    const [row] = await sql<{ enforcementState: string }[]>`
      select enforcement_state::text as "enforcementState" from users where id = ${SPONSOR_FIXTURE_USER_ID}
    `;
    expect(row.enforcementState).toBe("ACTIVE");
  });

  function readCounts() {
    // A fresh container holds nothing but this fixture's rows, so the counts
    // pin both the insert and the no-op second call.
    return (async () => {
      const [users] = await sql<{ count: string }[]>`select count(*)::text as count from users`;
      const [repositories] = await sql<{ count: string }[]>`select count(*)::text as count from registered_repositories`;
      const [issues] = await sql<{ count: string }[]>`select count(*)::text as count from issues`;
      return { users: users.count, repositories: repositories.count, issues: issues.count };
    })();
  }

  async function runMigrationsTwice() {
    const { runMigrations } = await import("../../scripts/migrate");
    await runMigrations();
    await runMigrations();
  }
});
