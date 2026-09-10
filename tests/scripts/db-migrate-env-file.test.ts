import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Issue 117: the documented local setup failed because `pnpm db:migrate`
// reached the connection string only through process.env.DATABASE_URL, and
// nothing on that path loaded .env (Next.js loads it for dev/build/start, so
// only the migration step failed). These tests execute the package.json
// db:migrate command as written, with scripts/migrate.ts substituted by a
// probe, so removing or mangling the .env-loading flag fails here.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sentinel = "OVERFLOW_DB_MIGRATE_SENTINEL";
const fromDotenvFile = "from-dotenv-file";
const fromExportedEnvironment = "from-exported-environment";
const databaseError = "DATABASE_URL must be configured before using the database.";

function migrateCommand(): string {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const command = manifest.scripts?.["db:migrate"];
  expect(command, "package.json must define a db:migrate script").toBeTypeOf("string");
  expect(
    command,
    "The db:migrate command must reference scripts/migrate.ts for the substitution below to execute it",
  ).toContain("scripts/migrate.ts");
  return command!;
}

function probeSource(): string {
  return [
    "// Executed in place of scripts/migrate.ts by tests/scripts/db-migrate-env-file.test.ts.",
    `process.stdout.write(JSON.stringify(process.env.${sentinel} ?? null) + "\\n");`,
    "",
  ].join("\n");
}

interface Fixture {
  directory: string;
}

function createFixture(dotEnv: string | undefined): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "db-migrate-env-file-"));
  mkdirSync(join(directory, "scripts"));
  writeFileSync(join(directory, "scripts", "db-migrate-env-probe.mjs"), probeSource());
  const { packageManager } = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    packageManager: string;
  };
  writeFileSync(join(directory, "package.json"), JSON.stringify({
    name: "db-migrate-env-file-witness",
    private: true,
    packageManager,
    scripts: {
      "db:migrate": migrateCommand().replace("scripts/migrate.ts", "scripts/db-migrate-env-probe.mjs"),
    },
  }));
  if (dotEnv !== undefined) writeFileSync(join(directory, ".env"), dotEnv);
  return { directory };
}

function childEnvironment(fixtureDirectory: string, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const environment: Record<string, string | undefined> = {
    PATH: process.env.PATH, // Find the installed pnpm and Node executables.
    HOME: fixtureDirectory,
    XDG_CONFIG_HOME: fixtureDirectory,
    // Keep the installed Corepack distribution cache available with a fresh
    // HOME. This is Corepack's cache-location precedence, not pnpm config.
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(
      process.env.XDG_CACHE_HOME ?? process.env.LOCALAPPDATA ??
        join(homedir(), process.platform === "win32" ? "AppData/Local" : ".cache"),
      "node/corepack",
    ),
    COREPACK_ENABLE_NETWORK: "0", // A missing cached package manager must fail offline.
    // NODE_OPTIONS is deliberately absent: it could smuggle --env-file into the
    // child and defeat the contract under test.
    ...overrides,
  };
  if (process.platform === "win32") {
    environment.SystemRoot = process.env.SystemRoot; // Windows executable lookup.
  }
  return environment as NodeJS.ProcessEnv;
}

function runMigrateCommand(fixture: Fixture, overrides: Record<string, string> = {}) {
  const result = spawnSync("pnpm", ["--silent", "run", "db:migrate"], {
    cwd: fixture.directory,
    env: childEnvironment(fixture.directory, overrides),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();
  return result;
}

function withFixture<T>(dotEnv: string | undefined, run: (fixture: Fixture) => T): T {
  const fixture = createFixture(dotEnv);
  try {
    return run(fixture);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
}

describe("the db:migrate .env contract", () => {
  it("loads .env when the variable is not already exported", () => {
    withFixture(`${sentinel}=${fromDotenvFile}\n`, (fixture) => {
      const { status, stdout, stderr } = runMigrateCommand(fixture);
      expect(status, stderr).toBe(0);
      expect(stdout).not.toContain(databaseError);
      expect(JSON.parse(stdout)).toBe(fromDotenvFile);
    });
  });

  it("treats a missing .env as a no-op so CI without one still exits successfully", () => {
    withFixture(undefined, (fixture) => {
      const { status, stdout } = runMigrateCommand(fixture);
      expect(status).toBe(0);
      expect(JSON.parse(stdout)).toBeNull();
    });
  });

  it("prefers an already-exported variable over the .env value", () => {
    withFixture(`${sentinel}=${fromDotenvFile}\n`, (fixture) => {
      const { status, stdout, stderr } = runMigrateCommand(fixture, { [sentinel]: fromExportedEnvironment });
      expect(status, stderr).toBe(0);
      expect(JSON.parse(stdout)).toBe(fromExportedEnvironment);
    });
  });
});
