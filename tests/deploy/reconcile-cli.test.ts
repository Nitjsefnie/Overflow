import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    .flatMap((block) => joinContinuations(block[1]!).split(/\r?\n/))
    .filter((line) => /^pnpm reconcile(?:\s|$)/.test(line));
}

function joinContinuations(source: string): string {
  let joined = "";
  let quote: "'" | '"' | null = null;
  let wordStarted = false;
  let comment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (comment) {
      // Quotes and backslashes in a comment cannot affect the next command.
      joined += character;
      if (character === "\n") {
        comment = false;
        wordStarted = false;
      }
    } else if (character === "\\" && quote !== "'") {
      const newline = /^\r?\n/.exec(source.slice(index + 1));
      if (newline !== null) {
        index += newline[0].length;
        continue;
      }
      // Preserve other escapes for the tokenizer to accept or reject; an
      // escaped quote or backslash cannot begin a quote or a continuation.
      joined += character;
      if (index + 1 < source.length) joined += source[++index];
      wordStarted = true;
    } else {
      if (character === quote) quote = null;
      else if (quote === null) {
        // Joining a continuation does not start a new word; only unquoted
        // whitespace makes a following hash start a comment.
        if (character === "#" && !wordStarted) comment = true;
        if (character === "'" || character === '"') quote = character;
        wordStarted = !" \t\r\n".includes(character);
      }
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
    } else if (character === "#" && !wordStarted) {
      break;
    } else {
      if ("$`\\;&|<>(){}*?[]~!".includes(character) || /\s/.test(character)) unsupported();
      word += character;
      wordStarted = true;
    }
  }
  if (quote !== null) throw new Error(`Unterminated quote in documented command: ${command}`);
  if (wordStarted) words.push(word);
  return words;
}

function runCommand(command: string, databaseUrl?: string, cwd = repositoryRoot) {
  const [executable, ...argumentsList] = tokenizeCommand(command);
  const configDirectory = mkdtempSync(join(tmpdir(), "reconcile-cli-config-"));
  try {
    const npmConfig = join(configDirectory, "npmrc");
    writeFileSync(npmConfig, "");
    // Allowlist only: host Node flags, pnpm hooks and shell startup settings
    // must not supply behavior missing from the documented package script.
    const environment: Record<string, string | undefined> = {
      PATH: process.env.PATH, // Find the installed pnpm and Node executables.
      HOME: configDirectory,
      XDG_CONFIG_HOME: configDirectory,
      npm_config_userconfig: npmConfig,
      npm_config_globalconfig: npmConfig,
      // Keep the installed Corepack distribution cache available with an empty
      // HOME. This is Corepack's cache-location precedence, not pnpm config.
      COREPACK_HOME: process.env.COREPACK_HOME ?? join(
        process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ??
          join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
        "node/corepack",
      ),
      COREPACK_ENABLE_NETWORK: "0", // A missing cached package manager must fail offline.
    };
    if (process.platform === "win32") {
      environment.SystemRoot = process.env.SystemRoot; // Windows runtime and executable lookup.
      // Windows tools use these home/config paths instead of HOME or XDG.
      environment.USERPROFILE = configDirectory;
      environment.APPDATA = configDirectory;
      environment.LOCALAPPDATA = configDirectory;
    }
    if (databaseUrl !== undefined) environment.DATABASE_URL = databaseUrl;
    const result = spawnSync(executable!, argumentsList, {
      cwd,
      // Next requires NODE_ENV on ProcessEnv, but Node accepts an environment
      // without it. Keep the child's allowlist independent of that augmentation.
      env: environment as NodeJS.ProcessEnv,
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
  it("does not inherit a global pnpmfile that injects Node options through the lifecycle shell", () => {
    const fixture = mkdtempSync(join(tmpdir(), "reconcile-cli-pnpmfile-"));
    const previousPnpmfile = process.env.npm_config_global_pnpmfile;
    try {
      const { packageManager } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
      writeFileSync(join(fixture, "package.json"), JSON.stringify({
        name: "reconcile-cli-lifecycle-witness", private: true, packageManager,
        scripts: { "inspect-options": `node -p 'JSON.stringify(process.env.NODE_OPTIONS ?? null)'` },
      }));
      const shell = join(fixture, "inject-node-options.sh");
      writeFileSync(shell, [
        "#!/bin/sh", "export NODE_OPTIONS=--experimental-transform-types", 'exec /bin/sh "$@"', "",
      ].join("\n"), { mode: 0o755 });
      const pnpmfile = join(fixture, "global-pnpmfile.cjs");
      writeFileSync(pnpmfile, `module.exports = {
        hooks: { updateConfig: (config) => ({ ...config, scriptShell: ${JSON.stringify(shell)} }) },
      };`);

      // First prove an unsanitized child sees this lifecycle shell; pnpm exec
      // would miss the injection and make the isolation assertion meaningless.
      process.env.npm_config_global_pnpmfile = pnpmfile;
      const control = spawnSync("pnpm", ["--silent", "run", "inspect-options"], {
        cwd: fixture, env: process.env, encoding: "utf8", timeout: 60_000,
      });
      if (control.error) throw control.error;
      expect(control.signal).toBeNull();
      expect(control.status, control.stderr).toBe(0);
      expect(JSON.parse(control.stdout)).toBe("--experimental-transform-types");

      const isolated = runCommand("pnpm --silent run inspect-options", undefined, fixture);
      expect(isolated.status, isolated.stderr).toBe(0);
      expect(JSON.parse(isolated.stdout)).toBeNull();
    } finally {
      if (previousPnpmfile === undefined) delete process.env.npm_config_global_pnpmfile;
      else process.env.npm_config_global_pnpmfile = previousPnpmfile;
      rmSync(fixture, { recursive: true, force: true });
    }
  });

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

  it.each(["vercel/next.js", "cli/hello_world", "dot.owner/name", "under_score/name"])(
    "accepts repository name %s before requiring a database", (ownerName) => {
      const { status, stderr } = runCommand(`pnpm reconcile --repository ${ownerName}`);
      expect(status).not.toBe(0);
      expect(stderr).toContain(databaseError);
      expect(stderr).not.toContain("Usage:");
    },
  );

  it("rejects a malformed repository name before requiring a database", () => {
    const { status, stderr } = runCommand("pnpm reconcile --repository cli//second");
    expect(status).not.toBe(0);
    expect(stderr).toContain("Usage: pnpm reconcile [--repository owner/name]");
    expect(stderr).not.toContain(databaseError);
  });

  it.each(["'", '"'])("passes a %s-quoted repository argument to the real CLI", (quote) => {
    const { status, stderr } = runCommand(`pnpm reconcile --repository ${quote}<owner>/<name>${quote}`);
    expect(status).not.toBe(0);
    expect(stderr).toContain(databaseError);
    expect(stderr).not.toContain("Usage:");
  }, 120_000);
});

describe("documented command extraction", () => {
  it.each(["\n", "\r\n"])("strips trailing comments after continuations with %j line endings before running the command", (newline) => {
    const commands = extractReconciliationCommands([
      "## Reconciliation", "```bash", "pnpm reconcile \\",
      "  --repository cli/second # selected ' \" \\", "pnpm reconcile", "```",
    ].join(newline));
    expect(commands.map(tokenizeCommand)).toEqual([
      ["pnpm", "reconcile", "--repository", "cli/second"], ["pnpm", "reconcile"],
    ]);
    const { status, stderr } = runCommand(commands[0]!);
    expect(status).not.toBe(0);
    expect(stderr).toContain(databaseError);
    expect(stderr).not.toContain("Usage:");
  });

  it.each(["\n", "\r\n"])("keeps a continuation-joined hash inside a repository word with %j line endings", (newline) => {
    const commands = extractReconciliationCommands([
      "## Reconciliation", "```bash", "pnpm reconcile --repository cli/second\\",
      "#oops", "```",
    ].join(newline));
    expect(commands.map(tokenizeCommand)).toEqual([
      ["pnpm", "reconcile", "--repository", "cli/second#oops"],
    ]);
    const { status, stderr } = runCommand(commands[0]!);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Usage: pnpm reconcile [--repository owner/name]");
    expect(stderr).not.toContain(databaseError);
  });

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
    { command: `pnpm reconcile '# literal' "# literal"`, words: ["pnpm", "reconcile", "# literal", "# literal"] },
    { command: `pnpm reconcile ''#literal cli/second#literal`, words: ["pnpm", "reconcile", "#literal", "cli/second#literal"] },
  ])("preserves literal shell words in $command", ({ command, words }) => {
    expect(tokenizeCommand(command)).toEqual(words);
  });

  it.each([
    '"unterminated', "'unterminated", "$OWNER/name", '"$OWNER/name"', "$(pwd)", "`pwd`",
    "owner/*", "owner/{one,two}", "owner/name; true", "owner/name | cat", "> output",
    "owner/\\name", '"owner/\\name"',
  ])("rejects unsupported shell syntax: %s", (argument) => {
    expect(() => tokenizeCommand(`pnpm reconcile --repository ${argument}`))
      .toThrow(/Unsupported shell syntax|Unterminated quote/);
  });
});

describe("reconciliation CLI commands with PostgreSQL", () => {
  let started: StartedPostgres | undefined;
  let sql: Sql;
  let sponsorId: string;
  const repositoryIdsByOwnerName = new Map<string, string>();

  beforeAll(async () => {
    started = await startPostgresContainer({ database: "cli", user: "cli", password: "cli" });
    sql = postgres(started.databaseUrl, { max: 1 });
    const migration = runCommand("pnpm db:migrate", started.databaseUrl);
    expect(migration.status, migration.stderr).toBe(0);

    // The sponsor has no OAuth token, and both repositories are cooled down.
    const [sponsor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (10001, 'cli-sponsor') returning id
    `;
    sponsorId = sponsor!.id;
    for (const [index, ownerName] of ["octocat/hello-world", "cli/second"].entries()) {
      const [repository] = await sql<{ id: string }[]>`
        insert into registered_repositories
          (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
           difficulty_scheme, reconciliation_not_before)
        values (${10002 + index}, ${ownerName}, ${sponsor!.id}, 'PUBLIC', ${10002 + index},
          ${sql.json(validDifficultyScheme())}, now() + interval '1 day')
        returning id
      `;
      repositoryIdsByOwnerName.set(ownerName, repository!.id);
    }
  }, 120_000);

  afterAll(async () => {
    try {
      await sql?.end();
    } finally {
      await started?.container.stop();
    }
  }, 120_000);

  it.each([...documentedCommands, "pnpm reconcile --repository cli/second"])("completes %s with cooldown skips and no reconciliation runs", async (command) => {
    const { status, stdout, stderr } = runCommand(command, started!.databaseUrl);
    expect(status, stderr).toBe(0);
    const summaries = stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line));
    const words = tokenizeCommand(command);
    const repositoryOption = words.indexOf("--repository");
    const expectedIds = repositoryOption === -1
      ? [...repositoryIdsByOwnerName.values()]
      : [repositoryIdsByOwnerName.get(words[repositoryOption + 1]!)];
    expect(expectedIds, "Every selected repository must be seeded").not.toContain(undefined);
    expect(summaries).toHaveLength(expectedIds.length);
    expect(summaries).toEqual(expect.arrayContaining(expectedIds.map((repositoryId) => ({
      repositoryId, runId: null, skipped: true,
      adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0,
    }))));
    expect(await sql`select id from reconciliation_runs`, "Cooldown skips must not create reconciliation runs").toHaveLength(0);
  }, 120_000);

  it("records a failed run for a due repository whose sponsor has no OAuth token", async () => {
    // Seed inside this test so all-repository cooldown checks keep their own
    // fixture. Missing credentials stop the real callback before any GitHub read.
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories
        (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
         difficulty_scheme, reconciliation_not_before)
      values (10004, 'cli/tokenless', ${sponsorId}, 'PUBLIC', 10004,
        ${sql.json(validDifficultyScheme())}, now() - interval '1 day')
      returning id
    `;
    try {
      const { status, stdout, stderr } = runCommand("pnpm reconcile --repository cli/tokenless", started!.databaseUrl);
      const runs = await sql`
        select repository_id, status, error_message, completed_at
        from reconciliation_runs where repository_id = ${repository!.id}
      `;
      expect(runs, "The real callback must persist its attempt instead of fabricating a cooldown skip").toEqual([{
        repository_id: repository!.id,
        status: "FAILED",
        error_message: "Reconciliation failed.",
        completed_at: expect.any(Date),
      }]);
      expect(status, stderr).toBe(1);
      expect(stderr).toContain("GitHub access token was not available.");
      expect(stdout.split(/\r?\n/).filter((line) => line.startsWith("{"))).toEqual([]);
    } finally {
      await sql`delete from reconciliation_runs where repository_id = ${repository!.id}`;
      await sql`delete from registered_repositories where id = ${repository!.id}`;
    }
  }, 120_000);
});
