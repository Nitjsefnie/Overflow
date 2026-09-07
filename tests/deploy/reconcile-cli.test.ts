import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const documentedCommands = extractReconciliationCommands(readme);
const databaseError = "DATABASE_URL must be configured before using the database.";

function extractReconciliationCommands(markdown: string): string[] {
  const section = markdown.split(/^## Reconciliation\r?$/m)[1]?.split(/^## /m)[0] ?? "";
  return [...section.matchAll(/^```bash\r?\n([\s\S]*?)^```\s*$/gm)]
    .flatMap((block) => joinContinuations(block[1]!.replace(/^[ \t]*#.*$/gm, "")).split(/\r?\n/))
    .filter((line) => /^pnpm reconcile(?:\s|$)/.test(line));
}

function joinContinuations(source: string): string {
  let joined = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === "\\" && quote !== "'") {
      const newline = /^\r?\n/.exec(source.slice(index + 1));
      if (newline !== null) {
        index += newline[0].length;
        continue;
      }
      // Preserve other escapes for the tokenizer to accept or reject; an
      // escaped quote or backslash cannot begin a quote or a continuation.
      joined += character;
      if (index + 1 < source.length) joined += source[++index];
    } else {
      if (character === quote) quote = null;
      else if (quote === null && (character === "'" || character === '"')) quote = character;
      joined += character;
    }
  }
  return joined;
}

function tokenizeCommand(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let wordStarted = false;
  let quote: "'" | '"' | null = null;

  // Only literal shell words are supported. Never silently reinterpret expansion,
  // redirection, escapes or operators as argv passed to spawnSync.
  for (const character of command.replaceAll("<owner>/<name>", "octocat/hello-world")) {
    const unsupported = () => {
      throw new Error(`Unsupported shell syntax ${JSON.stringify(character)} in documented command: ${command}`);
    };
    if (character === "\n" || character === "\r") unsupported();
    if (quote !== null) {
      if (character === quote) {
        quote = null;
      } else {
        if (quote === '"' && "$`\\".includes(character)) unsupported();
        word += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
      wordStarted = true;
    } else if (character === " " || character === "\t") {
      if (wordStarted) words.push(word);
      word = "";
      wordStarted = false;
    } else {
      if ("$`\\;&|<>(){}*?[]~#!".includes(character) || /\s/.test(character)) unsupported();
      word += character;
      wordStarted = true;
    }
  }
  if (quote !== null) throw new Error(`Unterminated quote in documented command: ${command}`);
  if (wordStarted) words.push(word);
  return words;
}

function runCommand(command: string, databaseUrl?: string) {
  const [executable, ...argumentsList] = tokenizeCommand(command);
  const environment = { ...process.env };
  delete environment.DATABASE_URL;
  // Node preloads/flags and pnpm's lifecycle options must not repair the command
  // under test. Alternate runtimes, config files and shell startup files can
  // inject the same flags as well.
  for (const name of Object.keys(environment)) {
    if (/^(node_options|node_path|npm_config_(node_options|script_shell|shell_emulator|use_node_version|userconfig|globalconfig)|bash_env|env)$/.test(
      name.toLowerCase().replaceAll("-", "_"),
    )) delete environment[name];
  }
  if (databaseUrl !== undefined) environment.DATABASE_URL = databaseUrl;
  const configDirectory = mkdtempSync(join(tmpdir(), "reconcile-cli-config-"));
  try {
    // Empty environment options do not override pnpm/rc. Explicit XDG and npm
    // paths prevent fallback to home config while retaining Corepack's cache.
    const npmConfig = join(configDirectory, "npmrc");
    writeFileSync(npmConfig, "");
    environment.XDG_CONFIG_HOME = configDirectory;
    environment.npm_config_userconfig = npmConfig;
    environment.npm_config_globalconfig = npmConfig;
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
  } finally {
    rmSync(configDirectory, { recursive: true, force: true });
  }
}

describe("documented reconciliation CLI commands", () => {
  it("does not inherit Node options from the parent's pnpm config file", () => {
    const parentConfig = mkdtempSync(join(tmpdir(), "reconcile-cli-parent-config-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      mkdirSync(join(parentConfig, "pnpm"));
      writeFileSync(join(parentConfig, "pnpm/rc"), "node-options=--experimental-transform-types\n");
      process.env.XDG_CONFIG_HOME = parentConfig;
      const { status, stdout, stderr } = runCommand("pnpm exec node -p 'JSON.stringify(process.env.NODE_OPTIONS ?? null)'");
      expect(status, stderr).toBe(0);
      expect(JSON.parse(stdout)).toBeNull();
    } finally {
      if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousConfigHome;
      rmSync(parentConfig, { recursive: true, force: true });
    }
  });

  it("extracts exactly one all-repositories and one selected-repository invocation", () => {
    expect(documentedCommands, "No reconciliation commands found in the README bash block").not.toHaveLength(0);
    const argumentShapes = documentedCommands.map((command) => tokenizeCommand(command).slice(2));
    expect(argumentShapes).toHaveLength(2);
    expect(argumentShapes).toEqual(expect.arrayContaining([
      [],
      ["--repository", expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)],
    ]));
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

  it.each(["'", '"'])("passes a %s-quoted repository argument to the real CLI", (quote) => {
    const { status, stderr } = runCommand(`pnpm reconcile --repository ${quote}<owner>/<name>${quote}`);
    expect(status).not.toBe(0);
    expect(stderr).toContain(databaseError);
    expect(stderr).not.toContain("Usage:");
  }, 120_000);
});

describe("documented command extraction", () => {
  it("does not reinterpret a single-quoted backslash and newline as a continuation", () => {
    const commands = extractReconciliationCommands([
      "## Reconciliation", "```bash", "pnpm reconcile --repository 'octocat/hello-\\",
      "world'", "```",
    ].join("\n"));
    expect(() => tokenizeCommand(commands[0]!)).toThrow(/Unterminated quote/);
  });

  it.each(["\n", "\r\n"])("joins backslash continuations with %j line endings before running the command", (newline) => {
    const commands = extractReconciliationCommands([
      "## Reconciliation", "```bash", "pnpm reconcile \\",
      "  --repository <owner>/<name>", "pnpm reconcile", "```",
    ].join(newline));
    expect(commands.map(tokenizeCommand)).toEqual([
      ["pnpm", "reconcile", "--repository", "octocat/hello-world"],
      ["pnpm", "reconcile"],
    ]);
    const { status, stderr } = runCommand(commands[0]!);
    expect(status).not.toBe(0);
    expect(stderr).toContain(databaseError);
    expect(stderr).not.toContain("Usage:");
  });

  it("keeps a bare newline as a command boundary", () => {
    const commands = extractReconciliationCommands([
      "## Reconciliation", "```bash", "pnpm reconcile",
      "  --repository <owner>/<name>", "pnpm reconcile", "```",
    ].join("\n"));
    expect(commands.map(tokenizeCommand)).toEqual([
      ["pnpm", "reconcile"], ["pnpm", "reconcile"],
    ]);
  });
});

describe("documented command tokenization", () => {
  it.each([
    { command: `pnpm reconcile --repository 'octocat/hello-world'`, words: ["pnpm", "reconcile", "--repository", "octocat/hello-world"] },
    { command: `pnpm reconcile --repository "octocat/hello-world"`, words: ["pnpm", "reconcile", "--repository", "octocat/hello-world"] },
    { command: `pnpm reconcile --repo"sitory" octocat/'hello-world'`, words: ["pnpm", "reconcile", "--repository", "octocat/hello-world"] },
    { command: `pnpm reconcile "two words" ''`, words: ["pnpm", "reconcile", "two words", ""] },
    { command: `pnpm reconcile '$HOME;*'`, words: ["pnpm", "reconcile", "$HOME;*"] },
  ])("preserves literal shell words in $command", ({ command, words }) => {
    expect(tokenizeCommand(command)).toEqual(words);
  });

  it.each([
    '"unterminated', "'unterminated", "$OWNER/name", '"$OWNER/name"', "$(pwd)", "`pwd`",
    "owner/*", "owner/{one,two}", "owner/name; true", "owner/name | cat", "> output",
    "owner/\\name", '"owner/\\name"', "owner/name # comment",
  ])("rejects unsupported shell syntax: %s", (argument) => {
    expect(() => tokenizeCommand(`pnpm reconcile --repository ${argument}`))
      .toThrow(/Unsupported shell syntax|Unterminated quote/);
  });
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
    const expectedIds = tokenizeCommand(command).length === 4 ? [repositoryIds[0]!] : repositoryIds;
    expect(summaries).toHaveLength(expectedIds.length);
    expect(summaries).toEqual(expect.arrayContaining(expectedIds.map((repositoryId) => ({
      repositoryId, runId: null, skipped: true,
      adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0,
    }))));
    expect(await sql`select id from reconciliation_runs`).toHaveLength(0);
  }, 120_000);
});
