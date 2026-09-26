import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAccountCli, type AccountCliDependencies } from "../../scripts/account";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { DELETED_ACCOUNT_LOGIN } from "@/lib/accounts/deletion";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const operating = readFileSync(new URL("../../OPERATING.md", import.meta.url), "utf8");

const usageLine = "Usage: account.ts export --github-user-id <id> | delete --github-user-id <id> [--confirm]";

/**
 * An sql client that fails the case the moment anything reaches for the
 * database, on ANY property access or call, so a grammar violation can never
 * hide a database round trip behind a plausible outcome — and so the failure
 * itself carries this message instead of a generic shape mismatch.
 */
const refusingSql = new Proxy((() => undefined) as unknown as SqlClient, {
  get() {
    throw new Error("must not touch the database");
  },
  apply() {
    throw new Error("must not touch the database");
  },
});

/**
 * An sql client whose every member rejects with a connection string, so the
 * sanitized-failure cases exercise exactly the error they name instead of a
 * stray TypeError about a missing method.
 */
function leakingSql(): SqlClient {
  const connectionError = () => new Error("postgres://private:password@db");
  return new Proxy((() => undefined) as unknown as SqlClient, {
    get() {
      return () => Promise.reject(connectionError());
    },
    apply() {
      throw connectionError();
    },
  });
}

function fixture(sql: SqlClient): { lines: string[]; dependencies: AccountCliDependencies } {
  const lines: string[] = [];
  return { lines, dependencies: { sql, write: (line) => lines.push(line) } };
}

describe("account CLI grammar", () => {
  it.each([
    { args: [] },
    { args: ["export"] },
    { args: ["delete"] },
    { args: ["reconcile", "--github-user-id", "1"] },
    { args: ["--github-user-id", "1"] },
    { args: ["export", "--github-user-id"] },
    { args: ["export", "--github-user-id", ""] },
    { args: ["export", "--github-user-id", "abc"] },
    { args: ["export", "--github-user-id", "0"] },
    { args: ["export", "--github-user-id", "-1"] },
    { args: ["export", "--github-user-id", "1.5"] },
    { args: ["export", "--github-user-id", "9007199254740993"] },
    { args: ["export", "--github-user-id", "1", "--confirm"] },
    { args: ["export", "--github-user-id", "1", "extra"] },
    { args: ["delete", "--github-user-id"] },
    { args: ["delete", "--github-user-id", "0"] },
    { args: ["delete", "--confirm"] },
    { args: ["delete", "--github-user-id", "1", "extra"] },
    { args: ["delete", "--github-user-id", "1", "--confirm", "extra"] },
    { args: ["delete", "--github-user-id", "1", "--confirm", "--confirm"] },
    { args: ["delete", "--github-user-id", "1", "--github-user-id", "2"] },
  ])("rejects $args before touching the database", async ({ args }) => {
    const { lines, dependencies } = fixture(refusingSql);
    expect(await runAccountCli(args, dependencies)).toBe(2);
    expect(lines).toEqual([usageLine]);
  });

  it("reaches the database for a grammatically valid command, failing sanitized", async () => {
    const { lines, dependencies } = fixture(refusingSql);
    expect(await runAccountCli(["export", "--github-user-id", "42"], dependencies)).toBe(1);
    expect(lines).toEqual(['{"failure":"ACCOUNT_COMMAND_FAILED"}']);
  });

  it("resolves no database client for a usage error, even with no DATABASE_URL", async () => {
    // No sql supplied, so the only way to a client is the default getSql()
    // path — and with no DATABASE_URL that throws. closeSql() first empties
    // the module-level client cache, which earlier files in the same worker
    // (isolate: false) may have filled under their own DATABASE_URL: without
    // it, an eager getSql() before parsing would ride that cached client
    // instead of re-reading the deleted variable and throwing. Exit 2 with
    // the bare usage line therefore proves parsing happened before any
    // client was resolved.
    const lines: string[] = [];
    const writeOnlyDependencies = { write: (line: string) => lines.push(line) } as unknown as AccountCliDependencies;
    const previousDatabaseUrl = process.env.DATABASE_URL;
    await closeSql();
    delete process.env.DATABASE_URL;
    try {
      expect(await runAccountCli(["export", "--github-user-id", "0"], writeOnlyDependencies)).toBe(2);
    } finally {
      if (previousDatabaseUrl !== undefined) process.env.DATABASE_URL = previousDatabaseUrl;
    }
    expect(lines).toEqual([usageLine]);
  });

  it.each([
    { command: "export", arguments: ["export", "--github-user-id", "1"] },
    { command: "delete", arguments: ["delete", "--github-user-id", "1", "--confirm"] },
  ])("sanitizes a failing $command instead of printing the connection string", async ({ arguments: argumentsList }) => {
    const { lines, dependencies } = fixture(leakingSql());
    expect(await runAccountCli(argumentsList, dependencies)).toBe(1);
    expect(lines).toEqual(['{"failure":"ACCOUNT_COMMAND_FAILED"}']);
    expect(lines.join("\n")).not.toContain("password");
  });
});

// ---------------------------------------------------------------------------
// The runbook. The documented commands must stay literal, loadable and
// working, so the runbook cannot drift from the script.
// ---------------------------------------------------------------------------

const accountScriptPrefix = "node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts";

function extractAccountCommands(markdown: string): string[] {
  const section = markdown.split(/^## Account deletion and export\r?$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^```bash\r?\n([\s\S]*?)^```\s*$/gm)]
    .flatMap((block) => block[1]!.split(/\r?\n/))
    .filter((line) => line.startsWith(accountScriptPrefix));
}

const documentedCommands = extractAccountCommands(operating);

/**
 * The documented line's words, with the placeholder replaced by a seeded id.
 * Any shell syntax that a shell would reinterpret fails the case instead of
 * being silently passed through.
 */
function documentedArgumentWords(command: string, githubUserId: number): string[] {
  const words = command.replaceAll("<github-user-id>", String(githubUserId)).trim().split(/\s+/);
  for (const word of words) {
    for (const character of word) {
      if ("$`\\;&|<>(){}*?[]~!'\"".includes(character)) {
        throw new Error(`Unsupported shell syntax ${JSON.stringify(character)} in documented command: ${command}`);
      }
    }
  }
  return words;
}

function spawnDocumented(words: readonly string[], environment: Record<string, string>) {
  const result = spawnSync(words[0]!, words.slice(1), {
    cwd: repositoryRoot,
    // Next requires NODE_ENV on ProcessEnv, but Node accepts an environment
    // without it. Keep the child's allowlist independent of that augmentation.
    env: environment as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}

describe("documented account commands", () => {
  it("documents exactly the export, dry-run delete and confirmed delete invocations", () => {
    expect(documentedCommands, "No account commands found in the OPERATING.md bash block").not.toHaveLength(0);
    const argumentShapes = documentedCommands.map((command) => command.slice(accountScriptPrefix.length).trim().split(/\s+/));
    expect(argumentShapes).toEqual([
      ["export", "--github-user-id", "<github-user-id>"],
      ["delete", "--github-user-id", "<github-user-id>"],
      ["delete", "--github-user-id", "<github-user-id>", "--confirm"],
    ]);
  });

  it("loads under the documented flags without a database and fails sanitized", () => {
    const home = mkdtempSync(join(tmpdir(), "account-cli-home-"));
    try {
      const words = documentedArgumentWords(documentedCommands[0]!, 42);
      const result = spawnDocumented(words, { PATH: process.env.PATH!, HOME: home });
      expect(result.status).toBe(1);
      expect(result.stdout.trim()).toBe('{"failure":"ACCOUNT_COMMAND_FAILED"}');
      for (const loadingError of [
        "ERR_MODULE_NOT_FOUND",
        "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
        "Cannot find package",
        "SyntaxError",
      ]) {
        expect(result.stderr).not.toContain(loadingError);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("account CLI with PostgreSQL", () => {
  let started: StartedPostgres;
  let sql: Sql;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  let seedCounter = 0;

  function nextGithubUserId(): number {
    seedCounter += 1;
    return 9_650_000 + seedCounter;
  }

  async function seedUser(login: string): Promise<number> {
    const githubUserId = nextGithubUserId();
    await sql`
      insert into users (github_user_id, github_login)
      values (${githubUserId}, ${login})
    `;
    return githubUserId;
  }

  async function userRow(githubUserId: number) {
    const [row] = await sql<{ github_login: string; avatar_url: string | null; encrypted_oauth_token: Buffer | null; deleted_at: Date | null }[]>`
      select github_login, avatar_url, encrypted_oauth_token, deleted_at
      from users where github_user_id = ${githubUserId}
    `;
    return row!;
  }

  beforeAll(async () => {
    started = await startPostgresContainer({
      database: "account_cli_test",
      user: "account_cli_test",
      password: "account_cli_test",
    });
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  }, 120_000);

  afterAll(async () => {
    await closeSql();
    await started.container.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  }, 120_000);

  it("exports a seeded account", async () => {
    const githubUserId = await seedUser("export-me");
    const { lines, dependencies } = fixture(getSql());
    expect(await runAccountCli(["export", "--github-user-id", String(githubUserId)], dependencies)).toBe(0);
    expect(JSON.parse(lines[0]!).account.githubUserId).toBe(githubUserId);
  });

  it("reports an unknown account as a failure", async () => {
    const { lines, dependencies } = fixture(getSql());
    expect(await runAccountCli(["export", "--github-user-id", "9999999"], dependencies)).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({ failure: "UNKNOWN_ACCOUNT", githubUserId: 9999999 });
  });

  it("plans the deletion without confirming and leaves the row unchanged", async () => {
    const githubUserId = await seedUser("planned-delete");
    const before = await userRow(githubUserId);
    const { lines, dependencies } = fixture(getSql());
    expect(await runAccountCli(["delete", "--github-user-id", String(githubUserId)], dependencies)).toBe(3);
    expect(JSON.parse(lines[0]!).kind).toBe("PLANNED");
    expect(await userRow(githubUserId)).toEqual(before);
  });

  it("deletes on --confirm, idempotently", async () => {
    const githubUserId = await seedUser("confirmed-delete");
    const { lines, dependencies } = fixture(getSql());
    expect(await runAccountCli(["delete", "--github-user-id", String(githubUserId), "--confirm"], dependencies)).toBe(0);
    expect(JSON.parse(lines[0]!).kind).toBe("DELETED");
    const repeat = fixture(getSql());
    expect(await runAccountCli(["delete", "--github-user-id", String(githubUserId), "--confirm"], repeat.dependencies)).toBe(0);
    expect(JSON.parse(repeat.lines[0]!).alreadyDeleted).toBe(true);
  });

  it("refuses a sponsor with an active registration, naming the repository", async () => {
    const githubUserId = await seedUser("blocked-sponsor");
    const [account] = await sql<{ id: string }[]>`select id from users where github_user_id = ${githubUserId}`;
    await sql`
      insert into registered_repositories
        (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
         difficulty_scheme, reconciliation_not_before)
      values (${nextGithubUserId() + 10_000}, 'octocat/hello-world', ${account!.id}, 'PUBLIC',
        ${nextGithubUserId() + 10_000}, ${sql.json(validDifficultyScheme())}, now() + interval '1 day')
    `;
    const { lines, dependencies } = fixture(getSql());
    expect(await runAccountCli(["delete", "--github-user-id", String(githubUserId), "--confirm"], dependencies)).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      kind: "SPONSOR_BLOCKED",
      githubUserId,
      repositories: [{ ownerName: "octocat/hello-world", provider: "github", instanceUrl: null }],
    });
    expect((await userRow(githubUserId)).github_login).toBe("blocked-sponsor");
  });

  it("runs the documented commands in document order against a seeded account", async () => {
    const githubUserId = await seedUser("documented-run");
    const home = mkdtempSync(join(tmpdir(), "account-cli-home-"));
    try {
      const environment: Record<string, string> = { PATH: process.env.PATH!, HOME: home, DATABASE_URL: started.databaseUrl };
      const statuses: (number | null)[] = [];
      const results: ReturnType<typeof spawnDocumented>[] = [];
      for (const command of documentedCommands) {
        const words = documentedArgumentWords(command, githubUserId);
        const result = spawnDocumented(words, environment);
        results.push(result);
        statuses.push(result.status);
      }
      expect(statuses, "The documented commands must export (0), dry-run (3) and delete (0)").toEqual([0, 3, 0]);
      const exported = JSON.parse(results[0]!.stdout);
      expect(exported.account.githubUserId).toBe(githubUserId);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    const row = await userRow(githubUserId);
    expect(row.github_login).toBe(DELETED_ACCOUNT_LOGIN);
    expect(row.deleted_at).not.toBeNull();
  }, 120_000);
});
