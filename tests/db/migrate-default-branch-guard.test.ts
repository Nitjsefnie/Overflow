import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertMigrationsOnDefaultBranch,
  listDefaultBranchMigrationNames,
  listMigrationNames,
  resolveDefaultBranchRef,
} from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = path.join(repositoryRoot, "db/migrations");

/**
 * The default branch as this checkout resolves it, computed once at load: the CLI legs below
 * assert against the ref the guard itself would use, so a leg never disagrees with the runner
 * about which ref won.
 */
const resolvedDefaultBranchRef = resolveDefaultBranchRef(repositoryRoot);

/** The message, not the throw, is what tells whoever hit this which files are wrong. */
function rejectionMessage(check: () => void): string {
  try {
    check();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the migration set to be rejected.");
}

describe("the default-branch refusal", () => {
  it("names the foreign files, the ref it compared against, the issue, and both remedies", () => {
    const message = rejectionMessage(() => {
      assertMigrationsOnDefaultBranch(
        ["001_initial.sql", "038_branch_only.sql"],
        ["001_initial.sql"],
        "refs/remotes/origin/main",
      );
    });

    expect(message).toContain("038_branch_only.sql");
    expect(message).toContain("refs/remotes/origin/main");
    expect(message).toContain("issue 511");
    expect(message).toContain("fetch");
    expect(message).toContain("OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip");
  });

  it("passes a tree whose every migration the default branch also carries", () => {
    expect(() => {
      assertMigrationsOnDefaultBranch(
        ["001_initial.sql"],
        ["001_initial.sql", "002_later.sql"],
        "refs/remotes/origin/main",
      );
    }).not.toThrow();
  });

  it("passes an empty tree against any default listing", () => {
    expect(() => {
      assertMigrationsOnDefaultBranch([], ["001_initial.sql"], "refs/remotes/origin/main");
    }).not.toThrow();
    expect(() => {
      assertMigrationsOnDefaultBranch([], [], "refs/remotes/origin/main");
    }).not.toThrow();
  });
});

describe("resolving the default branch from local refs alone", () => {
  it("prefers origin/HEAD, then origin/main, origin/master, heads/main, heads/master", () => {
    const root = seedRepository();
    const head = gitOutput(root, "rev-parse", "HEAD");

    for (const ref of [
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
      "refs/remotes/origin/master",
      "refs/heads/main",
      "refs/heads/master",
    ]) {
      git(root, "update-ref", ref, head);
    }
    expect(resolveDefaultBranchRef(root)).toBe("refs/remotes/origin/HEAD");

    git(root, "update-ref", "-d", "refs/remotes/origin/HEAD");
    expect(resolveDefaultBranchRef(root)).toBe("refs/remotes/origin/main");

    git(root, "update-ref", "-d", "refs/remotes/origin/main");
    expect(resolveDefaultBranchRef(root)).toBe("refs/remotes/origin/master");

    git(root, "update-ref", "-d", "refs/remotes/origin/master");
    expect(resolveDefaultBranchRef(root)).toBe("refs/heads/main");

    git(root, "update-ref", "-d", "refs/heads/main");
    expect(resolveDefaultBranchRef(root)).toBe("refs/heads/master");

    git(root, "update-ref", "-d", "refs/heads/master");
    expect(resolveDefaultBranchRef(root)).toBeUndefined();
  });

  it("finds no default branch outside a git repository", () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), "migrate-guard-plain-"));
    seededRepositoryRoots.push(plain);
    expect(resolveDefaultBranchRef(plain)).toBeUndefined();
  });

  it("resolves this checkout's default branch", () => {
    if (resolvedDefaultBranchRef !== undefined) {
      // This worktree has no refs/remotes/origin/HEAD (it shares the main checkout's refs), so
      // origin/main is the first candidate that resolves. A checkout carrying a different ref
      // set — a detached merge-ref checkout, for one — resolves differently or not at all; the
      // fail-open contract covers that shape and the CLI legs pin its stderr line.
      expect(resolvedDefaultBranchRef).toBe("refs/remotes/origin/main");
    }
  });

  it("passes the shipped tree against the real default-branch listing", () => {
    if (resolvedDefaultBranchRef === undefined) {
      return; // No local ref resolved, so there is no listing to compare against here.
    }

    const treeMigrationNames = listMigrationNames(readdirSync(migrationsDirectory));
    const defaultBranchMigrationNames = listDefaultBranchMigrationNames(
      resolvedDefaultBranchRef,
      repositoryRoot,
    );

    expect(treeMigrationNames.length).toBeGreaterThan(0);
    expect(defaultBranchMigrationNames.length).toBeGreaterThan(0);
    expect(() => {
      assertMigrationsOnDefaultBranch(treeMigrationNames, defaultBranchMigrationNames, resolvedDefaultBranchRef);
    }).not.toThrow();
  });
});

describe("the CLI against a real database", () => {
  const fakeMigrationName = "999_test_only.sql";
  const fakeMigrationPath = path.join(migrationsDirectory, fakeMigrationName);
  const fakeMigrationContent = "select 1;\n";

  let containerUrl = "";
  let stopContainer: () => Promise<void> = () => Promise.resolve();

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "migrate_guard",
      user: "migrate_guard",
      password: "migrate_guard",
    });
    containerUrl = started.databaseUrl;
    stopContainer = async () => {
      await started.container.stop();
    };
    writeFileSync(fakeMigrationPath, fakeMigrationContent);
  });

  afterAll(async () => {
    rmSync(fakeMigrationPath, { force: true });
    await stopContainer();
  });

  /** Runs the migrate runner exactly as `pnpm db:migrate` does, in this worktree. */
  function runCli(guard: "skip" | undefined): ReturnType<typeof spawnSync> {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: containerUrl };
    if (guard === "skip") {
      env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD = "skip";
    } else {
      delete env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD;
    }

    return spawnSync(process.execPath, ["scripts/migrate.ts"], {
      cwd: repositoryRoot,
      env,
      encoding: "utf8",
    });
  }

  it("refuses to apply a branch-only migration and applies nothing", async () => {
    const refused = runCli(undefined);

    if (resolvedDefaultBranchRef === undefined) {
      // In a checkout where no candidate ref resolves — CI's detached merge-ref checkout, for
      // one — the guard is fail-open by design, and what the run owes instead is the visible
      // skip line: the refusal cannot be asserted where the default branch cannot be known.
      expect(refused.status).toBe(0);
      expect(refused.stderr).toContain("could not determine");
      return;
    }

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(fakeMigrationName);
    expect(refused.stderr).toContain(resolvedDefaultBranchRef);
    expect(refused.stderr).toContain("issue 511");
    expect(refused.stderr).toContain("OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip");

    // The incident shape pinned end to end: the ledger does not even come into existence,
    // because the guard stops the run before the runner opens it.
    const sql = postgres(containerUrl, { max: 1 });
    try {
      expect(await sql`select to_regclass('schema_migrations') as ledger`).toEqual([
        { ledger: null },
      ]);
    } finally {
      await sql.end();
    }
  });

  it("applies the branch-only migration under OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip", async () => {
    const allowed = runCli("skip");

    expect(allowed.status).toBe(0);
    expect(allowed.stderr).toContain("OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip");

    const sql = postgres(containerUrl, { max: 1 });
    try {
      expect(
        await sql`select name from schema_migrations where name = ${fakeMigrationName}`,
      ).toEqual([{ name: fakeMigrationName }]);
      const [{ applied }] = await sql<{ applied: number }[]>`
        select count(*)::integer as applied from schema_migrations
      `;
      expect(applied).toBeGreaterThanOrEqual(
        listMigrationNames(readdirSync(migrationsDirectory)).length,
      );
    } finally {
      await sql.end();
    }
  });

  it("runs clean once the tree carries nothing foreign", async () => {
    rmSync(fakeMigrationPath, { force: true });

    const clean = runCli(undefined);

    expect(clean.status).toBe(0);
    expect(clean.stderr).not.toContain("issue 511");
    expect(clean.stderr).not.toContain(fakeMigrationName);

    // The ledger keeps recording what the overridden run applied — the whole reason a
    // branch-only migration must never reach a database that matters.
    const sql = postgres(containerUrl, { max: 1 });
    try {
      expect(
        await sql`select name from schema_migrations where name = ${fakeMigrationName}`,
      ).toEqual([{ name: fakeMigrationName }]);
    } finally {
      await sql.end();
    }
  });
});

const seededRepositoryRoots: string[] = [];

afterAll(() => {
  for (const root of seededRepositoryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Seeds a throwaway git repository whose only content is one empty commit on `trunk`. */
function seedRepository(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "migrate-guard-repository-"));
  git(root, "init", "-b", "trunk");
  git(root, "config", "user.email", "guard-test@example.com");
  git(root, "config", "user.name", "Guard Test");
  git(root, "commit", "--allow-empty", "-m", "A seeded commit");
  seededRepositoryRoots.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
