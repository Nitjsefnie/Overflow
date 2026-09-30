import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import type { DashboardSql } from "@/lib/dashboard/queries";

/**
 * The scoping proof for the board's credit-limit replay, per the issue-691
 * plan's Global constraint 10: the `account_credit_limits` replay must price
 * only candidate sponsors' history — the sponsors of open issues on active,
 * available repositories — never every account's settlements.
 *
 * 1. BEHAVIOR — an exhausted candidate sponsor still reaches the board through
 *    the repayment exception, a solvent one keeps both of its openings, and
 *    the limits that decide both come from the sponsor's own replayed
 *    history, not the default.
 *
 * 2. SHAPE — EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of the query the shipped
 *    implementation issues, asserting the replay's window aggregate — the one
 *    place every account's credit events stream through — receives only the
 *    candidate sponsors' events. The board's plan holds exactly one window
 *    aggregate, and loop counts are load-independent, so the bound is on
 *    actual rows, never wall clock.
 */
describe("eligible issues credit-limit replay scoping against PostgreSQL", () => {
  let container: StartedTestContainer | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let realSql: Sql;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "eligible_issues_query_scoping",
      user: "eligible_issues_query_scoping",
      password: "eligible_issues_query_scoping",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = realSql = getSql();
    await runMigrations();
    await seedScopingWorld();
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

  it("boards the candidate sponsors their own replayed limits imply, exhausted or solvent", async () => {
    const board = await listEligibleIssues(seeded.viewerId, { claimState: "ALL" });

    // The limits are hand-computed from the seeded history, where every
    // settlement moves ten credits and the debit archive's repository key
    // sorts before the repay archive's, so the replay always prices the debt
    // before the repayments. Minnow: 30 debits then 10 repayments — balance
    // -200, repaid 100, limit 10 + floor(100 / 10) = 20. Exhausted at its own
    // limit, so its unclaimed opening boards only through the repayment
    // exception, with headroom equal to its balance. Minnowtwo: 30 debits
    // then 28 repayments — balance -20, repaid 280, limit 38. Solvent, so
    // BOTH of its openings board; under the default limit of 10 it would read
    // as exhausted and only the one nominated repayment opening would appear.
    expect(board.map((row) => [row.title, row.availableHeadroom])).toEqual([
      ["minnowtwo open alpha", -20],
      ["minnowtwo open beta", -20],
      ["minnow open one", -200],
    ]);
    expect(board.map((row) => row.sponsorLogin)).toEqual(["minnowtwo", "minnowtwo", "minnow"]);
  });

  it("prices the credit-limit replay only for candidate sponsors", async () => {
    const { text, values } = await captureBoardQuery();
    const explainRows = (await realSql.unsafe(
      `explain (analyze, buffers, format json) ${text}`,
      values as (string | null)[],
    )) as Record<string, unknown>[];
    const explain = (Object.values(explainRows[0]!)[0] ?? []) as { Plan?: ExplainPlanNode }[];
    expect(explain).toHaveLength(1);
    const root = explain[0]!.Plan;
    expect(root).toBeDefined();

    const nodes: ExplainPlanNode[] = [];
    walkPlan(root!, (node) => nodes.push(node));

    // The window aggregate is the one node every credit event streams
    // through: under the unscoped replay it receives the whole world's legs
    // (1598 settlements across 34 accounts = 3196 legs), under the scoped
    // replay only the candidates' (98 settlements for 2 sponsors = 196 legs).
    // The bound names the candidate share with slack, nowhere near the full
    // world.
    const windowAggregates = nodes.filter((node) => node["Node Type"] === "WindowAgg");
    expect(windowAggregates.length, planJson(nodes)).toBeGreaterThan(0);
    for (const aggregate of windowAggregates) {
      expect(aggregate["Actual Loops"], planJson(nodes)).toBe(1);
      expect(aggregate["Actual Rows"], planJson(nodes)).toBeLessThanOrEqual(300);
    }

    // The replayed relation itself carries exactly the candidate sponsors'
    // rows: the CTE feeding the board holds one row per candidate sponsor and
    // nothing else.
    const replayScans = nodes.filter(
      (node) => node["Node Type"] === "CTE Scan" && node["CTE Name"] === "sponsor_credit_limits",
    );
    expect(replayScans.length, planJson(nodes)).toBeGreaterThan(0);
    for (const scan of replayScans) {
      expect(scan["Actual Rows"], planJson(nodes)).toBeLessThanOrEqual(2);
    }
  });
});

/**
 * Runs the shipped implementation against the real database through a
 * recording wrapper that forwards both call shapes untouched — the tagged
 * template and the unnamed escape hatch — so the captured text and values are
 * exactly what Postgres is asked to run whichever path the served code takes.
 */
async function captureBoardQuery(): Promise<{ text: string; values: unknown[] }> {
  const captured: { strings?: TemplateStringsArray; text?: string; values: unknown[] }[] = [];
  const recording = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ strings, values });
      return (sql as unknown as DashboardSql)(strings, ...values);
    },
    {
      unsafe: (text: string, values: unknown[] = []) => {
        captured.push({ text, values });
        return sql.unsafe(text, values as (string | number | null)[]);
      },
    },
  ) as unknown as DashboardSql;
  await listEligibleIssues(seeded.viewerId, {}, { sql: recording });
  expect(captured).toHaveLength(1);
  const entry = captured[0]!;
  const values = entry.values;
  if (entry.strings === undefined) {
    return { text: entry.text!, values };
  }
  let text = entry.strings[0] ?? "";
  for (let index = 1; index < entry.strings.length; index += 1) {
    text += `$${index}${entry.strings[index]}`;
  }
  return { text, values };
}

type ExplainPlanNode = {
  "Node Type": string;
  "Actual Loops"?: number;
  "Actual Rows"?: number;
  "CTE Name"?: string;
  "Relation Name"?: string;
  Plans?: ExplainPlanNode[];
};

function walkPlan(node: ExplainPlanNode, visit: (node: ExplainPlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) {
    walkPlan(child, visit);
  }
}

function planJson(nodes: ExplainPlanNode[]): string {
  const summary = nodes.map((node) => ({
    type: node["Node Type"],
    cte: node["CTE Name"],
    relation: node["Relation Name"],
    rows: node["Actual Rows"],
    loops: node["Actual Loops"],
  }));
  return `plan: ${JSON.stringify(summary)}`;
}

const seeded = {
  viewerId: "",
};

const NOISE_SETTLEMENTS = 50;
const NOISE_ACCOUNTS = 30;

async function seedScopingWorld(): Promise<void> {
  const viewerId = await insertMember("scoping-viewer", 931_001);
  const minnowId = await insertMember("minnow", 931_002);
  const minnowTwoId = await insertMember("minnowtwo", 931_003);
  const kiteId = await insertMember("kite", 931_004);

  // Minnow's history: 30 settled debits (the debt archive is seeded first, so
  // its repository key sorts first and the replay prices the debt before the
  // repayments) then 10 repayments — balance -200, repaid 100, limit 20.
  // Exhausted at its own limit, so its single unclaimed opening boards only
  // through the repayment exception.
  await seedSettledCredits(viewerId, minnowId, 30, "minnow-debt-archive");
  await seedSettledCredits(minnowId, kiteId, 10, "minnow-repay-archive");
  const minnowWork = await insertRepository("minnow/one", minnowId);
  await insertIssue({
    repositoryId: minnowWork,
    issueNumber: 1,
    title: "minnow open one",
    label: "M",
    points: 5,
    createdAt: "2026-06-20T00:00:00.000Z",
  });

  // Minnowtwo's history: 30 debits then 28 repayments — balance -20, repaid
  // 280, limit 38. Solvent against its own limit, so both openings board.
  await seedSettledCredits(viewerId, minnowTwoId, 30, "minnowtwo-debt-archive");
  await seedSettledCredits(minnowTwoId, kiteId, 28, "minnowtwo-repay-archive");
  const minnowTwoWork = await insertRepository("minnowtwo/work", minnowTwoId);
  await insertIssue({
    repositoryId: minnowTwoWork,
    issueNumber: 1,
    title: "minnowtwo open alpha",
    label: "L",
    points: 10,
    createdAt: "2026-06-21T00:00:00.000Z",
  });
  await insertIssue({
    repositoryId: minnowTwoWork,
    issueNumber: 2,
    title: "minnowtwo open beta",
    label: "M",
    points: 5,
    createdAt: "2026-06-22T00:00:00.000Z",
  });

  // The noise world: settlement-heavy accounts that sponsor no open issues,
  // so no row of theirs may reach the credit-limit replay.
  for (let index = 0; index < NOISE_ACCOUNTS; index += 1) {
    const noiseId = await insertMember(`noise-${index}`, 931_010 + index);
    await seedSettledCredits(
      noiseId,
      viewerId,
      NOISE_SETTLEMENTS,
      `noise-archive-${index}`,
    );
  }

  seeded.viewerId = viewerId;
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
  label: string;
  points: number;
  createdAt: string;
}): Promise<void> {
  const githubIssueId = nextExternalId();
  await sql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, created_at
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${""},
      ${`https://github.com/fixture/issues/${githubIssueId}`}, ${"OPEN"},
      ${input.label}, ${input.points}, ${input.points}, ${input.createdAt}
    )
  `;
}

/**
 * Settles `count` ten-credit pieces of work in the sponsor's favour so its
 * replay prices a limit above the default. The fodder lives in an inactive
 * repository so none of it reaches the eligible board, and every settlement
 * carries a unique proof hash.
 */
async function seedSettledCredits(sponsorId: string, debtorId: string, count: number, archiveOwner: string): Promise<void> {
  const archiveRepo = await insertRepository(archiveOwner, sponsorId, false);
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

let externalId = 945_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

function reserveExternalIds(count: number): number {
  externalId += count;
  return externalId - count;
}

/**
 * One module-level client binding: the beforeAll assigns it after
 * DATABASE_URL points at the container, and closeSql in afterAll releases it.
 */
let sql: Sql;
