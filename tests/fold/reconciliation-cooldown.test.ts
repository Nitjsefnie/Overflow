import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { encryptToken } from "@/lib/security/token-cipher";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 9_500_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 25).toString("base64url");
const notBefore = new Date("2030-01-02T04:04:05.678Z");

describe("persisted reconciliation cooldown", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "cooldown", user: "cooldown", password: "cooldown" });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
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

  it("defers a cooled-down repository's job without gateway calls or run rows", async () => {
    const fixture = await cooledRepository();
    const { store, repositoryId, github, calls } = fixture;
    const folded: string[] = [];
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    await store.enqueueReconciliationJob(repositoryId, "SWEEP");
    const outcome = await runNextReconciliationJob({
      store,
      now,
      // Recorded so the assertions below stand on this repository's own job
      // rather than on whichever job the worker happened to claim.
      reconcile: async (id) => {
        folded.push(id);
        return reconcileRepository({ store, github, now }, id);
      },
    });
    expect(folded).toEqual([repositoryId]);
    expect(calls).toEqual([]);
    expect(await runs(repositoryId)).toEqual([]);
    expect(outcome).toBe("DEFERRED");
    expect(await store.getReconciliationCooldown(repositoryId)).toEqual(notBefore);
    expect(await jobs(repositoryId)).toEqual([
      { state: "PENDING", attempt_count: 0, run_after: notBefore },
    ]);
  });

  it.each([
    { offset: -1, outcome: "DEFERRED", gatewayCalls: [], runRows: [], jobRows: [{ state: "PENDING", attempt_count: 0, run_after: notBefore }] },
    { offset: 0, outcome: "RECONCILED", gatewayCalls: ["identity", "issues"], runRows: [{ status: "COMPLETED" }], jobRows: [] },
    { offset: 1, outcome: "RECONCILED", gatewayCalls: ["identity", "issues"], runRows: [{ status: "COMPLETED" }], jobRows: [] },
  ])("checks the worker's expiry boundary at offset $offset ms", async ({ offset, outcome, gatewayCalls, runRows, jobRows }) => {
    const { store, repositoryId, github, calls } = await cooledRepository();
    const folded: string[] = [];
    const now = () => new Date(notBefore.getTime() + offset);
    await store.enqueueReconciliationJob(repositoryId, "SWEEP");
    const result = await runNextReconciliationJob({
      store,
      now,
      reconcile: (id) => {
        folded.push(id);
        return reconcileRepository({ store, github, now }, id);
      },
    });
    expect(folded).toEqual([repositoryId]);
    expect(result).toBe(outcome);
    expect(calls).toEqual(gatewayCalls);
    expect(await runs(repositoryId)).toEqual(runRows);
    expect(await jobs(repositoryId)).toEqual(jobRows);
    expect(await store.getReconciliationCooldown(repositoryId)).toEqual(outcome === "DEFERRED" ? notBefore : null);
  });

  it("reads a contender's cooldown after acquiring the real repository lock", async () => {
    const { store, repositoryId, github, calls } = await cooledRepository();
    await store.setReconciliationCooldown(repositoryId, null);
    await store.enqueueReconciliationJob(repositoryId, "SWEEP");
    const ownerAcquired = signal();
    const releaseOwner = signal();
    const contenderBlocked = signal();
    const contenderSql = postgres(process.env.DATABASE_URL!, {
      transform: {
        row: (row) => {
          // Observe PostgreSQL rejecting the contender's real lock attempt; preserve every row.
          if (row.acquired === false) contenderBlocked.resolve();
          return row;
        },
      },
    });
    // Coordination has its own pool, so the contender's client has to be given as
    // the coordination client too for the row transform to see the lock attempt.
    const contenderStore = new PostgresFoldStore(contenderSql, tokenEncryptionKey, contenderSql);
    const owner = store.withRepositoryReconciliation(repositoryId, async () => {
      ownerAcquired.resolve();
      await releaseOwner.promise;
    });
    const folded: string[] = [];
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    let contender: ReturnType<typeof runNextReconciliationJob> | undefined;
    try {
      await Promise.race([ownerAcquired.promise, owner]);
      contender = runNextReconciliationJob({
        store,
        now,
        reconcile: (id) => {
          folded.push(id);
          return reconcileRepository({ store: contenderStore, github, now }, id);
        },
      });
      await Promise.race([
        contenderBlocked.promise,
        contender.then(() => { throw new Error("Contender completed without waiting for the owner lock."); }),
      ]);
      // The job was claimed and the fold entered before any cooldown existed, so
      // only a read taken under the lock can see the one set below.
      expect(folded).toEqual([repositoryId]);
      expect(calls).toEqual([]);
      expect(await runs(repositoryId)).toEqual([]);
      await store.setReconciliationCooldown(repositoryId, notBefore);
      releaseOwner.resolve();
      await owner;
      const outcome = await contender;
      expect(calls).toEqual([]);
      expect(await runs(repositoryId)).toEqual([]);
      expect(await store.getReconciliationCooldown(repositoryId)).toEqual(notBefore);
      expect(outcome).toBe("DEFERRED");
      expect(await jobs(repositoryId)).toEqual([
        { state: "PENDING", attempt_count: 0, run_after: notBefore },
      ]);
    } finally {
      releaseOwner.resolve();
      await Promise.allSettled([owner, contender]);
      await contenderSql.end();
    }
  });

  it.each([0, 1])("creates no run for a cooled-down repository, then reconciles at expiry plus %s ms and clears it", async (offset) => {
    const { store, repositoryId, github, calls } = await cooledRepository();
    let instant = new Date("2030-01-02T03:04:05.678Z");
    const now = () => instant;
    const reconcile = () => reconcileRepository({ store, github, now }, repositoryId);

    await expect(reconcile()).resolves.toMatchObject({ skipped: true });
    expect(await runs(repositoryId)).toEqual([]);
    expect(calls).toEqual([]);
    expect(await store.getReconciliationCooldown(repositoryId)).toEqual(notBefore);

    instant = new Date(notBefore.getTime() + offset);
    await expect(reconcile()).resolves.toMatchObject({ skipped: false });
    expect(await runs(repositoryId)).toEqual([{ status: "COMPLETED" }]);
    expect(calls).toEqual(["identity", "issues"]);
    await expect(sql`
      select reconciliation_not_before from registered_repositories where id = ${repositoryId}
    `).resolves.toEqual([{ reconciliation_not_before: null }]);
  });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function runs(repositoryId: string) {
  return sql`select status from reconciliation_runs where repository_id = ${repositoryId}`;
}

async function jobs(repositoryId: string) {
  return sql`
    select state, attempt_count, run_after
    from repository_reconciliation_jobs where repository_id = ${repositoryId}
  `;
}

async function cooledRepository() {
  const githubRepositoryId = externalId++;
  const ownerName = `cooldown/repo-${githubRepositoryId}`;
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${externalId++}, ${`sponsor-${githubRepositoryId}`},
      ${Buffer.from(encryptToken("cooldown-token", tokenEncryptionKey), "utf8")}) returning id
  `;
  const difficultyScheme = {
    openingName: "Size", actualName: "Delivered",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
  const [{ id: repositoryId }] = await sql<{ id: string }[]>`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${githubRepositoryId}, ${ownerName}, ${sponsorId}, 'PUBLIC', ${externalId++}, ${sql.json(difficultyScheme)})
    returning id
  `;
  const store = new PostgresFoldStore(sql, tokenEncryptionKey);
  await store.setReconciliationCooldown(repositoryId, notBefore);
  const calls: string[] = [];
  const verifyIdentity = verifiedRepositoryAt(ownerName);
  const github: ReconciliationGateway = {
    // Counted like every other read, so an empty array proves no GitHub traffic at
    // all under cooldown rather than only no crawl traffic.
    getRepositoryById: async (githubRepositoryId) => {
      calls.push("identity");
      return verifyIdentity(githubRepositoryId);
    },
    listIssues: async () => { calls.push("issues"); return []; },
    getPullRequestReviews: async () => { calls.push("reviews"); return []; },
    getPullRequestDiff: async () => { calls.push("diff"); return ""; },
  };
  return { store, repositoryId, githubRepositoryId, ownerName, github, calls };
}
