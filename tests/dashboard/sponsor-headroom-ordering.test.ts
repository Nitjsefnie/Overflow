import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/queries";

/**
 * The eligible board leads with a bucketed sponsor-headroom tier before the
 * reserve points a sponsor declares for themselves: a sponsor who has returned
 * more work than they have drawn (positive headroom) is offered ahead of one
 * in balance, who is offered ahead of one who has drawn far more than they
 * have returned. The tier orders but never filters — every open issue stays on
 * the board — and inside a tier the long-standing reserve-then-age keys stand.
 *
 * The tier absorbs the zero cliff: the first outsider claim puts a sponsor a
 * few points below zero, and burying them for it would punish exactly the
 * first step into the ledger. The boundary sits at minus ten — roughly one
 * full opening of reserve beyond a zero balance — so drawing past it means
 * more than one unredeemed opening, not a single claim.
 */
describe("sponsor headroom ordering against PostgreSQL", () => {
  /** The issue's repro, isolated: one insolvent sponsor, one solvent one. */
  describe("the insolvent-versus-solvent repro", () => {
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

    it("ranks the solvent sponsor's issues above the insolvent sponsor's and keeps all four on the board", async () => {
      // Adam has drawn three outsider claims (30 reserved points) against a
      // zero balance; Bob has reserved nothing. Reserve points alone would put
      // Adam's older issues on top of each tier; the headroom tier must put
      // Bob above him without dropping a single row.
      const board = await listEligibleIssues(seededRepro.viewerId);

      expect(board.map((row) => row.title)).toEqual([
        "bob ten",
        "bob five",
        "adam ten",
        "adam five",
      ]);
      const headroomByTitle = new Map(board.map((row) => [row.title, row.availableHeadroom]));
      expect(headroomByTitle.get("bob ten")).toBe(0);
      expect(headroomByTitle.get("adam ten")).toBe(-30);
    });
  });

  /**
   * The tier boundaries, isolated: the zero cliff, balance-size neutrality,
   * the inclusive minus-ten boundary, the demotion past it, and the display
   * field every row still carries.
   */
  describe("the tier boundaries", () => {
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

    it("orders the whole board by tier before reserve points", async () => {
      // Tier 0: Erin (+50) and Flor (+500). Tier 1: Carol (-5), Nina (-10),
      // Dave (0), Hank (0). Tier 2: Gail (-11). Inside each tier, reserve
      // points desc then created_at asc.
      const board = await listEligibleIssues(seededTiers.viewerId);

      expect(board.map((row) => row.title)).toEqual([
        "erin five",
        "flor five",
        "carol ten",
        "nina ten",
        "dave five",
        "hank five",
        "gail ten",
      ]);
    });

    it("keeps a sponsor just past zero tiered with a balanced sponsor instead of burying them", async () => {
      // Carol sits at -5 from one claimed five-pointer. A sign cliff would
      // drop her below every zero-headroom sponsor; the minus-ten bucket
      // keeps her with them, where her higher reserve keeps her ahead of Dave.
      const board = await listEligibleIssues(seededTiers.viewerId);
      const positionOf = (title: string) => board.findIndex((row) => row.title === title);

      expect(positionOf("carol ten")).toBeLessThan(positionOf("dave five"));
    });

    it("does not let the largest positive balance monopolize the top tier", async () => {
      // Erin at +50 and Flor at +500 share tier 0, so raw balance size ranks
      // neither above the other: age decides.
      const board = await listEligibleIssues(seededTiers.viewerId);
      const positionOf = (title: string) => board.findIndex((row) => row.title === title);

      expect(positionOf("erin five")).toBeLessThan(positionOf("flor five"));
    });

    it("demotes a sponsor past the minus-ten boundary below a balanced sponsor with lower reserve", async () => {
      // Gail has drawn eleven points past balance and offers a ten-pointer;
      // Hank has drawn nothing and offers a five-pointer. Reserve points alone
      // would lead with Gail; the tier must not.
      const board = await listEligibleIssues(seededTiers.viewerId);
      const positionOf = (title: string) => board.findIndex((row) => row.title === title);

      expect(positionOf("hank five")).toBeLessThan(positionOf("gail ten"));
    });

    it("keeps a sponsor at exactly minus ten in the balanced tier, above the demoted one", async () => {
      // Nina sits exactly on the boundary: zero balance, one outsider-claimed
      // ten-pointer. The boundary is inclusive, so she shares the balanced
      // tier and outranks Hank's lower reserve per the standing keys, above
      // the demoted Gail below her. A boundary mutated to exclusive
      // (`> -10`) drops Nina into the demoted tier, behind Gail's older
      // ten-pointer, and behind Hank — both assertions fire on that mutant.
      const board = await listEligibleIssues(seededTiers.viewerId);
      const positionOf = (title: string) => board.findIndex((row) => row.title === title);

      expect(positionOf("nina ten")).toBeLessThan(positionOf("gail ten"));
      expect(positionOf("nina ten")).toBeLessThan(positionOf("hank five"));
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
          ["carol ten", -5],
          ["nina ten", -10],
          ["dave five", 0],
          ["hank five", 0],
          ["gail ten", -11],
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

  // Carol: one claimed five-pointer puts her five past balance — tier 1.
  const carolRepo = await insertRepository("carol/ridge", carolId);
  await insertIssue({ repositoryId: carolRepo, issueNumber: 1, title: "carol drawn", points: 5, createdAt: "2026-01-11T00:00:00.000Z", assigneeLogin: "drifter-4", assigneeId: 920_001 });
  await insertIssue({ repositoryId: carolRepo, issueNumber: 2, title: "carol ten", points: 10, createdAt: "2026-02-01T00:00:00.000Z" });

  // Dave: untouched zero balance — tier 1.
  const daveRepo = await insertRepository("dune/works", daveId);
  await insertIssue({ repositoryId: daveRepo, issueNumber: 1, title: "dave five", points: 5, createdAt: "2026-03-01T00:00:00.000Z" });

  // Erin: fifty earned credits — tier 0.
  const erinRepo = await insertRepository("erin/hill", erinId);
  await insertIssue({ repositoryId: erinRepo, issueNumber: 1, title: "erin five", points: 5, createdAt: "2026-05-01T00:00:00.000Z" });
  await seedSettledCredits(erinId, viewerId, 5, "erin-archive");

  // Flor: five hundred earned credits — also tier 0; size must not matter.
  const florRepo = await insertRepository("flor/mesa", florId);
  await insertIssue({ repositoryId: florRepo, issueNumber: 1, title: "flor five", points: 5, createdAt: "2026-05-02T00:00:00.000Z" });
  await seedSettledCredits(florId, viewerId, 50, "flor-archive");

  // Gail: a ten-pointer and a one-pointer claimed by outsiders put her eleven
  // past balance — one past the minus-ten boundary — tier 2.
  const gailRepo = await insertRepository("gail/cove", gailId);
  await insertIssue({ repositoryId: gailRepo, issueNumber: 1, title: "gail drawn ten", points: 10, createdAt: "2026-01-12T00:00:00.000Z", assigneeLogin: "drifter-5", assigneeId: 920_002 });
  await insertIssue({ repositoryId: gailRepo, issueNumber: 2, title: "gail drawn one", points: 1, createdAt: "2026-01-13T00:00:00.000Z", assigneeLogin: "drifter-6", assigneeId: 920_003 });
  await insertIssue({ repositoryId: gailRepo, issueNumber: 3, title: "gail ten", points: 10, createdAt: "2026-04-01T00:00:00.000Z" });

  // Nina: exactly on the boundary — zero balance, one outsider-claimed
  // ten-pointer puts her at minus ten, the inclusive edge of the balanced tier.
  const ninaId = await insertMember("nina", 820_008);
  const ninaRepo = await insertRepository("nina/moor", ninaId);
  await insertIssue({ repositoryId: ninaRepo, issueNumber: 1, title: "nina drawn", points: 10, createdAt: "2026-01-14T00:00:00.000Z", assigneeLogin: "drifter-7", assigneeId: 920_004 });
  await insertIssue({ repositoryId: ninaRepo, issueNumber: 2, title: "nina ten", points: 10, createdAt: "2026-06-01T00:00:00.000Z" });

  // Hank: untouched zero balance — tier 1.
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
 * Settles `count` ten-credit pieces of work in the sponsor's favour so the
 * balances view — settled credits minus owed credits — reports count times
 * ten. The fodder lives in an inactive repository so none of it reaches the
 * eligible board, and every settlement carries a unique proof hash.
 */
async function seedSettledCredits(sponsorId: string, debtorId: string, count: number, archiveOwner: string): Promise<void> {
  const archiveRepo = await insertRepository(archiveOwner, sponsorId, false);
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
      p.id, p.issue_id, ${sponsorId}, ${debtorId}, 5, 10, 0, 10,
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
