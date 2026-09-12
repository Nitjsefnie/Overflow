import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/queries";

/**
 * Settled balance orders the board exactly, without reservation subtraction
 * or buckets. Equal balances retain reserve-descending, age-ascending order;
 * available headroom remains a display field and never filters eligible rows.
 */
describe("sponsor headroom ordering against PostgreSQL", () => {
  describe("equal balances with different reservations", () => {
    let container: StartedTestContainer | undefined;
    const originalDatabaseUrl = process.env.DATABASE_URL;

    beforeAll(async () => {
      const started = await startPostgresContainer({
        database: "sponsor_headroom_repro",
        user: "sponsor_headroom_repro",
        password: "sponsor_headroom_repro",
      });
      container = started.container;
      process.env.DATABASE_URL = started.databaseUrl;
      sql = getSql();
      await runMigrations();
      await seedReproWorld();
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

    it("ignores claims in ordering and keeps all four issues ordered by reserve then age", async () => {
      // Both settled balances are zero. Adam's thirty reserved points affect
      // display only; his older issues win each equal-reserve tie with Bob.
      const board = await listEligibleIssues(seededRepro.viewerId);

      expect(board.map((row) => row.title)).toEqual([
        "adam ten",
        "bob ten",
        "adam five",
        "bob five",
      ]);
      const headroomByTitle = new Map(board.map((row) => [row.title, row.availableHeadroom]));
      expect(headroomByTitle.get("bob ten")).toBe(0);
      expect(headroomByTitle.get("adam ten")).toBe(-30);
    });
  });

  describe("exact settled balances", () => {
    let container: StartedTestContainer | undefined;
    const originalDatabaseUrl = process.env.DATABASE_URL;

    beforeAll(async () => {
      const started = await startPostgresContainer({
        database: "sponsor_headroom_tiers",
        user: "sponsor_headroom_tiers",
        password: "sponsor_headroom_tiers",
      });
      container = started.container;
      process.env.DATABASE_URL = started.databaseUrl;
      sql = getSql();
      await runMigrations();
      await seedTierWorld();
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

    it("keeps one unclaimed issue per exhausted sponsor while preserving exact balance ordering", async () => {
      // Negative balances are real settled debits, separate from the claims
      // that also reduce Carol's, Nina's, and Gail's displayed headroom.
      const board = await listEligibleIssues(seededTiers.viewerId);

      expect(board.map((row) => row.title)).toEqual([
        "flor five",
        "erin five",
        "dave five",
        "hank five",
        "carol ten",
        "nina ten",
        "gail ten",
      ]);
    });

    it("keeps the available-headroom display field on every returned row", async () => {
      const board = await listEligibleIssues(seededTiers.viewerId);

      expect(board).toHaveLength(7);
      for (const row of board) {
        expect(row.availableHeadroom).toBeDefined();
      }
      expect(new Map(board.map((row) => [row.title, row.availableHeadroom]))).toEqual(
        new Map([
          ["erin five", 50],
          ["flor five", 500],
          ["carol ten", -10],
          ["dave five", 0],
          ["hank five", 0],
          ["nina ten", -20],
          ["gail ten", -22],
        ]),
      );
    });
  });
});

const seededRepro = {
  viewerId: "",
};

const seededTiers = {
  viewerId: "",
};

async function seedReproWorld(): Promise<void> {
  const viewerId = await insertMember("repro-viewer", 810_001);
  const adamId = await insertMember("adam", 810_002);
  const bobId = await insertMember("bob", 810_003);

  const adamRepo = await insertRepository("adam/backlog", adamId);
  // Three outsider-claimed openings draw thirty points past Adam's zero balance.
  await insertIssue({ repositoryId: adamRepo, issueNumber: 1, title: "adam drawn one", points: 10, createdAt: "2026-01-01T00:00:00.000Z", assigneeLogin: "drifter-1", assigneeId: 910_001 });
  await insertIssue({ repositoryId: adamRepo, issueNumber: 2, title: "adam drawn two", points: 10, createdAt: "2026-01-02T00:00:00.000Z", assigneeLogin: "drifter-2", assigneeId: 910_002 });
  await insertIssue({ repositoryId: adamRepo, issueNumber: 3, title: "adam drawn three", points: 10, createdAt: "2026-01-03T00:00:00.000Z", assigneeLogin: "drifter-3", assigneeId: 910_003 });
  await insertIssue({ repositoryId: adamRepo, issueNumber: 4, title: "adam ten", points: 10, createdAt: "2026-01-04T00:00:00.000Z" });
  await insertIssue({ repositoryId: adamRepo, issueNumber: 5, title: "adam five", points: 5, createdAt: "2026-01-05T00:00:00.000Z" });

  const bobRepo = await insertRepository("bob/fresh", bobId);
  await insertIssue({ repositoryId: bobRepo, issueNumber: 1, title: "bob ten", points: 10, createdAt: "2026-09-01T00:00:00.000Z" });
  await insertIssue({ repositoryId: bobRepo, issueNumber: 2, title: "bob five", points: 5, createdAt: "2026-09-02T00:00:00.000Z" });

  seededRepro.viewerId = viewerId;
}

async function seedTierWorld(): Promise<void> {
  const viewerId = await insertMember("tier-viewer", 820_001);
  const carolId = await insertMember("carol", 820_002);
  const daveId = await insertMember("dave", 820_003);
  const erinId = await insertMember("erin", 820_004);
  const florId = await insertMember("flor", 820_005);
  const gailId = await insertMember("gail", 820_006);
  const hankId = await insertMember("hank", 820_007);

  // Carol: five settled debit points, plus five reserved points.
  const carolRepo = await insertRepository("carol/ridge", carolId);
  await insertIssue({ repositoryId: carolRepo, issueNumber: 1, title: "carol drawn", points: 5, createdAt: "2026-01-11T00:00:00.000Z", assigneeLogin: "drifter-4", assigneeId: 920_001 });
  await insertIssue({ repositoryId: carolRepo, issueNumber: 2, title: "carol ten", points: 10, createdAt: "2026-02-01T00:00:00.000Z" });
  await seedSettledCredits(viewerId, carolId, 1, "carol-archive", 5);

  // Dave: untouched zero balance.
  const daveRepo = await insertRepository("dune/works", daveId);
  await insertIssue({ repositoryId: daveRepo, issueNumber: 1, title: "dave five", points: 5, createdAt: "2026-03-01T00:00:00.000Z" });

  // Erin: fifty earned credits.
  const erinRepo = await insertRepository("erin/hill", erinId);
  await insertIssue({ repositoryId: erinRepo, issueNumber: 1, title: "erin five", points: 5, createdAt: "2026-05-01T00:00:00.000Z" });
  await seedSettledCredits(erinId, viewerId, 5, "erin-archive");

  // Flor: five hundred earned credits, ahead of Erin despite her newer issue.
  const florRepo = await insertRepository("flor/mesa", florId);
  await insertIssue({ repositoryId: florRepo, issueNumber: 1, title: "flor five", points: 5, createdAt: "2026-05-02T00:00:00.000Z" });
  await seedSettledCredits(florId, viewerId, 50, "flor-archive");

  // Gail: eleven settled debit points, plus eleven reserved points.
  const gailRepo = await insertRepository("gail/cove", gailId);
  await insertIssue({ repositoryId: gailRepo, issueNumber: 1, title: "gail drawn ten", points: 10, createdAt: "2026-01-12T00:00:00.000Z", assigneeLogin: "drifter-5", assigneeId: 920_002 });
  await insertIssue({ repositoryId: gailRepo, issueNumber: 2, title: "gail drawn one", points: 1, createdAt: "2026-01-13T00:00:00.000Z", assigneeLogin: "drifter-6", assigneeId: 920_003 });
  await insertIssue({ repositoryId: gailRepo, issueNumber: 3, title: "gail ten", points: 10, createdAt: "2026-04-01T00:00:00.000Z" });
  await seedSettledCredits(viewerId, gailId, 1, "gail-archive-ten");
  await seedSettledCredits(viewerId, gailId, 1, "gail-archive-one", 1);

  // Nina: ten settled debit points, plus ten reserved points.
  const ninaId = await insertMember("nina", 820_008);
  const ninaRepo = await insertRepository("nina/moor", ninaId);
  await insertIssue({ repositoryId: ninaRepo, issueNumber: 1, title: "nina drawn", points: 10, createdAt: "2026-01-14T00:00:00.000Z", assigneeLogin: "drifter-7", assigneeId: 920_004 });
  await insertIssue({ repositoryId: ninaRepo, issueNumber: 2, title: "nina ten", points: 10, createdAt: "2026-06-01T00:00:00.000Z" });
  await seedSettledCredits(viewerId, ninaId, 1, "nina-archive");

  // Hank: untouched zero balance, tied with Dave but with a newer issue.
  const hankRepo = await insertRepository("hank/dale", hankId);
  await insertIssue({ repositoryId: hankRepo, issueNumber: 1, title: "hank five", points: 5, createdAt: "2026-04-02T00:00:00.000Z" });

  seededTiers.viewerId = viewerId;
}

async function insertMember(login: string, githubUserId: number): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${login})
    returning id
  `;
  return row!.id;
}

async function insertRepository(ownerName: string, sponsorId: string, active = true): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, active, difficulty_scheme
    )
    values (
      ${nextExternalId()}, ${ownerName}, ${sponsorId}, ${"PUBLIC"}, ${nextExternalId()}, ${active},
      ${sql.json(difficultyScheme())}
    )
    returning id
  `;
  return row!.id;
}

async function insertIssue(input: {
  repositoryId: string;
  issueNumber: number;
  title: string;
  points: number;
  createdAt: string;
  assigneeLogin?: string;
  assigneeId?: number;
}): Promise<void> {
  const githubIssueId = nextExternalId();
  await sql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, created_at,
      claim_assignee_github_login, claim_assignee_github_user_id
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${""},
      ${`https://github.com/fixture/issues/${githubIssueId}`}, ${"OPEN"},
      ${openingLabelFor(input.points)}, ${input.points}, ${input.points}, ${input.createdAt},
      ${input.assigneeLogin ?? null}, ${input.assigneeId ?? null}
    )
  `;
}

/**
 * Settles `count` pieces of work between the creditor and debtor. The
 * fodder lives in an inactive repository so none of it reaches the
 * eligible board, and every settlement carries a unique proof hash.
 */
async function seedSettledCredits(creditorId: string, debtorId: string, count: number, archiveOwner: string, credits = 10): Promise<void> {
  const archiveRepo = await insertRepository(archiveOwner, debtorId, false);
  // One reserved id block covers the fodder: issues first, pull requests after.
  const fodderBase = reserveExternalIds(2 * count);
  await sql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    select
      ${fodderBase} + n, ${archiveRepo}, n, ${"archive opening "} || n, ${""},
      ${`https://github.com/${archiveOwner}/issues/`} || n, ${"OPEN"}, ${"M"}, 5, 5
    from generate_series(1, ${count}) as n
  `;
  const pullBase = fodderBase + count;
  await sql`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, state
    )
    select
      ${pullBase} + i.issue_number, ${archiveRepo}, i.id, i.issue_number,
      ${`https://github.com/${archiveOwner}/pulls/`} || i.issue_number, ${"archive work "} || i.issue_number, ${""}, ${"MERGED"}
    from issues i
    where i.repository_id = ${archiveRepo}
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    select p.id, p.issue_id, p.repository_id
    from pull_requests p
    where p.repository_id = ${archiveRepo}
  `;
  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status
    )
    select
      p.id, p.issue_id, ${creditorId}, ${debtorId}, 5, ${credits}, 0, ${credits},
      md5(${archiveOwner} || p.pull_request_number::text) || md5(${"alt"} || ${archiveOwner} || p.pull_request_number::text), ${"SETTLED"}
    from pull_requests p
    where p.repository_id = ${archiveRepo}
  `;
}

function openingLabelFor(points: number): string {
  if (points >= 10) {
    return "L";
  }
  if (points >= 5) {
    return "M";
  }
  return "S";
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 1, reservePoints: 1 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 10, reservePoints: 10 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

let externalId = 880_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

/** Reserves a contiguous block of external ids so generate_series fodder cannot collide with singly-allocated ids. */
function reserveExternalIds(count: number): number {
  externalId += count;
  return externalId - count;
}

/**
 * One module-level client binding shared by both blocks: vitest runs describe
 * blocks sequentially, and each block's afterAll closes the pooled client via
 * closeSql so the next block's getSql rebuilds it against the new DATABASE_URL.
 */
let sql: Sql;
