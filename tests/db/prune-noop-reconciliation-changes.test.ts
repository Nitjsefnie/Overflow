import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JSONValue, Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { runPruneNoopReconciliationChangesCli } from "../../scripts/prune-noop-reconciliation-changes";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

/**
 * Issue 665: reconciliation once recorded a no-op CHANGE row for every
 * settlement and self-work calibration on every pass (issue 659), because the
 * stored and fold timestamps differed only in form ("...:28.000Z" vs
 * "...:28Z"). The maintenance script under test must count and delete exactly
 * those rows: CHANGE rows for SETTLEMENT or SELF_WORK_CALIBRATION whose
 * before and after states carry the same keys and differ only where timestamp
 * fields hold the same instant in two notations.
 */
let started: StartedPostgres;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
let runId: string;

const CREDITOR_ID = "00000000-0000-4000-8000-000000000001";
const DEBTOR_ID = "00000000-0000-4000-8000-000000000002";
const CALIBRATION_USER_ID = "00000000-0000-4000-8000-000000000003";

type State = Record<string, JSONValue>;

function settlementState(overrides: State = {}): State {
  return {
    githubIssueId: 501,
    githubPullRequestId: 601,
    creditorId: CREDITOR_ID,
    creditorGitHubLogin: "creditor",
    creditorGitHubUserId: 9001,
    debtorId: DEBTOR_ID,
    openingComparisonPoints: [{ criterion: "tests", points: 2 }],
    settledLabel: "actual-catalog",
    settledPoints: 12,
    settledLabelEventId: 7001,
    settledLabelActorLogin: "keeper",
    settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
    settledRationaleCommentId: 8001,
    settledRationaleActorLogin: "rater",
    settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
    mergeCommitOid: "a".repeat(40),
    mergedAt: "2026-09-01T12:00:00.000Z",
    reviewRounds: 1,
    credits: [{ userId: DEBTOR_ID, points: 12 }],
    proofSha256: "b".repeat(64),
    status: "SETTLED",
    ...overrides,
  };
}

function calibrationState(overrides: State = {}): State {
  return {
    githubIssueId: 502,
    githubPullRequestId: 602,
    userId: CALIBRATION_USER_ID,
    openingComparisonPoints: [],
    actualLabel: "actual-catalog",
    actualPoints: 5,
    actualLabelEventId: 7002,
    actualLabelActorLogin: "keeper",
    actualLabelAppliedAt: "2026-09-01T10:00:00.000Z",
    rationaleCommentId: 8002,
    rationaleActorLogin: "rater",
    rationaleCommentedAt: "2026-09-01T10:30:00.000Z",
    mergeCommitOid: "c".repeat(40),
    mergedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

interface SeedRow {
  name: string;
  entityKind: "SETTLEMENT" | "SELF_WORK_CALIBRATION" | "UNWRITABLE_CLOSURE" | "POLICY_VIOLATION" | "ISSUE";
  changeKind: string;
  before: JSONValue | null;
  after: JSONValue | null;
  spurious: boolean;
  id?: string;
}

function settlementWithoutKey(key: string): State {
  const state = settlementState();
  delete state[key];
  return state;
}

const seeds: SeedRow[] = [
  { name: "settlement mergedAt format only", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ mergedAt: "2026-09-01T12:00:00Z" }), spurious: true },
  { name: "settlement settledLabelAppliedAt format only", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledLabelAppliedAt: "2026-09-01T11:00:00Z" }), spurious: true },
  { name: "settlement settledRationaleCommentedAt format only", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledRationaleCommentedAt: "2026-09-01T11:30:00Z" }), spurious: true },
  { name: "settlement null label timestamps on both sides plus mergedAt format only", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState({ settledLabelAppliedAt: null, settledRationaleCommentedAt: null }),
    after: settlementState({ settledLabelAppliedAt: null, settledRationaleCommentedAt: null, mergedAt: "2026-09-01T12:00:00Z" }), spurious: true },
  { name: "settlement settledPoints differ", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledPoints: 13 }), spurious: false },
  { name: "settlement mergedAt one second apart", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ mergedAt: "2026-09-01T12:00:01.000Z" }), spurious: false },
  { name: "settlement settledLabelAppliedAt one second apart", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledLabelAppliedAt: "2026-09-01T11:00:01.000Z" }), spurious: false },
  { name: "settlement settledRationaleCommentedAt one second apart", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledRationaleCommentedAt: "2026-09-01T11:30:01.000Z" }), spurious: false },
  { name: "settlement mergedAt format only and settledPoints differ", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ mergedAt: "2026-09-01T12:00:00Z", settledPoints: 13 }), spurious: false },
  { name: "settlement settledLabel differs", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledLabel: "planned-catalog" }), spurious: false },
  { name: "settlement after_state missing a key", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementWithoutKey("settledLabelActorLogin"), spurious: false },
  { name: "settlement ADD with fold-form timestamps", entityKind: "SETTLEMENT", changeKind: "ADD",
    before: null, after: settlementState({ mergedAt: "2026-09-01T12:00:00Z" }), spurious: false },
  { name: "settlement REMOVE", entityKind: "SETTLEMENT", changeKind: "REMOVE",
    before: settlementState(), after: null, spurious: false },
  { name: "calibration mergedAt format only", entityKind: "SELF_WORK_CALIBRATION", changeKind: "CHANGE",
    before: calibrationState(), after: calibrationState({ mergedAt: "2026-09-01T12:00:00Z" }), spurious: true },
  { name: "calibration actualLabelAppliedAt format only", entityKind: "SELF_WORK_CALIBRATION", changeKind: "CHANGE",
    before: calibrationState(), after: calibrationState({ actualLabelAppliedAt: "2026-09-01T10:00:00Z" }), spurious: true },
  { name: "calibration rationaleCommentedAt format only", entityKind: "SELF_WORK_CALIBRATION", changeKind: "CHANGE",
    before: calibrationState(), after: calibrationState({ rationaleCommentedAt: "2026-09-01T10:30:00Z" }), spurious: true },
  { name: "calibration actualPoints differ", entityKind: "SELF_WORK_CALIBRATION", changeKind: "CHANGE",
    before: calibrationState(), after: calibrationState({ actualPoints: 6 }), spurious: false },
  { name: "calibration mergedAt one second apart", entityKind: "SELF_WORK_CALIBRATION", changeKind: "CHANGE",
    before: calibrationState(), after: calibrationState({ mergedAt: "2026-09-01T12:00:01.000Z" }), spurious: false },
  { name: "calibration rationaleCommentedAt one second apart", entityKind: "SELF_WORK_CALIBRATION", changeKind: "CHANGE",
    before: calibrationState(), after: calibrationState({ rationaleCommentedAt: "2026-09-01T10:30:01.000Z" }), spurious: false },
  { name: "policy violation row", entityKind: "POLICY_VIOLATION", changeKind: "POLICY_VIOLATION",
    before: null, after: { githubIssueId: 503, kind: "SPONSOR_ABSENCE", githubPullRequestId: null, reason: "no sponsor" }, spurious: false },
  { name: "unwritable closure CHANGE with a format-only difference", entityKind: "UNWRITABLE_CLOSURE", changeKind: "CHANGE",
    before: { githubIssueId: 504, kind: "SPONSOR_ABSENCE", githubPullRequestId: null, reason: "closed at 2026-09-01T12:00:00.000Z" },
    after: { githubIssueId: 504, kind: "SPONSOR_ABSENCE", githubPullRequestId: null, reason: "closed at 2026-09-01T12:00:00Z" }, spurious: false },
  // Each of the following pins ONE filter limb as the only reason the row is
  // kept (review fix round 1, item A): with the limb loosened, the row is
  // over-deleted and the byte-identical assertion fails.
  { name: "unwritable closure CHANGE kept only by its entity kind", entityKind: "UNWRITABLE_CLOSURE", changeKind: "CHANGE",
    before: { githubIssueId: 506, kind: "SPONSOR_ABSENCE", githubPullRequestId: null, reason: "closed", mergedAt: "2026-09-01T12:00:00.000Z" },
    after: { githubIssueId: 506, kind: "SPONSOR_ABSENCE", githubPullRequestId: null, reason: "closed", mergedAt: "2026-09-01T12:00:00Z" }, spurious: false },
  { name: "issue CHANGE kept only by its entity kind", entityKind: "ISSUE", changeKind: "CHANGE",
    before: { githubIssueId: 507, number: 7, title: "Issue", mergedAt: "2026-09-01T12:00:00.000Z" },
    after: { githubIssueId: 507, number: 7, title: "Issue", mergedAt: "2026-09-01T12:00:00Z" }, spurious: false },
  { name: "ADD with two object states kept only by its change kind", entityKind: "SETTLEMENT", changeKind: "ADD",
    before: settlementState(), after: settlementState({ mergedAt: "2026-09-01T12:00:00Z" }), spurious: false },
  { name: "CHANGE with both states null kept only by the object guards", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: null, after: null, spurious: false },
  // Guard-limb pins (review fix round 1, items E and F).
  { name: "sub-millisecond fraction is a real difference", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledLabelAppliedAt: "2026-09-01T11:00:00.0000001Z" }), spurious: false },
  { name: "a zone-less timestamp against a zoned one is a real difference", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState(), after: settlementState({ settledLabelAppliedAt: "2026-09-01T11:00:00" }), spurious: false },
  { name: "a regex-shaped invalid date against its valid notation is a real difference", entityKind: "SETTLEMENT", changeKind: "CHANGE",
    before: settlementState({ settledRationaleCommentedAt: "2026-13-45T00:00:00Z" }),
    after: settlementState({ settledRationaleCommentedAt: "2026-13-45T00:00:00.000Z" }), spurious: false },
];

const keeperIds = (): string[] => seeds.filter((seed) => !seed.spurious).map((seed) => seed.id!).sort();

async function allRows() {
  return sql`select * from reconciliation_changes order by recorded_seq`;
}

beforeAll(async () => {
  started = await startPostgresContainer({
    database: "prune_noop_test", user: "prune_noop_test", password: "prune_noop_test",
  });
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  const [run] = await sql<{ id: string }[]>`insert into reconciliation_runs default values returning id`;
  runId = run!.id;
  for (const seed of seeds) {
    const [inserted] = await sql<{ id: string }[]>`
      insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind, before_state, after_state)
      values (${runId}, ${seed.entityKind}::reconciliation_entity_kind, ${seed.changeKind},
        ${seed.before === null ? null : sql.json(seed.before)}, ${seed.after === null ? null : sql.json(seed.after)})
      returning id
    `;
    seed.id = inserted!.id;
  }
});

afterAll(async () => {
  await closeSql();
  await started?.container.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("pruning no-op reconciliation changes", () => {
  it("reports exactly the spurious counts per entity kind on a dry run and deletes nothing", async () => {
    const lines: string[] = [];
    const exit = await runPruneNoopReconciliationChangesCli([], { write: (line) => lines.push(line), sql });
    expect(exit).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { entityKind: "SETTLEMENT", count: 4 },
      { entityKind: "SELF_WORK_CALIBRATION", count: 3 },
      { executed: false, deleted: 0, matched: 7 },
    ]);
    expect(await allRows()).toHaveLength(seeds.length);
  });

  it("deletes exactly the spurious ids in id-ordered pages and leaves every other row byte-identical", async () => {
    const before = await allRows();
    const lines: string[] = [];
    const exit = await runPruneNoopReconciliationChangesCli(["--execute", "--batch-size", "2"],
      { write: (line) => lines.push(line), sql });
    expect(exit).toBe(0);
    const parsed = lines.map((line) => JSON.parse(line));
    const batchLines = parsed.slice(0, -1);
    expect(parsed.at(-1)).toEqual({ executed: true, deleted: 7, matched: 7 });
    // 28 seeded rows at batch size 2: fourteen full pages, then the empty
    // terminal page. Every row is scanned exactly once (keyset pagination).
    expect(batchLines).toHaveLength(15);
    expect(batchLines.map((line) => line.batch)).toEqual(batchLines.map((_, index) => index + 1));
    expect(batchLines.map((line) => line.scanned)).toEqual([...Array(14).fill(2), 0]);
    let running = 0;
    for (const line of batchLines) {
      running += line.deleted;
      expect(line.total).toBe(running);
      expect(line.deleted).toBeLessThanOrEqual(line.scanned);
    }
    expect(running).toBe(7);
    expect(batchLines.at(-1)).toEqual({ batch: 15, scanned: 0, deleted: 0, total: 7 });
    const remaining = await allRows();
    expect(remaining.map((row) => row.id).sort()).toEqual(keeperIds());
    expect(remaining).toEqual(before.filter((row) => keeperIds().includes(row.id)));
  });

  it("deletes nothing on a second execute", async () => {
    const before = await allRows();
    const lines: string[] = [];
    const exit = await runPruneNoopReconciliationChangesCli(["--execute", "--batch-size", "5"],
      { write: (line) => lines.push(line), sql });
    expect(exit).toBe(0);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { batch: 1, scanned: 5, deleted: 0, total: 0 },
      { batch: 2, scanned: 5, deleted: 0, total: 0 },
      { batch: 3, scanned: 5, deleted: 0, total: 0 },
      { batch: 4, scanned: 5, deleted: 0, total: 0 },
      { batch: 5, scanned: 1, deleted: 0, total: 0 },
      { batch: 6, scanned: 0, deleted: 0, total: 0 },
      { executed: true, deleted: 0, matched: 0 },
    ]);
    expect(await allRows()).toEqual(before);
  });

  it("prints usage and exits 0 for --help", async () => {
    const lines: string[] = [];
    expect(await runPruneNoopReconciliationChangesCli(["--help"], { write: (line) => lines.push(line) })).toBe(0);
    expect(lines).toHaveLength(1);
  });

  it("exits 2 for unknown or malformed arguments", async () => {
    const lines: string[] = [];
    const rejections = [
      ["--execute", "extra"],
      ["--dry-run"],
      ["--batch-size", "2"],
      ["--execute", "--batch-size", "0"],
      ["--execute", "--batch-size", "-3"],
      ["--execute", "--batch-size", "2.5"],
      ["--execute", "--batch-size", "abc"],
      ["--execute", "--batch-size"],
      ["--execute", "--batch-size", "2", "--batch-size", "3"],
      ["--execute", "--help"],
      ["--help", "--execute"],
      ["--execute", "--batch-size", "99999999999999999999"],
    ];
    for (const argumentsList of rejections) {
      expect(await runPruneNoopReconciliationChangesCli(argumentsList, { write: (line) => lines.push(line) }),
        argumentsList.join(" ")).toBe(2);
    }
  });

  it("reports a database failure as one JSON failure line carrying the cause, with exit 1", async () => {
    // One shared rejection, marked handled: the CLI embeds the predicate
    // fragment before awaiting the outer query, so a naive per-call
    // Promise.reject would leave the embedded fragment unhandled.
    const failure = Promise.reject(new Error("synthetic database failure"));
    failure.catch(() => {});
    const failing = (() => failure) as unknown as Sql;
    const dryRunLines: string[] = [];
    expect(await runPruneNoopReconciliationChangesCli([], { write: (line) => dryRunLines.push(line), sql: failing })).toBe(1);
    expect(dryRunLines).toHaveLength(1);
    expect(JSON.parse(dryRunLines[0]!)).toEqual({ failure: "PRUNE_FAILED", reason: "synthetic database failure" });
    const executeLines: string[] = [];
    expect(await runPruneNoopReconciliationChangesCli(["--execute", "--batch-size", "2"],
      { write: (line) => executeLines.push(line), sql: failing })).toBe(1);
    expect(executeLines).toHaveLength(1);
    expect(JSON.parse(executeLines[0]!)).toEqual({ failure: "PRUNE_FAILED", reason: "synthetic database failure" });
  });
});
