import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import type { DashboardSql } from "@/lib/dashboard/queries";

/**
 * Two pins on the plan mode the board statement is served in (issue 838):
 *
 * 1. SERVED MODE — the served statement is never a named prepared statement.
 *    The driver's tagged-template path caches every statement under a name,
 *    and PostgreSQL's plan_cache_mode = auto switches a named statement to its
 *    generic plan on the sixth execution: with parameter values unknown, the
 *    outer select's issues leg was priced at a handful of rows against
 *    thousands, and every execution after the fifth paid nested-loop joins for
 *    it. The board serves through the unnamed-statement escape hatch instead,
 *    which PostgreSQL re-plans with the actual parameter values on every
 *    execution, so no board statement is ever registered as named. Six-plus
 *    served executions then leave pg_prepared_statements without one.
 *
 * 2. CONTROL — the collapse this file pins against is real in the seeded
 *    world: a manually PREPAREd copy of the served text, executed six times,
 *    does flip to the generic plan, and that generic plan mis-estimates the
 *    outer select's issues leg by two orders of magnitude. The control fails —
 *    loudly — if a future change to the data shape or the planner makes the
 *    collapse stop reproducing, so the served-mode pin above can never sit
 *    green over a fixture that no longer exercises the defect.
 *
 * Both assertions are load-independent: plan-mode counters and plan-node
 * estimates versus actuals come from one analyzed EXPLAIN, never wall clock.
 */
describe("the board statement's served plan mode", () => {
  let container: StartedTestContainer | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "board_generic_plan",
      user: "board_generic_plan",
      password: "board_generic_plan",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    realSql = getSql();
    await runMigrations();
    await seedPlanWorld();
    // The planner's choice is a property of the data distribution, so the
    // statistics must describe the seeded world before any plan is read.
    await realSql.unsafe("analyze");
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

  it("serves the board unnamed: no named board statement survives six executions", async () => {
    // One past the five-execution switch: a named board statement would have
    // flipped to its generic plan by now, so the statement (and the flip) are
    // observable here if the served path ever regresses to the named cache.
    for (let execution = 0; execution < 6; execution += 1) {
      await listEligibleIssues(seeded.viewerId);
    }
    const named = await realSql<{ name: string }[]>`
      select name from pg_prepared_statements
      where statement like '%candidate_sponsors%'
        and statement not like '%pg_prepared_statements%'
        and name <> 'board_generic_plan_probe'
    `;
    expect(
      named,
      "the board statement was served as a named prepared statement and flipped to its generic plan",
    ).toEqual([]);
  });

  it("the collapse is real in this world: six executions of a named copy flip it generic and mis-estimate the outer issues leg", async () => {
    const { text, values } = await captureServedBoardQuery();
    await realSql.unsafe(`prepare board_generic_plan_probe as ${text}`);

    // The same parameter values the served call passes, inlined for EXECUTE.
    const inline = (value: unknown): string =>
      value === null || value === undefined ? "null" : `'${String(value).replaceAll("'", "''")}'`;
    const args = values.map((value) => inline(value)).join(", ");

    for (let execution = 0; execution < 6; execution += 1) {
      await realSql.unsafe(`execute board_generic_plan_probe(${args})`);
    }
    const counters = await realSql<{ generic_plans: number; custom_plans: number }[]>`
      select generic_plans, custom_plans
      from pg_prepared_statements
      where name = 'board_generic_plan_probe'
    `;
    // Five custom plans, then the auto switch: the flip this file's world must
    // reproduce for the served-mode pin above to mean anything. The counters
    // are bigints and read back as strings through the driver.
    expect(Number(counters[0]?.custom_plans), JSON.stringify(counters)).toBe(5);
    expect(Number(counters[0]?.generic_plans), JSON.stringify(counters)).toBeGreaterThanOrEqual(1);

    const explainRows = (await realSql.unsafe(
      "explain (analyze, format json) execute board_generic_plan_probe(" + args + ")",
    )) as Record<string, unknown>[];
    const explain = (Object.values(explainRows[0]!)[0] ?? []) as { Plan?: ExplainPlanNode }[];
    const root = explain[0]!.Plan;
    expect(root).toBeDefined();
    const nodes: ExplainPlanNode[] = [];
    walkPlan(root!, (node) => nodes.push(node));

    // The generic plan prices the outer select's issues leg at a fraction of
    // its truth and revisits it once per nested-loop iteration: an issues scan
    // whose actual rows run at least twenty times its estimate, more than
    // once. The literal-value plan of the same text seq-scans issues once with
    // a sound estimate, so no node matches under a custom plan.
    const collapsed = nodes.filter(
      (node) =>
        node["Relation Name"] === "issues"
        && (node["Actual Rows"] ?? 0) >= 20 * (node["Plan Rows"] ?? 0)
        && (node["Actual Loops"] ?? 1) > 1,
    );
    expect(collapsed.length, planJson(nodes)).toBeGreaterThan(0);
  });
});

/**
 * Runs the shipped implementation against the real database through a
 * recording wrapper that forwards both call shapes untouched — the tagged
 * template and the unnamed escape hatch — so the captured text and values are
 * exactly what Postgres is asked to run whichever path the served code takes.
 */
async function captureServedBoardQuery(): Promise<{ text: string; values: unknown[] }> {
  const captured: { text?: string; strings?: TemplateStringsArray; values?: unknown[] }[] = [];
  const recording = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      captured.push({ strings, values });
      return (realSql as unknown as DashboardSql)(strings, ...values);
    },
    {
      unsafe: (text: string, values: unknown[] = []) => {
        captured.push({ text, values });
        return realSql.unsafe(text, values as (string | number | null)[]);
      },
    },
  ) as unknown as DashboardSql;
  await listEligibleIssues(seeded.viewerId, {}, { sql: recording });
  expect(captured).toHaveLength(1);
  const entry = captured[0]!;
  const values = entry.values ?? [];
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
  "Plan Rows"?: number;
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
    relation: node["Relation Name"],
    planRows: node["Plan Rows"],
    actualRows: node["Actual Rows"],
    loops: node["Actual Loops"],
  }));
  return `plan: ${JSON.stringify(summary)}`;
}

const seeded = {
  viewerId: "",
};

/**
 * One module-level client binding: the beforeAll assigns it after
 * DATABASE_URL points at the container, and closeSql in afterAll releases it.
 */
let realSql: Sql;

/**
 * The plan fixture: four solvent sponsors with large unclaimed-open backlogs,
 * one underwater sponsor whose active repository holds three unclaimed
 * openings, and eight claimed-open issues scattered over the solvent
 * repositories — the same world the board-read-indexes pin seeds, where the
 * named statement's generic collapse reproduces at CI scale.
 */
async function seedPlanWorld(): Promise<void> {
  const viewerId = await insertMember("plan-viewer", 951_001);
  const auroraId = await insertMember("aurora", 951_002);
  const borealisId = await insertMember("borealis", 951_003);
  const cascadeId = await insertMember("cascade", 951_004);
  const deltaId = await insertMember("delta", 951_005);
  const umbraId = await insertMember("umbra", 951_006);

  const unclaimedPerSponsor = 2_500;
  const auroraOne = await insertRepository("aurora/one", auroraId);
  const borealisOne = await insertRepository("borealis/one", borealisId);
  const cascadeOne = await insertRepository("cascade/one", cascadeId);
  const deltaOne = await insertRepository("delta/one", deltaId);
  const umbraOne = await insertRepository("umbra/one", umbraId);
  await insertUnclaimedIssues(auroraOne, unclaimedPerSponsor);
  await insertUnclaimedIssues(borealisOne, unclaimedPerSponsor);
  await insertUnclaimedIssues(cascadeOne, unclaimedPerSponsor);
  await insertUnclaimedIssues(deltaOne, unclaimedPerSponsor);
  await insertUnclaimedIssues(umbraOne, 3);
  // A settled backlog beside every open board, as production repositories and
  // the benchmark world's repositories alike carry (issue 691's world is 80%
  // unclaimed-open, 20% settled history).
  for (const repository of [auroraOne, borealisOne, cascadeOne, deltaOne, umbraOne]) {
    await insertClosedIssues(repository, 1_000);
  }

  // Eight claimed-open issues, all with a reconciled assignee id distinct from
  // the sponsor's, so every one of them draws reservation headroom.
  for (let index = 1; index <= 5; index += 1) {
    await insertClaimedIssue({
      repositoryId: auroraOne,
      issueNumber: 10_000 + index,
      title: `aurora claimed ${index}`,
      points: 5,
      assigneeLogin: `raven-${index}`,
      assigneeGitHubUserId: 952_000 + index,
    });
  }
  for (let index = 1; index <= 3; index += 1) {
    await insertClaimedIssue({
      repositoryId: borealisOne,
      issueNumber: 10_000 + index,
      title: `borealis claimed ${index}`,
      points: 4,
      assigneeLogin: `kestrel-${index}`,
      assigneeGitHubUserId: 952_100 + index,
    });
  }

  // The viewer's own repository is excluded by the viewer predicate.
  const viewerOwn = await insertRepository("plan-viewer/own", viewerId);
  await insertUnclaimedIssues(viewerOwn, 1);

  // Umbra spent twenty credits and repaid nothing, so its balance of -20 sits
  // below the floor credit limit of 10: the repayment leg has a sponsor to
  // serve. The settled fodder lives in an inactive archive repository so none
  // of it reaches the board.
  await seedSettledSpend(umbraId, auroraId, 2, "umbra-archive");
  seeded.viewerId = viewerId;
}

async function insertMember(login: string, githubUserId: number): Promise<string> {
  const [row] = await realSql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${login})
    returning id
  `;
  return row!.id;
}

async function insertRepository(ownerName: string, sponsorId: string, active = true): Promise<string> {
  const [row] = await realSql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, active, difficulty_scheme
    )
    values (
      ${nextExternalId()}, ${ownerName}, ${sponsorId}, ${"PUBLIC"}, ${nextExternalId()}, ${active},
      ${realSql.json(difficultyScheme())}
    )
    returning id
  `;
  return row!.id;
}

/**
 * `count` unclaimed OPEN issues in one bulk statement: labels and points
 * cycle S/M and 2/5/8, creation times step one second apart, issue numbers
 * are contiguous from 1, and every GitHub id comes from the file's reserved
 * block so the world is deterministic.
 */
async function insertUnclaimedIssues(repositoryId: string, count: number): Promise<void> {
  const githubBase = reserveExternalIds(count);
  await realSql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, created_at
    )
    select
      ${githubBase} + n, ${repositoryId}, n, ${"plan fixture unclaimed "} || n::text, ${""},
      ${"https://github.com/fixture/issues/"} || (${githubBase} + n)::text, ${"OPEN"},
      (case n % 3 when 1 then ${"S"} when 2 then ${"M"} else ${"L"} end),
      (case n % 3 when 1 then 2 when 2 then 5 else 8 end),
      (case n % 3 when 1 then 2 when 2 then 5 else 8 end),
      ${"2026-06-01T00:00:00.000Z"}::timestamptz + (n * interval '1 second')
    from generate_series(1, ${count}) as n
  `;
}

/**
 * `count` CLOSED issues beside the open set of one repository — the settled
 * backlog every production repository accumulates and the board never reads.
 */
async function insertClosedIssues(repositoryId: string, count: number): Promise<void> {
  const githubBase = reserveExternalIds(count);
  await realSql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, created_at
    )
    select
      ${githubBase} + n, ${repositoryId}, ${50_000} + n, ${"plan fixture closed "} || n::text, ${""},
      ${"https://github.com/fixture/issues/"} || (${githubBase} + n)::text, ${"CLOSED"},
      ${"M"}, 5, 5,
      ${"2026-05-01T00:00:00.000Z"}::timestamptz + (n * interval '1 second')
    from generate_series(1, ${count}) as n
  `;
}

async function insertClaimedIssue(input: {
  repositoryId: string;
  issueNumber: number;
  title: string;
  points: number;
  assigneeLogin: string;
  assigneeGitHubUserId: number;
}): Promise<void> {
  const githubIssueId = nextExternalId();
  await realSql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, created_at,
      claim_assignee_github_login, claim_assignee_github_user_id
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${input.issueNumber}, ${input.title}, ${""},
      ${`https://github.com/fixture/issues/${githubIssueId}`}, ${"OPEN"},
      ${"M"}, ${input.points}, ${input.points}, ${"2026-06-02T00:00:00.000Z"},
      ${input.assigneeLogin}, ${input.assigneeGitHubUserId}
    )
  `;
}

/**
 * `count` ten-credit settlements charged to `spenderId` (the debtor) in
 * favour of `earnerId`, so the spender's balance drops below its credit limit
 * while the earner stays solvent.
 */
async function seedSettledSpend(spenderId: string, earnerId: string, count: number, archiveOwner: string): Promise<void> {
  const archiveRepo = await insertRepository(archiveOwner, spenderId, false);
  const fodderBase = reserveExternalIds(2 * count);
  await realSql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    select
      ${fodderBase} + n, ${archiveRepo}, n, ${"archive opening "} || n::text, ${""},
      ${"https://github.com/fixture/issues/"} || (${fodderBase} + n)::text, ${"OPEN"}, ${"M"}, 5, 5
    from generate_series(1, ${count}) as n
  `;
  const pullBase = fodderBase + count;
  await realSql`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, state, merged_at
    )
    select
      ${pullBase} + i.issue_number, ${archiveRepo}, i.id, i.issue_number,
      ${"https://github.com/fixture/pulls/"} || i.issue_number, ${"archive work "} || i.issue_number, ${""},
      ${"MERGED"}, ${"2026-09-01T00:00:00.000Z"}::timestamptz
    from issues i
    where i.repository_id = ${archiveRepo}
  `;
  await realSql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    select p.id, p.issue_id, p.repository_id
    from pull_requests p
    where p.repository_id = ${archiveRepo}
  `;
  await realSql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status
    )
    select
      p.id, p.issue_id, ${earnerId}, ${spenderId}, 5, 10, 0, 10,
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
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

let externalId = 960_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

function reserveExternalIds(count: number): number {
  externalId += count;
  return externalId - count;
}
