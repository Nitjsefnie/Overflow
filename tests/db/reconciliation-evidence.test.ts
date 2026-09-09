import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { RECONCILIATION_EVIDENCE_FORMAT } from "@/lib/fold/reconciliation-evidence";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { GitHubIssue } from "@/lib/github/types";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const first = new Date("2026-09-08T09:00:00Z");
const second = new Date("2026-09-08T09:02:00Z");

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "evidence", user: "evidence", password: "evidence" });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("durable reconciliation evidence", () => {
  // Mutants: DROP_SUBJECT_ID, IGNORE_MERGED_PR_REVIEW, FOREIGN_NUMBER_COLLISION.
  it("persists issue and merged-PR review invalidations independently per repository", async () => {
    const one = await materializeRepositoryFixture(sql);
    const two = await materializeRepositoryFixture(sql);
    const issue = await delivery(one.repositoryId, "ISSUE");
    const review = await delivery(one.repositoryId, "PULL_REQUEST");
    await one.store.enqueueWebhookReconciliation(one.repositoryId, issue);
    await one.store.enqueueWebhookReconciliation(one.repositoryId, review);
    const captured = await one.store.getDirtyReconciliationSubjects(one.repositoryId);
    await one.store.enqueueWebhookReconciliation(one.repositoryId, review);
    await two.store.enqueueWebhookReconciliation(two.repositoryId, await delivery(two.repositoryId, "ISSUE"));
    const latest = await one.store.getDirtyReconciliationSubjects(one.repositoryId);
    expect(latest.map(({ kind, id, number }) => ({ kind, id, number }))).toEqual([
      { kind: "ISSUE", id: 101, number: 1 }, { kind: "PULL_REQUEST", id: 201, number: 1 },
    ]);
    expect(latest[1]!.generation).toBeGreaterThan(captured[1]!.generation);
    expect(await sql`select repository_id, reason from repository_reconciliation_jobs order by repository_id`)
      .toEqual([one.repositoryId, two.repositoryId].sort().map((repository_id) => ({ repository_id, reason: "WEBHOOK" })));
    await one.store.withRepositoryReconciliation(one.repositoryId, async () => one.store.materialize({ repositoryId: one.repositoryId, runId: await one.store.beginRun(one.repositoryId),
      fold: one.fold, synchronization: { ...synchronization(), dirtySubjects: captured } }));
    expect(await one.store.getDirtyReconciliationSubjects(one.repositoryId)).toEqual([latest[1]]);
    expect(await two.store.getDirtyReconciliationSubjects(two.repositoryId)).toHaveLength(1);
    await expect(one.store.enqueueWebhookReconciliation(one.repositoryId, await delivery(two.repositoryId, "ISSUE")))
      .rejects.toThrow(/repository/i);
  });

  // Mutants: ENQUEUE_BEFORE_DIRTY_WRITE, CACHE_OUTSIDE_TRANSACTION.
  it.each(["repository_reconciliation_dirty_subjects", "repository_reconciliation_jobs"])(
    "commits neither invalidation nor enqueue when %s fails", async (table) => {
      const { store, repositoryId } = await materializeRepositoryFixture(sql);
      const event = await delivery(repositoryId, "ISSUE");
      await sql`create function reject_webhook_test_write() returns trigger language plpgsql as $$
        begin raise exception 'injected webhook write failure'; end $$`;
      await sql`create trigger reject_webhook_test_write before insert on ${sql(table)}
        for each row execute function reject_webhook_test_write()`;
      try {
        await expect(store.enqueueWebhookReconciliation(repositoryId, event)).rejects.toThrow(/injected webhook write failure/);
      } finally {
        await sql`drop trigger reject_webhook_test_write on ${sql(table)}`;
        await sql`drop function reject_webhook_test_write()`;
      }
      expect(await store.getDirtyReconciliationSubjects(repositoryId)).toEqual([]);
      expect(await sql`select id from repository_reconciliation_jobs where repository_id = ${repositoryId}`).toEqual([]);
    },
  );

  // Mutant: RESTART_LOSES_CACHE; derived rows must never stand in for upstream evidence.
  it("starts cold even when derived rows exist, and persists complete evidence across store restarts", async () => {
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    expect(await store.getReconciliationEvidence(repositoryId)).toBeNull();
    expect(await store.getDirtyReconciliationSubjects(repositoryId)).toEqual([]);
    const runId = await store.beginRun(repositoryId);
    await store.withRepositoryReconciliation(repositoryId, async () => store.setReconciliationCooldown(repositoryId, second));
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId, fold, synchronization: synchronization() }));
    const restarted = new PostgresFoldStore(sql);
    expect(await restarted.getReconciliationEvidence(repositoryId)).toEqual({
      version: 1, formatVersion: RECONCILIATION_EVIDENCE_FORMAT, checkpoint: first, lastFullPassAt: first,
      issues: [rawIssue()], pullRequests: [{ id: 201, reviews: [], rawDiff: "retained diff" }],
    });
    expect(await restarted.getReconciliationCooldown(repositoryId)).toBeNull();
    expect(await sql`select status from reconciliation_runs where id = ${runId}`).toEqual([{ status: "COMPLETED" }]);
  });

  // Mutants: KEEP_FULL_PASS_ABSENT_ISSUE, ADVANCE_FULL_AGE_ON_FAILURE.
  it("replaces the complete cache and advances full age only for a full synchronization", async () => {
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold, synchronization: synchronization() }));
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold,
      synchronization: { ...synchronization(), expectedVersion: 1, scanStartedAt: second, full: false,
        issues: [{ ...rawIssue(), body: "edited" }], pullRequests: [] } }));
    expect(await store.getReconciliationEvidence(repositoryId)).toMatchObject({
      version: 2, checkpoint: second, lastFullPassAt: first, issues: [{ body: "edited" }], pullRequests: [],
    });
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold,
      synchronization: { ...synchronization(), expectedVersion: 2, scanStartedAt: second, issues: [], pullRequests: [] } }));
    expect(await store.getReconciliationEvidence(repositoryId)).toMatchObject({
      version: 3, checkpoint: second, lastFullPassAt: second, issues: [], pullRequests: [],
    });
  });

  // Mutant: ACCEPT_STALE_CACHE_VERSION.
  it.each([null, 0, 2])("rejects a stale publisher expecting version %s without modifying any committed state", async (expectedVersion) => {
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold, synchronization: synchronization() }));
    const before = await store.getReconciliationEvidence(repositoryId);
    const runId = await store.beginRun(repositoryId);
    await expect(store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId, fold: { ...fold, issues: [], pullRequests: [],
      settlements: [], selfWorkCalibrations: [], unwritableClosures: [] },
    synchronization: { ...synchronization(), expectedVersion, scanStartedAt: second } }))).rejects.toThrow(/stale/i);
    expect(await store.getReconciliationEvidence(repositoryId)).toEqual(before);
    expect(await sql`select status from reconciliation_runs where id = ${runId}`).toEqual([{ status: "PENDING" }]);
    expect(await sql`select count(*)::int as count from issues where repository_id = ${repositoryId}`).toEqual([{ count: 3 }]);
  });

  // Mutants: ACK_ALL_DIRTY_GENERATIONS, DROP_MIDPASS_INVALIDATION.
  it("acknowledges exact captured generations while preserving newer and newly arrived subjects", async () => {
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    const firstGeneration = await dirty(repositoryId, 101);
    await dirty(repositoryId, 102);
    const captured = await store.getDirtyReconciliationSubjects(repositoryId);
    expect(captured).toEqual(expect.arrayContaining([{ kind: "ISSUE", id: 101, number: 1, generation: firstGeneration }]));
    const newer = await dirty(repositoryId, 101);
    await dirty(repositoryId, 103);
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold,
      synchronization: { ...synchronization(), dirtySubjects: captured } }));
    expect((await store.getDirtyReconciliationSubjects(repositoryId)).map(({ id, generation }) => ({ id, generation })))
      .toEqual([{ id: 101, generation: newer }, { id: 103, generation: newer + 1 }]);
    // Delete/reinsert must not recycle a generation an older pass still holds.
    const current = await store.getDirtyReconciliationSubjects(repositoryId);
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold,
      synchronization: { ...synchronization(), expectedVersion: 1, dirtySubjects: current } }));
    const reinserted = await dirty(repositoryId, 101);
    expect(reinserted).toBeGreaterThan(newer);
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold,
      synchronization: { ...synchronization(), expectedVersion: 2, dirtySubjects: current } }));
    expect(await store.getDirtyReconciliationSubjects(repositoryId)).toEqual([
      { kind: "ISSUE", id: 101, number: 1, generation: reinserted },
    ]);
  });

  // Mutants: CACHE_OUTSIDE_TRANSACTION, WATERMARK_BEFORE_MATERIALIZE,
  // POSTCOMMIT_COOLDOWN_RELABELS_SUCCESS_FAILED, CHECKPOINT_COMMITS_BEFORE_RUN_SUCCESS.
  it.each(["materialization", "cooldown", "run completion"])("rolls back evidence, acknowledgements and derived changes on %s failure", async (failure) => {
    const { store, repositoryId, fold } = await materializeRepositoryFixture(sql);
    await store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold, synchronization: synchronization() }));
    await store.withRepositoryReconciliation(repositoryId, async () => store.setReconciliationCooldown(repositoryId, second));
    await dirty(repositoryId, 101);
    const captured = await store.getDirtyReconciliationSubjects(repositoryId);
    const before = await store.getReconciliationEvidence(repositoryId);
    const runId = await store.beginRun(repositoryId);
    const table = failure === "materialization" ? "issues" : failure === "cooldown" ? "registered_repositories" : "reconciliation_runs";
    const column = failure === "materialization" ? "title" : failure === "cooldown" ? "reconciliation_not_before" : "status";
    await sql`create function reject_evidence_test_write() returns trigger language plpgsql as $$
      begin raise exception 'injected atomic completion failure'; end $$`;
    await sql`create trigger reject_evidence_test_write before update of ${sql(column)} on ${sql(table)}
      for each row execute function reject_evidence_test_write()`;
    try {
      await expect(store.withRepositoryReconciliation(repositoryId, async () => store.materialize({ repositoryId, runId,
        fold: { ...fold, issues: fold.issues.map((issue) => ({ ...issue, title: "changed" })) },
        synchronization: { ...synchronization(), expectedVersion: 1, scanStartedAt: second,
          issues: [], dirtySubjects: captured } }))).rejects.toThrow(/injected atomic completion failure/);
    } finally {
      await sql`drop trigger reject_evidence_test_write on ${sql(table)}`;
      await sql`drop function reject_evidence_test_write()`;
    }
    expect(await store.getReconciliationEvidence(repositoryId)).toEqual(before);
    expect(await store.getDirtyReconciliationSubjects(repositoryId)).toEqual(captured);
    expect(await store.getReconciliationCooldown(repositoryId)).toEqual(second);
    expect(await sql`select distinct title from issues where repository_id = ${repositoryId}`).toEqual([{ title: "Revision fixture" }]);
    expect(await sql`select status from reconciliation_runs where id = ${runId}`).toEqual([{ status: "PENDING" }]);
  });
});

function synchronization() {
  return { expectedVersion: null as number | null, scanStartedAt: first, full: true,
    issues: [rawIssue()], pullRequests: [{ id: 201, reviews: [], rawDiff: "retained diff" }],
    dirtySubjects: [] as Array<{ kind: "ISSUE" | "PULL_REQUEST"; id: number; number: number; generation: number }> };
}

function rawIssue(): GitHubIssue {
  return { id: 101, number: 1, title: "Unpriced raw issue", body: "Raw body", url: "https://github.com/octo/repo/issues/1",
    state: "OPEN", stateReason: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-08T08:00:00Z", closedAt: null,
    authorLogin: null, authorGitHubUserId: null, labels: [], claimAssigneeGitHubLogin: null,
    claimAssigneeGitHubUserId: null,
    history: [], comments: [], closingPullRequests: [] };
}

async function dirty(repositoryId: string, id: number): Promise<number> {
  const [row] = await sql`insert into repository_reconciliation_dirty_subjects
    (repository_id, kind, github_subject_id, subject_number) values (${repositoryId}, 'ISSUE', ${id}, 1)
    on conflict (repository_id, kind, github_subject_id) do update
    set generation = nextval('repository_reconciliation_dirty_generation') returning generation`;
  return Number(row.generation);
}

async function delivery(repositoryId: string, kind: "ISSUE" | "PULL_REQUEST"): Promise<GitHubWebhookDelivery> {
  const [repository] = await sql`select github_repository_id, owner_name from registered_repositories where id = ${repositoryId}`;
  return { deliveryId: `delivery-${repositoryId}-${kind}`, event: kind === "ISSUE" ? "issues" : "pull_request_review",
    action: kind === "ISSUE" ? "edited" : "dismissed", repositoryGitHubId: Number(repository.github_repository_id),
    repositoryFullName: repository.owner_name, subject: { kind, id: kind === "ISSUE" ? 101 : 201, number: 1 } };
}
