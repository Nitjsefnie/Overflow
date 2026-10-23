#!/usr/bin/env node
// Real production SQL workloads. Setup, migration and postcondition reads are
// outside the counter; every postgres.js debug callback inside the operation
// counts, including transaction and reconciliation coordination statements.
import { readEnv } from "../src/lib/env.ts";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import postgres, { type Sql } from "postgres";
import { listEligibleIssues } from "../src/lib/dashboard/eligible-issues.ts";
import type { DashboardSql } from "../src/lib/dashboard/queries.ts";
import { PostgresFoldStore } from "../src/lib/fold/postgres-store.ts";
import { reconcileRepository, type ReconciliationGateway } from "../src/lib/fold/reconcile.ts";
import { createReconciliationBudgetGate } from "../src/lib/fold/reconciliation-budget.ts";
import { createGitHubGraphqlBudgetStore } from "../src/lib/github/rate-limit-budget.ts";
import type { GitHubIssue } from "../src/lib/github/types.ts";
import { PostgresRepositoryStore } from "../src/lib/repositories/postgres-store.ts";
import { credentialBinding, encryptToken } from "../src/lib/security/token-cipher.ts";
import { processWebhook } from "../src/lib/webhooks/processor.ts";
import { createGitHubWebhookPostHandler } from "../src/app/api/github/webhooks/route.ts";
import { planSeedWorld, seedBoardBenchmark, type SeedOptions } from "./seed-board-benchmark.ts";
import type { Measurements } from "./check-perf-budget.ts";

const BOARD_WORLD: SeedOptions = {
  repositories: 3, openIssues: 650, sponsors: 6, settlementsPerSponsor: 1, underwaterRepos: 1,
};
const boardMemberId = planSeedWorld(BOARD_WORLD).memberUserId;
const SMALL_WORLD = planSeedWorld({
  repositories: 1, openIssues: 1, sponsors: 2, settlementsPerSponsor: 1, underwaterRepos: 0,
});
const sponsor = SMALL_WORLD.users[0]!;
const author = SMALL_WORLD.users[1]!;
const repository = SMALL_WORLD.repositories[0]!;
const observedRepository = {
  owner: "perf", name: "repository", fullName: "perf/repository", id: repository.githubRepositoryId,
  ownerType: "USER" as const, visibility: "PUBLIC" as const,
  url: "https://example.invalid/perf/repository", canAdminister: true,
};
const issue: GitHubIssue = {
  id: SMALL_WORLD.issues[0]!.githubIssueId, number: 1, title: "Performance fixture", body: "One opening",
  url: "https://example.invalid/perf/repository/issues/1", state: "OPEN", stateReason: null,
  createdAt: "2025-09-01T00:00:00.000Z", updatedAt: "2025-09-01T00:01:00.000Z", closedAt: null,
  authorLogin: author.login, authorGitHubUserId: author.githubUserId, labels: ["S"],
  claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null, comments: [], closingPullRequests: [],
  history: [{ kind: "LABELED", id: "opening", label: "S", actorLogin: sponsor.login,
    actorGitHubUserId: sponsor.githubUserId, createdAt: "2025-09-01T00:00:30.000Z" }],
};
// Fixture credentials are constructed at runtime and authenticate no service.
const encryptionKey = Buffer.alloc(32, 7).toString("base64url");
const fixtureSecret = createHash("sha256").update("overflow-perf:webhook-fixture").digest("hex");
const fixtureToken = createHash("sha256").update("overflow-perf:oauth-fixture").digest("base64url");
const credentialId = SMALL_WORLD.memberUserId.split("-")
  .map((part, index) => index === 2 ? "4000" : index === 3 ? "8000" : part).join("-");
const failRemoteRead = async (): Promise<never> => { throw new Error("Unexpected remote fixture read"); };
const gateway: ReconciliationGateway = {
  getRepositoryById: async () => observedRepository,
  listIssues: async () => [issue],
  getIssue: failRemoteRead, getPullRequestClosingIssues: failRemoteRead,
  getPullRequestReviews: failRemoteRead, getPullRequestDiff: failRemoteRead,
};

async function seedMinimal(sql: Sql): Promise<void> {
  // This client can only point at the database created below, never the caller's.
  await sql.unsafe(`do $$ declare table_name text; begin
    for table_name in select tablename from pg_tables
      where schemaname = 'public' and tablename <> 'schema_migrations'
    loop execute format('truncate table %I restart identity cascade', table_name); end loop;
  end $$`);
  for (const user of [sponsor, author]) {
    await sql`insert into users (id, github_user_id, github_login)
      values (${user.id}, ${user.githubUserId}, ${user.login})`;
  }
  const encryptedToken = Buffer.from(encryptToken(
    fixtureToken, encryptionKey, credentialBinding.userOAuthToken(sponsor.githubUserId),
  ));
  await sql`update users set encrypted_oauth_token = ${encryptedToken} where id = ${sponsor.id}`;
  const secret = Buffer.from(encryptToken(fixtureSecret, encryptionKey, credentialBinding.webhookSecret(credentialId)));
  await sql`insert into registered_repositories
    (id, github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
      difficulty_scheme, webhook_credential_id, encrypted_webhook_secret)
    values (${repository.id}, ${repository.githubRepositoryId}, ${observedRepository.fullName}, ${sponsor.id},
      'PUBLIC', ${repository.githubWebhookId}, ${sql.json({ ...repository.difficultyScheme })}, ${credentialId}, ${secret})`;
}

type Workload = {
  seed(url: string, sql: Sql): Promise<void>;
  run(sql: Sql): Promise<void>;
  verify(sql: Sql): Promise<void>;
};

const workloads: Record<string, Workload> = {
  "board-load": {
    seed: async (databaseUrl, sql) => { await seedBoardBenchmark({ ...BOARD_WORLD, databaseUrl }, sql); },
    run: async (sql) => {
      // Default-size first and second pages, through the same data function
      // /issues and /api/issues call. The world has over 400 eligible rows.
      const dependencies = { sql: sql as unknown as DashboardSql };
      const first = await listEligibleIssues(boardMemberId, { page: 1 }, dependencies);
      const second = await listEligibleIssues(boardMemberId, { page: 2 }, dependencies);
      if (first.length !== 200 || second.length !== 200
        || new Set([...first, ...second].map((row) => row.id)).size !== 400) {
        throw new Error("board-load did not exercise two distinct full pages");
      }
    },
    verify: async () => {},
  },
  "repository-fold": {
    seed: async (_url, sql) => seedMinimal(sql),
    run: async (sql) => {
      const store = new PostgresFoldStore(sql, encryptionKey, sql);
      const result = await reconcileRepository({ store, github: gateway, onBudgetChange: () => {},
        budget: createReconciliationBudgetGate({ store: createGitHubGraphqlBudgetStore() }),
        now: () => new Date("2025-09-02T00:00:00.000Z") }, repository.id);
      if (result.skipped) throw new Error("repository-fold was skipped");
    },
    verify: async (sql) => {
      const [row] = await sql`select status from reconciliation_runs where repository_id = ${repository.id}`;
      const issues = await sql`select github_issue_id from issues where repository_id = ${repository.id}`;
      if (row?.status !== "COMPLETED" || issues.length !== 1) throw new Error("repository-fold publication missing");
    },
  },
  "webhook-ingestion": {
    seed: async (_url, sql) => {
      await seedMinimal(sql);
      // Webhooks mirror known issues; a new opening's derivation is the worker's job.
      await sql`insert into issues (github_issue_id, repository_id, issue_number, title, body, url,
        state, opening_label, opening_comparison_points, opening_reserve_points, updated_at)
        values (${issue.id}, ${repository.id}, ${issue.number}, 'Before delivery', '', ${issue.url},
          'OPEN', 'S', 2, 2, ${issue.createdAt})`;
    },
    run: async (sql) => {
      const store = new PostgresFoldStore(sql, encryptionKey, sql);
      const credentials = new PostgresRepositoryStore(sql, encryptionKey);
      const handler = createGitHubWebhookPostHandler({
        checkRateLimit: () => true,
        lookupCredential: (selector, provider) => credentials.findWebhookCredential(selector, provider),
        processWebhook: (delivery, scope) => processWebhook({ store,
          enqueueReconciliation: (id, event) => store.enqueueWebhookReconciliation(id, event),
        }, delivery, scope),
      });
      const body = JSON.stringify({ action: "opened",
        repository: { id: repository.githubRepositoryId, full_name: observedRepository.fullName, private: false },
        issue: { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: "open",
          html_url: issue.url, updated_at: issue.updatedAt, labels: [{ name: "S" }], assignees: [] },
      });
      const signature = `sha256=${createHmac("sha256", fixtureSecret).update(body).digest("hex")}`;
      const response = await handler(new Request(`https://example.invalid/api/github/webhooks?hook=${credentialId}`, {
        method: "POST", body, headers: { "x-github-event": "issues", "x-github-delivery": "perf-delivery",
          "x-hub-signature-256": signature },
      }));
      if (response.status !== 202) throw new Error(`webhook-ingestion answered ${response.status}, expected 202`);
    },
    verify: async (sql) => {
      const receipts = await sql`select processing_state from webhook_deliveries`;
      const jobs = await sql`select repository_id from repository_reconciliation_jobs`;
      const issues = await sql`select github_issue_id, title from issues`;
      if (receipts.length !== 1 || receipts[0]?.processing_state !== "PROCESSED"
        || jobs.length !== 1 || issues.length !== 1 || issues[0]?.title !== issue.title) {
        throw new Error("webhook-ingestion effects missing");
      }
    },
  },
};

/** Reserve the whole pool so every connection is initialized and checked. */
async function prepareClient(sql: Sql, expectedDatabase: string): Promise<void> {
  const held: Awaited<ReturnType<Sql["reserve"]>>[] = [];
  try {
    for (let index = 0; index < sql.options.max; index += 1) {
      const connection = await sql.reserve();
      held.push(connection);
      const [row] = await connection<{ database: string }[]>`select current_database() as database`;
      if (row?.database !== expectedDatabase) {
        throw new Error(`database target mismatch: expected ${expectedDatabase}, got ${row?.database ?? "absent"}`);
      }
    }
  } finally {
    for (const connection of held) connection.release();
  }
}

/** Count operation SQL after all work/coordination connections are ready. */
export async function countOperationStatements(sql: Sql, expectedDatabase: string, operation: () => Promise<void>): Promise<number> {
  await prepareClient(sql, expectedDatabase);
  let count = 0;
  const previous = sql.options.debug;
  sql.options.debug = () => { count += 1; };
  try {
    await operation();
    return count;
  } finally {
    sql.options.debug = previous;
  }
}

/** Fresh seed and fresh counting client for each repeat; count only the operation. */
async function measureTwice(url: string, workload: Workload): Promise<number[]> {
  const samples: number[] = [];
  for (let repeat = 0; repeat < 2; repeat += 1) {
    const sql = postgres(url, { max: 4, onnotice: () => {} });
    try {
      await prepareClient(sql, new URL(url).pathname.slice(1));
      await workload.seed(url, sql);
      const count = await countOperationStatements(sql, new URL(url).pathname.slice(1), () => workload.run(sql));
      await workload.verify(sql);
      samples.push(count);
    } finally {
      await sql.end();
    }
  }
  return samples;
}

/** Rebuild a connection from explicit fields; never inherit routing overrides. */
export function scratchDatabaseUrl(databaseUrl: string, name: string): URL {
  const parent = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(parent.protocol) || !parent.hostname
    || /[,/%]/.test(parent.hostname) || !parent.username || parent.pathname.length < 2 || parent.hash
    || decodeURIComponent(parent.username).includes("\0") || decodeURIComponent(parent.password).includes("\0")) {
    throw new Error("DATABASE_URL must explicitly name one PostgreSQL host, user and database");
  }
  // postgres.js passes unknown query fields through the startup packet, where
  // database/user can override the URL. Admit only non-routing TLS/diagnostics.
  const safe = new Set(["ssl", "sslmode", "sslrootcert", "sslnegotiation", "connect_timeout", "client_min_messages", "application_name"]);
  for (const [field, value] of parent.searchParams) {
    if (!safe.has(field) || value.includes("\0")) {
      throw new Error(`DATABASE_URL routing query parameter refused: ${field}`);
    }
  }
  const scratch = new URL(`${parent.protocol}//${parent.hostname}`);
  scratch.port = parent.port || "5432";
  scratch.username = parent.username;
  scratch.password = parent.password;
  scratch.pathname = `/${encodeURIComponent(name)}`;
  for (const [field, value] of parent.searchParams) scratch.searchParams.append(field, value);
  return scratch;
}

/** Requires CREATEDB, available to both CI service users and scratch test roles. */
export async function measurePerfWorkloads(databaseUrl: string): Promise<Measurements> {
  const parentName = new URL(databaseUrl).pathname.slice(1);
  const name = `overflow_perf_${randomUUID().replaceAll("-", "")}`;
  const scratch = scratchDatabaseUrl(databaseUrl, name);
  const parent = scratchDatabaseUrl(databaseUrl, parentName);
  const admin = postgres(parent.href, { max: 1, onnotice: () => {} });
  let created = false;
  try {
    await prepareClient(admin, parentName);
    await admin.unsafe(`create database "${name}" template template0`);
    created = true;
    const migration = spawnSync("pnpm", ["db:migrate"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8",
      env: { ...process.env, OVERFLOW_DATABASE_URL: scratch.href, OVERFLOW_PERF_EXPECTED_DATABASE: name,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./perf-node-setup.mjs", import.meta.url).href}` },
    });
    if (migration.error) throw migration.error;
    if (migration.status !== 0) throw new Error(`scratch migration failed: ${migration.stderr}`);
    if (!migration.stderr.includes(`performance migration verified database: ${name}`)) {
      throw new Error("scratch migration did not verify its actual database client");
    }
    const measurements: Measurements = {};
    for (const [id, workload] of Object.entries(workloads)) {
      measurements[id] = await measureTwice(scratch.href, workload);
    }
    return measurements;
  } finally {
    try {
      // All workload and migration pools have ended before this exact owned DB drops.
      if (created) await admin.unsafe(`drop database "${name}"`);
    } finally {
      await admin.end();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const url = readEnv("DATABASE_URL");
    if (!url) throw new Error("DATABASE_URL must name the migrated CI or disposable test database");
    console.log(JSON.stringify(await measurePerfWorkloads(url)));
  } catch (error) {
    console.error(`performance measurement: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
