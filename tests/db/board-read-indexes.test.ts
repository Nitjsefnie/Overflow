import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import type { DashboardSql } from "@/lib/dashboard/queries";

/**
 * Two durable pins on the board-read indexes of migration 056, one per
 * accepted shape:
 *
 * 1. SHAPE — after migrations run, pg_indexes holds exactly the two index
 *    definitions the migration is specified to create: names, key columns and
 *    the partial predicates that mirror the board's claim-state split.
 *
 * 2. PLAN — EXPLAIN (plan only; no ANALYZE, no wall clock anywhere in this
 *    file) of the exact query listEligibleIssues issues, over a world where
 *    the claimed-open minority is tiny relative to the unclaimed-open
 *    majority. The reservations leg (the claimed-open reservation sum) must
 *    read issues through issues_board_claimed_open_idx, and the repayment
 *    opening leg (DISTINCT ON the cheapest unclaimed opening of each
 *    underwater sponsor) through issues_board_unclaimed_open_idx — neither
 *    leg seq-scans issues any more. The two legs whose issues-side predicate
 *    matches most of the table (candidate_sponsors and the main select)
 *    currently keep their sequential scans: no index can beat a scan that
 *    must visit nearly every row.
 */
describe("the board-read indexes", () => {
  let container: StartedTestContainer | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "board_read_indexes",
      user: "board_read_indexes",
      password: "board_read_indexes",
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

  it("creates the two board-read index definitions exactly as specified", async () => {
    const rows = await realSql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where schemaname = 'public'
        and indexname in (${"issues_board_claimed_open_idx"}, ${"issues_board_unclaimed_open_idx"})
      order by indexname
    `;
    await expect(rows).toEqual([
      {
        indexdef:
          "CREATE INDEX issues_board_claimed_open_idx"
          + " ON public.issues USING btree (repository_id)"
          + " WHERE ((state = 'OPEN'::issue_state) AND (claim_assignee_github_login IS NOT NULL))",
      },
      {
        indexdef:
          "CREATE INDEX issues_board_unclaimed_open_idx"
          + " ON public.issues USING btree (repository_id, opening_reserve_points, created_at)"
          + " WHERE ((state = 'OPEN'::issue_state) AND (claim_assignee_github_login IS NULL))",
      },
    ]);
  });

  it("plans the reservations and repayment-opening legs through the new indexes", async () => {
    const { text, values } = await captureEligibleQuery();
    const explainRows = (await realSql.unsafe(
      `explain ${text}`,
      values as (string | number | null)[],
    )) as Record<string, unknown>[];
    const plan = explainRows.map((row) => String(Object.values(row)[0])).join("\n");

    // The reservations leg sums the claimed-open reservations. With eight
    // claimed-open issues among ten thousand unclaimed ones, a partial index
    // over the minority is the only plan that does not visit the whole table;
    // the leg must reference it and must not seq-scan issues.
    const reservations = cteBlock(plan, "reservations");
    expect(reservations, plan).toMatch(/\bissues_board_claimed_open_idx\b/);
    expect(reservations, plan).not.toMatch(/Seq Scan on issues/);

    // The repayment leg picks each underwater sponsor's cheapest unclaimed
    // opening. Repositories here carry a settled backlog beside their open
    // board, as they do in the benchmark world, so the probe of the partial
    // index visits about a fifth fewer entries than the pre-existing unique
    // index and the planner switches — a settled per-repository history is
    // the distribution the partial index earns its keep on.
    const repayment = cteBlock(plan, "repayment_issues");
    expect(repayment, plan).toMatch(/\bissues_board_unclaimed_open_idx\b/);
    expect(repayment, plan).not.toMatch(/Seq Scan on issues/);
  });
});

/**
 * The lines of one materialized CTE's plan block: everything printed under
 * its `CTE <name>` header at a deeper indent, before the next line returns to
 * the header's own indent. The headers carry no cost line, so the exact
 * `^\\s*CTE <name>$` match cannot confuse a `CTE Scan on <name>` line.
 */
function cteBlock(plan: string, name: string): string {
  const lines = plan.split("\n");
  const header = lines.findIndex((line) => new RegExp(`^\\s*CTE ${name}$`).test(line));
  expect(header, `plan should print a CTE ${name} block:\n${plan}`).toBeGreaterThanOrEqual(0);
  const indent = lines[header]!.length - lines[header]!.trimStart().length;
  const block: string[] = [];
  for (let index = header + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length > 0 && line.length - line.trimStart().length <= indent) {
      break;
    }
    block.push(line);
  }
  expect(block.length, `CTE ${name} block should not be empty:\n${plan}`).toBeGreaterThan(0);
  return block.join("\n");
}

/**
 * Runs the shipped implementation against the real database through a
 * recording wrapper that forwards both call shapes untouched — the tagged
 * template and the unnamed escape hatch — so the captured text and values are
 * exactly what Postgres is asked to run whichever path the served code takes.
 */
async function captureEligibleQuery(): Promise<{ text: string; values: unknown[] }> {
  const captured: { strings?: TemplateStringsArray; text?: string; values: unknown[] }[] = [];
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
 * repositories — the claimed-open minority the reservations index exists for.
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
  // unclaimed-open, 20% settled history). Without it the pre-existing unique
  // (repository_id, issue_number) index and the unclaimed-open partial index
  // estimate nearly the same entries per probe and the smaller tuples win —
  // a table that is almost all unclaimed-open is a table the partial index
  // does not help.
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
