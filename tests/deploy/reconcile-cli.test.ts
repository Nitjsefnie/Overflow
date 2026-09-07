import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const reconciliationSection = readme.split(/^## Reconciliation\r?$/m)[1]?.split(/^## /m)[0] ?? "";
const documentedCommands = [...reconciliationSection.matchAll(/^```bash\r?\n([\s\S]*?)^```\s*$/gm)]
  .flatMap((block) => block[1]!.split(/\r?\n/))
  .filter((line) => /^pnpm reconcile(?:\s|$)/.test(line));
const databaseError = "DATABASE_URL must be configured before using the database.";

function runCommand(command: string, databaseUrl?: string) {
  // Replace the README's owner/name placeholder with a syntactically valid repository.
  const [executable, ...argumentsList] = command.replaceAll("<owner>/<name>", "octocat/hello-world").split(/\s+/);
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  if (databaseUrl !== undefined) environment.DATABASE_URL = databaseUrl;
  const result = spawnSync(executable!, argumentsList, {
    cwd: repositoryRoot,
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  // A missing pnpm executable or a timed-out child is a failure, never a skip.
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return result;
}

describe("documented reconciliation CLI commands", () => {
  it("extracts at least two commands from the Reconciliation bash block", () => {
    expect(documentedCommands.length).toBeGreaterThanOrEqual(2);
  });

  it.each(documentedCommands)("loads and parses %s before requiring a database", (command) => {
    const { status, stderr } = runCommand(command);
    expect(status).not.toBe(0);
    for (const loadingError of [
      "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
      "ERR_MODULE_NOT_FOUND",
      "Cannot find package",
      "SyntaxError",
    ]) {
      expect(stderr).not.toContain(loadingError);
    }
    expect(stderr).toContain(databaseError);
  }, 120_000);

  it("reports invalid arguments before requiring a database", () => {
    const { status, stderr } = runCommand("pnpm reconcile --not-a-flag");
    expect(status).not.toBe(0);
    expect(stderr).toContain("Usage: pnpm reconcile [--repository owner/name]");
    expect(stderr).not.toContain(databaseError);
  }, 120_000);
});

describe("documented reconciliation CLI commands with PostgreSQL", () => {
  let started: StartedPostgres | undefined;
  let sql: Sql;
  const repositoryIds: string[] = [];

  beforeAll(async () => {
    started = await startPostgresContainer({ database: "cli", user: "cli", password: "cli" });
    sql = postgres(started.databaseUrl, { max: 1 });
    const migration = runCommand("pnpm db:migrate", started.databaseUrl);
    expect(migration.status, migration.stderr).toBe(0);

    // No OAuth token is seeded: cooldown must return before any GitHub access.
    const [sponsor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (10001, 'cli-sponsor') returning id
    `;
    for (const [index, ownerName] of ["octocat/hello-world", "cli/second"].entries()) {
      const [repository] = await sql<{ id: string }[]>`
        insert into registered_repositories
          (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
           difficulty_scheme, reconciliation_not_before)
        values (${10002 + index}, ${ownerName}, ${sponsor!.id}, 'PUBLIC', ${10002 + index},
          ${sql.json(validDifficultyScheme())}, now() + interval '1 day')
        returning id
      `;
      repositoryIds.push(repository!.id);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await sql?.end();
    } finally {
      await started?.container.stop();
    }
  }, 120_000);

  it.each(documentedCommands)("successfully runs %s without GitHub access", async (command) => {
    const { status, stdout, stderr } = runCommand(command, started!.databaseUrl);
    expect(status, stderr).toBe(0);
    const summaries = stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const expectedIds = command.includes("--repository") ? [repositoryIds[0]!] : repositoryIds;
    expect(summaries).toHaveLength(expectedIds.length);
    expect(summaries).toEqual(expect.arrayContaining(expectedIds.map((repositoryId) => ({
      repositoryId, runId: null, skipped: true,
      adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0,
    }))));
    expect(await sql`select id from reconciliation_runs`).toHaveLength(0);
  }, 120_000);
});
