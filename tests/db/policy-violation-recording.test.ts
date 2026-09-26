import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import type { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { FoldPolicyViolation, FoldResult } from "@/lib/fold/repository-fold";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * Issue 713: a fold reports every policy violation that currently holds, so
 * recording the fold's list on every run appended the same rows again on each
 * pass. A violation is recorded when it newly appears for its repository, and
 * again only after it has vanished and come back.
 */
let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

const mutated: FoldPolicyViolation = { code: "OPENING_LABEL_MUTATED", githubIssueId: 71_301 };
const missing: FoldPolicyViolation = { code: "OPENING_LABEL_MISSING", githubIssueId: 71_302 };
const unauthorized: FoldPolicyViolation = {
  code: "OPENING_LABEL_UNAUTHORIZED",
  githubIssueId: 71_303,
  openingLabel: "M",
  openingSourceActorLogin: "someone-else",
  reason: "The opening label `M` was applied by `someone-else`, not by the repository sponsor.",
};

describe("policy violations are recorded when they newly appear", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "policy_violation_test", user: "policy_violation_test", password: "policy_violation_test",
    });
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

  it("records each violation once and nothing when the repository is reconciled again unchanged", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);

    const first = await reconcile(store, repositoryId, fold, [mutated, unauthorized, mutated]);
    expect(await violationsRecordedBy(first)).toEqual([mutated, unauthorized]);

    // The same set in another order and with its keys in another order: jsonb
    // equality, not the serialized text, decides whether it is unchanged.
    const reordered = { reason: unauthorized.reason, openingSourceActorLogin: "someone-else", openingLabel: "M",
      githubIssueId: 71_303, code: "OPENING_LABEL_UNAUTHORIZED" } as FoldPolicyViolation;
    const second = await reconcile(store, repositoryId, fold, [reordered, mutated]);
    expect(await violationsRecordedBy(second)).toEqual([]);
  });

  it("records only the violation that is new on a later run", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    await reconcile(store, repositoryId, fold, [mutated]);

    const second = await reconcile(store, repositoryId, fold, [mutated, missing]);
    expect(await violationsRecordedBy(second)).toEqual([missing]);
  });

  it("records a violation again when it reappears after a run without it", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    await reconcile(store, repositoryId, fold, [mutated, missing]);

    const withoutIt = await reconcile(store, repositoryId, fold, [missing]);
    expect(await violationsRecordedBy(withoutIt)).toEqual([]);

    const reappeared = await reconcile(store, repositoryId, fold, [mutated, missing]);
    expect(await violationsRecordedBy(reappeared)).toEqual([mutated]);
  });

  it("tracks two repositories reporting the same violation independently", async () => {
    const left = await materializeRepositoryFixture(sql);
    const right = await materializeRepositoryFixture(sql);

    expect(await violationsRecordedBy(await reconcile(left.store, left.repositoryId, left.fold, [mutated])))
      .toEqual([mutated]);
    expect(await violationsRecordedBy(await reconcile(right.store, right.repositoryId, right.fold, [mutated])))
      .toEqual([mutated]);

    // Clearing it on one repository neither clears nor re-records it on the other.
    await reconcile(right.store, right.repositoryId, right.fold, []);
    expect(await violationsRecordedBy(await reconcile(left.store, left.repositoryId, left.fold, [mutated])))
      .toEqual([]);
    expect(await violationsRecordedBy(await reconcile(right.store, right.repositoryId, right.fold, [mutated])))
      .toEqual([mutated]);
  });

  it("records a violation larger than a btree index row once, and not again when it is unchanged", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    // Hash hex does not compress, so the stored jsonb stays over 4 kB: above the
    // roughly 2.7 kB a btree index row may hold, which a key on the raw
    // violation would refuse.
    const prose = Array.from({ length: 64 }, (_, index) => createHash("sha256").update(String(index)).digest("hex")).join("");
    const large: FoldPolicyViolation = { ...unauthorized, githubIssueId: 71_304, reason: prose };

    expect(await violationsRecordedBy(await reconcile(store, repositoryId, fold, [large]))).toEqual([large]);
    expect(await violationsRecordedBy(await reconcile(store, repositoryId, fold, [large]))).toEqual([]);
  });

  it("leaves the stored set as it was when the run's publication fails after recording", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    await reconcile(store, repositoryId, fold, [mutated]);

    // A cost charged to a sponsor that does not exist fails on the usage
    // insert, which the publication performs after the violations: the whole
    // transaction, the violation bookkeeping included, rolls back.
    const failedRun = await store.beginRun(repositoryId);
    const sequenceBefore = await recordedSequenceValue();
    await expect(store.withRepositoryReconciliation(repositoryId, () => store.materialize({
      repositoryId, runId: failedRun, fold: withViolations(fold, [missing]),
      cost: { sponsorId: randomUUID(), completedAt: new Date(), observedCost: null, observedResponses: 0, unmeasuredResponses: 0 },
    }))).rejects.toThrow(/foreign key/);
    expect(await violationsRecordedBy(failedRun)).toEqual([]);
    // A sequence is not rolled back, so the one `recorded_seq` value the
    // failed run drew shows its recording of `missing` executed before the
    // failure. Without it this case would pass vacuously if the failure moved
    // ahead of the recording.
    expect(await recordedSequenceValue()).toBe(sequenceBefore + 1n);

    // `mutated` is still stored (the failed run did not remove it) and
    // `missing` is not (the failed run did not add it).
    const next = await reconcile(store, repositoryId, fold, [mutated, missing]);
    expect(await violationsRecordedBy(next)).toEqual([missing]);
  });
});

async function reconcile(store: PostgresFoldStore, repositoryId: string, fold: FoldResult, violations: FoldPolicyViolation[]) {
  const runId = await store.beginRun(repositoryId);
  await store.withRepositoryReconciliation(repositoryId, () => store.materialize({
    repositoryId, runId, fold: withViolations(fold, violations),
  }));
  return runId;
}

function withViolations(fold: FoldResult, policyViolations: FoldPolicyViolation[]): FoldResult {
  return { ...fold, policyViolations };
}

/** The last value drawn for `reconciliation_changes.recorded_seq`, committed or not. */
async function recordedSequenceValue(): Promise<bigint> {
  const [row] = await sql<{ value: string }[]>`
    select pg_sequence_last_value(pg_get_serial_sequence('reconciliation_changes', 'recorded_seq')::regclass)::text as value
  `;
  return BigInt(row!.value);
}

/** The violations a run recorded, in the order it recorded them, with the shape every such row has. */
async function violationsRecordedBy(runId: string) {
  const rows = await sql<{
    entity_kind: string; change_kind: string; pull_request_id: string | null; before_state: unknown; after_state: unknown;
  }[]>`
    select entity_kind, change_kind, pull_request_id, before_state, after_state
    from reconciliation_changes
    where reconciliation_run_id = ${runId} and entity_kind = ${"POLICY_VIOLATION"}
    order by recorded_seq
  `;
  for (const row of rows) {
    expect(row).toMatchObject({ change_kind: "POLICY_VIOLATION", pull_request_id: null, before_state: null });
  }
  return rows.map((row) => row.after_state);
}
