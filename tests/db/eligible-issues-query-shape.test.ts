import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import {
  listEligibleIssues,
  type DashboardSql,
  type EligibleIssueFilters,
  type EligibleIssueProjection,
} from "@/lib/dashboard/queries";

/**
 * Two load-independent pins on the eligible-issues query, per the
 * performance-debugging field guide:
 *
 * 1. EQUITY — the shipped implementation and a reference copy of the ORIGINAL
 *    correlated headroom expression agree row for row (same rows, same order)
 *    over a fixture that exercises every coalesce, exclusion and identity
 *    branch. The reference retains the pre-reshape correlated calculations
 *    with exact settled-balance ordering: parity is proven over real data,
 *    not by re-reading the SQL.
 *
 * 2. SHAPE — EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) of the query the shipped
 *    implementation actually issues, asserting the per-sponsor aggregates
 *    execute once per query: no correlated SubPlan node remains, every
 *    aggregate node reports Actual Loops 1 (the old shape re-ran the
 *    reservation sum and the balance lookup once per output row — six
 *    subplans, each at the output-row loop count), and the once-computed
 *    reservation total reaches the issue rows through a left join rather than
 *    correlation. Loop counts and node shapes are load-independent; wall
 *    clock is not asserted anywhere.
 */
describe("eligible issues query shape against PostgreSQL", () => {
  let container: StartedTestContainer | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let realSql: Sql;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "eligible_issues_query_shape",
      user: "eligible_issues_query_shape",
      password: "eligible_issues_query_shape",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = realSql = getSql();
    await runMigrations();
    await seedShapeWorld();
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

  it("keeps the fixture's hand-computed headrooms and matches the original correlated expression across filter combinations", async () => {
    // Hand-computed semantics first, so the fixture's own expectations cannot
    // silently drift into agreement with a wrong implementation or a wrong
    // reference: the parity check only proves shipped == reference, and both
    // could share a misreading. These pins are independent of both.
    const allBoard = await listEligibleIssues(seeded.viewerId, { claimState: "ALL" });
    // Compared as an ordered list, not a title-keyed map: a map would silently
    // mask a duplicate-titled fixture row, while the list pins board order
    // (settled balance desc, then reserve desc and created_at asc) as well as
    // every value.
    expect(allBoard.map((row) => [row.title, row.availableHeadroom])).toEqual([
      // Cascade: balance +20 from settled credits; 10 + 10 + 10 reserved
      // (the unreconciled null-id assignee DOES count) → -10, visible.
      ["cascade unreconciled ten", -10],
      ["cascade outsider ten one", -10],
      ["cascade outsider ten two", -10],
      ["cascade open one", -10],
      // Aurora: no balances row at all (coalesce to 0); 3 + 6 reserved (the
      // self-claimed four-pointer does NOT reserve; the archived six-pointer
      // in the INACTIVE repository does) → -9. Borealis: nothing reserved,
      // no balances row → 0; the closed claimed five-pointer neither shows
      // nor reserves.
      ["aurora second eight", -9],
      ["borealis open seven", 0],
      ["aurora open five", -9],
      ["aurora self claimed four", -9],
      ["aurora claimed three", -9],
      ["borealis open two", 0],
    ]);

    const openBoard = await listEligibleIssues(seeded.viewerId);
    // Cascade's +20 settled balance leads despite its -10 headroom and lower
    // reserve. Aurora and Borealis tie at zero settled balance, so reserve
    // desc then created_at asc orders their unclaimed issues.
    expect(openBoard.map((row) => row.title)).toEqual([
      "cascade open one",
      "aurora second eight",
      "borealis open seven",
      "aurora open five",
      "borealis open two",
    ]);

    // Exclusions hold: enforcement_state and the viewer's own repositories
    // never reach the board.
    const allTitles = allBoard.map((row) => row.title);
    expect(allTitles).not.toContain("drift recalibrating three");
    expect(allTitles).not.toContain("viewer owned nine");
    expect(allTitles).not.toContain("borealis closed five");

    // Parity with the original correlated expression, row for row in order,
    // across every filter combination the projection layer can pass.
    const filterMatrix: { name: string; filters: EligibleIssueFilters }[] = [
      { name: "the default open board", filters: {} },
      { name: "all claim states", filters: { claimState: "ALL" } },
      { name: "claimed only", filters: { claimState: "CLAIMED" } },
      { name: "repository filter", filters: { repository: "aurora/one" } },
      { name: "label filter over all claims", filters: { openingLabel: "M", claimState: "ALL" } },
    ];
    for (const { name, filters } of filterMatrix) {
      const shipped = await listEligibleIssues(seeded.viewerId, filters);
      const reference = await originalShapeReference(seeded.viewerId, filters);
      expect(shipped, name).toEqual(reference);
    }
  });

  it("prices the per-sponsor aggregates once per query", async () => {
    const { text, values } = await captureEligibleQuery();
    const explainRows = (await realSql.unsafe(
      `explain (analyze, buffers, format json) ${text}`,
      values as (string | null)[],
    )) as Record<string, unknown>[];
    const explain = (Object.values(explainRows[0]!)[0] ?? []) as { Plan?: ExplainPlanNode }[];
    expect(explain).toHaveLength(1);
    const root = explain[0]!.Plan;
    expect(root).toBeDefined();
    const plan = [root!] as ExplainPlanNode[];
    const nodes: ExplainPlanNode[] = [];
    walkPlan(root!, (node) => nodes.push(node));

    // 1. No correlated SubPlan survives: the old shape priced the balance and
    //    the reservation sum with per-row subplans (the auditor's six subplans
    //    at one loop per output row).
    const subplans = nodes.filter((node) => node["Parent Relationship"] === "SubPlan");
    expect(subplans, planJson(plan)).toEqual([]);

    // 2. Every aggregate in the plan executes exactly once: the per-sponsor
    //    reservation total is priced once per query, not once per issue row
    //    (the old shape's sums reported Actual Loops at the output-row scale).
    const aggregates = nodes.filter((node) => /aggregate/i.test(node["Node Type"]));
    expect(aggregates.length, planJson(plan)).toBeGreaterThan(0);
    for (const aggregate of aggregates) {
      expect(aggregate["Actual Loops"], planJson(plan)).toBe(1);
    }

    // 3. The joined aggregate shape is present: the reservation total reaches
    //    the issue rows through a LEFT JOIN to the once-computed reservations
    //    relation (CTE), and some aggregate in the plan sits above an issues
    //    scan (the reservation total itself). JSON EXPLAIN spells laterality
    //    as "Join Type": "Left" on Hash Join / Merge Join / Nested Loop nodes.
    const leftJoins = nodes.filter(
      (node) => node["Join Type"] === "Left" && /join|loop/i.test(node["Node Type"]),
    );
    expect(leftJoins.length, planJson(plan)).toBeGreaterThan(0);
    expect(
      leftJoins.some((join) => subtreeScansCte(join, "reservations")),
      planJson(plan),
    ).toBe(true);
    expect(
      nodes.some((node) => /aggregate/i.test(node["Node Type"]) && subtreeScansRelation(node, "issues")),
      planJson(plan),
    ).toBe(true);
  });
});

/**
 * The reference retains the pre-reshape correlated per-row headroom and reads
 * settled balance independently for the current ordering policy. It uses
 * positional parameters where the shipped code interpolates values ($1 viewer
 * account, $2/$3 repository filter, $4/$5 label filter, $6-$8 claim state).
 */
const ORIGINAL_CORRELATED_REFERENCE = `
select
  ranked.*
from (
select
  issues.id,
  repositories.owner_name as repository_name,
  sponsors.github_login as sponsor_login,
  issues.issue_number,
  issues.title,
  issues.url,
  repositories.difficulty_scheme ->> 'openingName' as opening_name,
  issues.opening_label,
  issues.opening_comparison_points,
  issues.opening_reserve_points,
  issues.claim_assignee_github_login,
  coalesce((select balances.balance from balances where balances.account_id = sponsors.id), 0) as settled_balance,
  (
    coalesce((select balances.balance from balances where balances.account_id = sponsors.id), 0)
    - coalesce((
      select sum(reserved.opening_reserve_points)
      from issues as reserved
      where reserved.repository_id in (
        select sponsored.id from registered_repositories as sponsored where sponsored.sponsor_id = sponsors.id
      )
        and reserved.state = 'OPEN'
        and reserved.claim_assignee_github_login is not null
        and reserved.claim_assignee_github_user_id is distinct from sponsors.github_user_id
    ), 0)
  )::integer as available_headroom,
  issues.created_at
from issues
join registered_repositories as repositories on repositories.id = issues.repository_id
join users as sponsors on sponsors.id = repositories.sponsor_id
where issues.state = 'OPEN'
  and repositories.active = true
  and sponsors.id <> $1
  and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
  and ($2::text is null or repositories.owner_name = $3)
  and ($4::text is null or issues.opening_label = $5)
  and (
    $6::text = 'ALL'
    or ($7::text = 'OPEN' and issues.claim_assignee_github_login is null)
    or ($8::text = 'CLAIMED' and issues.claim_assignee_github_login is not null)
  )
) as ranked
order by
  ranked.settled_balance desc,
  ranked.opening_reserve_points desc,
  ranked.created_at asc
`;

/**
 * Runs the original correlated reference and projects its rows exactly the way
 * the implementation projects the shipped query's rows, so the two arrays
 * compare element for element.
 */
async function originalShapeReference(
  viewerId: string,
  filters: EligibleIssueFilters,
): Promise<EligibleIssueProjection[]> {
  const repositoryFilter = normalizedFilter(filters.repository);
  const openingLabelFilter = normalizedFilter(filters.openingLabel);
  const claimState = filters.claimState ?? "OPEN";
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    ORIGINAL_CORRELATED_REFERENCE,
    [viewerId, repositoryFilter, repositoryFilter, openingLabelFilter, openingLabelFilter, claimState, claimState, claimState],
  );
  return rows.map((row) => {
    const projection: EligibleIssueProjection = {
      id: String(row.id),
      repositoryName: String(row.repository_name),
      issueNumber: Number(row.issue_number),
      title: String(row.title),
      url: String(row.url),
      openingName: String(row.opening_name),
      openingLabel: String(row.opening_label),
      comparisonPoints: Number(row.opening_comparison_points),
      reservePoints: Number(row.opening_reserve_points),
      createdAt: timestampText(row.created_at),
    };
    if (row.sponsor_login !== undefined) {
      projection.sponsorLogin = String(row.sponsor_login);
    }
    if (row.claim_assignee_github_login !== undefined) {
      projection.assigneeGitHubLogin = (row.claim_assignee_github_login ?? null) as string | null;
      projection.claimState = row.claim_assignee_github_login === null ? "OPEN" : "CLAIMED";
    }
    if (row.available_headroom !== undefined) {
      projection.availableHeadroom = Number(row.available_headroom);
    }
    return projection;
  });
}

function normalizedFilter(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function timestampText(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new Error("Created at was not a timestamp.");
  }
  return value;
}

/**
 * Runs the shipped implementation against the real database through a
 * recording wrapper that forwards the tagged-template call untouched, so the
 * captured text and values are exactly what Postgres is asked to run.
 */
async function captureEligibleQuery(): Promise<{ text: string; values: unknown[] }> {
  const captured: { strings: TemplateStringsArray; values: unknown[] }[] = [];
  const recording = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    captured.push({ strings, values });
    return (sql as unknown as DashboardSql)(strings, ...values);
  }) as unknown as DashboardSql;
  await listEligibleIssues(seeded.viewerId, {}, { sql: recording });
  expect(captured).toHaveLength(1);
  const { strings, values } = captured[0]!;
  let text = strings[0] ?? "";
  for (let index = 1; index < strings.length; index += 1) {
    text += `$${index}${strings[index]}`;
  }
  return { text, values };
}

type ExplainPlanNode = {
  "Node Type": string;
  "Parent Relationship"?: string;
  "Actual Loops"?: number;
  "Relation Name"?: string;
  "Join Type"?: string;
  "CTE Name"?: string;
  Plans?: ExplainPlanNode[];
};

function walkPlan(node: ExplainPlanNode, visit: (node: ExplainPlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) {
    walkPlan(child, visit);
  }
}

function subtreeScansRelation(node: ExplainPlanNode, relation: string): boolean {
  if (node["Relation Name"] === relation) {
    return true;
  }
  return (node.Plans ?? []).some((child) => subtreeScansRelation(child, relation));
}

function subtreeScansCte(node: ExplainPlanNode, cteName: string): boolean {
  if (node["Node Type"] === "CTE Scan" && node["CTE Name"] === cteName) {
    return true;
  }
  return (node.Plans ?? []).some((child) => subtreeScansCte(child, cteName));
}

function planJson(plan: ExplainPlanNode[]): string {
  return `plan: ${JSON.stringify(plan, null, 2)}`;
}

const seeded = {
  viewerId: "",
};

async function seedShapeWorld(): Promise<void> {
  const viewerId = await insertMember("shape-viewer", 930_001);
  const auroraId = await insertMember("aurora", 930_002);
  const borealisId = await insertMember("borealis", 930_003);
  const cascadeId = await insertMember("cascade", 930_004);
  const driftId = await insertMember("drift", 930_005);
  await sql`
    update users set enforcement_state = ${"RECALIBRATING"} where id = ${driftId}
  `;

  // Aurora: two active repositories plus an inactive archive. The archive's
  // outsider-claimed six-pointer still draws headroom (the reservation set is
  // every repository the sponsor registered, active or not), while none of
  // its rows reach the board.
  const auroraOne = await insertRepository("aurora/one", auroraId);
  const auroraTwo = await insertRepository("aurora/two", auroraId);
  const auroraArchive = await insertRepository("aurora/arch", auroraId, false);
  await insertIssue({ repositoryId: auroraOne, issueNumber: 1, title: "aurora open five", label: "M", points: 5, createdAt: "2026-06-01T00:00:00.000Z" });
  await insertIssue({
    repositoryId: auroraOne, issueNumber: 2, title: "aurora claimed three", label: "S", points: 3,
    createdAt: "2026-06-02T00:00:00.000Z", assigneeLogin: "raven", assigneeId: 930_101,
  });
  await insertIssue({ repositoryId: auroraTwo, issueNumber: 1, title: "aurora second eight", label: "M", points: 8, createdAt: "2026-06-03T00:00:00.000Z" });
  await insertIssue({
    repositoryId: auroraTwo, issueNumber: 2, title: "aurora self claimed four", label: "S", points: 4,
    createdAt: "2026-06-04T00:00:00.000Z", assigneeLogin: "aurora", assigneeId: 930_002,
  });
  await insertIssue({
    repositoryId: auroraArchive, issueNumber: 1, title: "aurora archived six", label: "M", points: 6,
    createdAt: "2026-06-05T00:00:00.000Z", assigneeLogin: "kestrel", assigneeId: 930_102,
  });

  // Borealis: nothing reserved at all. The closed claimed five-pointer is
  // reserved by nobody — only OPEN issues draw headroom — and never boards.
  const borealisOne = await insertRepository("borealis/one", borealisId);
  await insertIssue({ repositoryId: borealisOne, issueNumber: 1, title: "borealis open two", label: "S", points: 2, createdAt: "2026-06-06T00:00:00.000Z" });
  await insertIssue({ repositoryId: borealisOne, issueNumber: 2, title: "borealis open seven", label: "M", points: 7, createdAt: "2026-06-07T00:00:00.000Z" });
  await insertIssue({
    repositoryId: borealisOne, issueNumber: 3, title: "borealis closed five", label: "M", points: 5,
    createdAt: "2026-06-08T00:00:00.000Z", assigneeLogin: "harrier", assigneeId: 930_103, state: "CLOSED",
  });

  // Cascade: overcommitted. Twenty settled credits against thirty reserved
  // points — three outsider-claimed ten-pointers, one of them still carrying
  // a null (unreconciled) assignee id, which must count as reserved.
  const cascadeOne = await insertRepository("cascade/one", cascadeId);
  await insertIssue({
    repositoryId: cascadeOne, issueNumber: 1, title: "cascade unreconciled ten", label: "L", points: 10,
    createdAt: "2026-06-09T00:00:00.000Z", assigneeLogin: "wraith", assigneeId: null,
  });
  await insertIssue({
    repositoryId: cascadeOne, issueNumber: 2, title: "cascade outsider ten one", label: "L", points: 10,
    createdAt: "2026-06-10T00:00:00.000Z", assigneeLogin: "merlin", assigneeId: 930_104,
  });
  await insertIssue({
    repositoryId: cascadeOne, issueNumber: 3, title: "cascade outsider ten two", label: "L", points: 10,
    createdAt: "2026-06-11T00:00:00.000Z", assigneeLogin: "pygmy", assigneeId: 930_105,
  });
  await insertIssue({ repositoryId: cascadeOne, issueNumber: 4, title: "cascade open one", label: "S", points: 1, createdAt: "2026-06-12T00:00:00.000Z" });
  await seedSettledCredits(cascadeId, viewerId, 2, "cascade-archive");

  // Drift: a RECALIBRATING sponsor never reaches the board.
  const driftOne = await insertRepository("drift/one", driftId);
  await insertIssue({ repositoryId: driftOne, issueNumber: 1, title: "drift recalibrating three", label: "S", points: 3, createdAt: "2026-06-13T00:00:00.000Z" });

  // The viewer's own repository is excluded by the viewer predicate.
  const viewerOwn = await insertRepository("shape-viewer/own", viewerId);
  await insertIssue({ repositoryId: viewerOwn, issueNumber: 1, title: "viewer owned nine", label: "M", points: 9, createdAt: "2026-06-14T00:00:00.000Z" });

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
  assigneeLogin?: string;
  assigneeId?: number | null;
  state?: "OPEN" | "CLOSED";
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
      ${`https://github.com/fixture/issues/${githubIssueId}`}, ${input.state ?? "OPEN"},
      ${input.label}, ${input.points}, ${input.points}, ${input.createdAt},
      ${input.assigneeLogin ?? null}, ${input.assigneeId ?? null}
    )
  `;
}

/**
 * Settles `count` ten-credit pieces of work in the sponsor's favour so the
 * balances view reports count times ten. The fodder lives in an inactive
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

let externalId = 940_000;
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
