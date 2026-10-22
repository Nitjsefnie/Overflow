import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertMigrationsOnDefaultBranch,
  listDefaultBranchMigrationNames,
  listMigrationNames,
  resolveDefaultBranchRef,
  runMigrations,
} from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const seededDirectories = createOwnedTempDirectoryRegistry(path.join(os.tmpdir(), "migrate-guard-repository-"));


// Rebind the runner to this file's filesystem and database mocks.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = path.join(repositoryRoot, "db/migrations");

// Mirror the resolver’s candidate order to exercise precedence.
const RESOLVER_CANDIDATES = [
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
] as const;

// Resolve once so CLI expectations follow this checkout’s available refs.
const resolvedDefaultBranchRef = resolveDefaultBranchRef(repositoryRoot);

const migrationsOnDisk = vi.hoisted(() => ({ entries: [] as string[] }));
const databaseClient = vi.hoisted(() => ({
  withTransaction: vi.fn(() => Promise.reject(new Error("the database client is stubbed here"))),
  closeSql: vi.fn(() => Promise.resolve()),
}));

// Mock only readdir; child CLI processes and synchronous tree reads remain real.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readdir: () => Promise.resolve(migrationsOnDisk.entries),
}));
vi.mock("../../src/lib/db/client.ts", () => databaseClient);

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

    for (const ref of RESOLVER_CANDIDATES) {
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
    if (resolvedDefaultBranchRef === undefined) {
      return; // The fail-open shape is the neighbors' job; the CLI legs pin its skip line.
    }

    // Clone and linked-worktree refs differ; assert the first available candidate.
    expect(resolvedDefaultBranchRef).toBe(
      RESOLVER_CANDIDATES.find((ref) => refExists(repositoryRoot, ref)),
    );
  });

  it("checks the shipped tree against the real default-branch listing", () => {
    if (resolvedDefaultBranchRef === undefined) return;
    const treeMigrationNames = listMigrationNames(readdirSync(migrationsDirectory));
    const defaultBranchMigrationNames = listDefaultBranchMigrationNames(resolvedDefaultBranchRef, repositoryRoot);
    expect(treeMigrationNames.length).toBeGreaterThan(0);
    expect(defaultBranchMigrationNames.length).toBeGreaterThan(0);
    const check = () => assertMigrationsOnDefaultBranch(treeMigrationNames, defaultBranchMigrationNames, resolvedDefaultBranchRef);
    // Exercise the real guard whether this host tree needs refusal or acceptance.
    if (treeMigrationNames.some((name) => !defaultBranchMigrationNames.includes(name))) expect(check).toThrow();
    else expect(check).not.toThrow();
  });
});

describe("the exported runMigrations, which the guard must stay out of", () => {
  beforeEach(() => {
    migrationsOnDisk.entries = [];
    databaseClient.withTransaction.mockClear();
  });

  it("applies a foreign migration without the default-branch refusal, which is the CLI guard's alone", async () => {
    migrationsOnDisk.entries = ["001_a.sql", "999_foreign_to_the_default_branch.sql"];

    // Direct runMigrations calls must reach the runner without requiring repository refs.
    await expect(runMigrations()).rejects.toThrow("the database client is stubbed here");
    expect(databaseClient.withTransaction).toHaveBeenCalled();
  });
});

describe("the CLI against a real database", () => {
  const fakeMigrationName = "999_test_only.sql";
  const fakeMigrationContent = "select 1;\n";

  let containerUrl = "";
  let stopContainer: () => Promise<void> = () => Promise.resolve();
  let privateWorktreeRoot: string | undefined;

  /** The tree the fake migration is planted in; nothing here touches the shared db/migrations/. */
  function worktreeRoot(): string {
    if (privateWorktreeRoot === undefined) {
      throw new Error("The private worktree was not created.");
    }
    return privateWorktreeRoot;
  }

  beforeEach(async () => {
    const started = await startPostgresContainer({
      database: "migrate_guard",
      user: "migrate_guard",
      password: "migrate_guard",
    });
    containerUrl = started.databaseUrl;
    stopContainer = async () => {
      await started.container.stop();
    };

    // A private linked worktree prevents parallel database suites seeing the fake migration.
    privateWorktreeRoot = mkdtempSync(path.join(os.tmpdir(), "migrate-guard-worktree-"));
    git(repositoryRoot, "worktree", "add", privateWorktreeRoot, "HEAD");
    // Empty tracked migrations before checkout so branch-only files cannot survive; keep the branch runner.
    if (resolvedDefaultBranchRef !== undefined) {
      git(privateWorktreeRoot, "rm", "-q", "-r", "db/migrations");
      git(privateWorktreeRoot, "checkout", resolvedDefaultBranchRef, "--", "db/migrations");
    }
    // Link dependencies so the private runner resolves imports without copying the store.
    symlinkSync(
      path.join(repositoryRoot, "node_modules"),
      path.join(worktreeRoot(), "node_modules"),
      "dir",
    );
    writeFileSync(
      path.join(worktreeRoot(), "db/migrations", fakeMigrationName),
      fakeMigrationContent,
    );
  });

  afterEach(async () => {
    if (privateWorktreeRoot !== undefined) {
      // Raw removal and prune recover a failed worktree add or remove.
      gitQuietly(repositoryRoot, "worktree", "remove", "--force", privateWorktreeRoot);
      rmSync(privateWorktreeRoot, { recursive: true, force: true });
      gitQuietly(repositoryRoot, "worktree", "prune");
    }
    await stopContainer();
  });

  /** Runs the migrate runner exactly as `pnpm db:migrate` does, in the private worktree. */
  function runCli(guard: "skip" | undefined): ReturnType<typeof spawnSync> {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: containerUrl };
    if (guard === "skip") {
      env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD = "skip";
    } else {
      delete env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD;
    }

    return spawnSync(process.execPath, [path.join(worktreeRoot(), "scripts/migrate.ts")], {
      cwd: worktreeRoot(),
      env,
      encoding: "utf8",
    });
  }

  it("refuses to apply a branch-only migration and applies nothing", async () => {
    const refused = runCli(undefined);

    if (resolvedDefaultBranchRef === undefined) {
      // An unknown default branch requires the visible skip diagnostic.
      expect(refused.status).toBe(0);
      expect(refused.stderr).toContain("could not determine");
      return;
    }

    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(fakeMigrationName);
    expect(refused.stderr).toContain(resolvedDefaultBranchRef);
    expect(refused.stderr).toContain("issue 511");
    expect(refused.stderr).toContain("OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip");

    // Refusal must happen before the ledger is created.
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
      // Compare the private tree the runner enumerated, not this host branch’s listing.
      expect(applied).toBeGreaterThanOrEqual(
        listMigrationNames(readdirSync(path.join(worktreeRoot(), "db/migrations"))).length,
      );
    } finally {
      await sql.end();
    }
  });

  it("runs clean once the tree carries nothing foreign", async () => {
    const applied = runCli("skip");
    expect(applied.status, String(applied.stderr)).toBe(0);
    rmSync(path.join(worktreeRoot(), "db/migrations", fakeMigrationName), { force: true });

    const clean = runCli(undefined);

    expect(clean.status).toBe(0);
    // The refusal wording distinguishes refusal from a skip that cites the same issue.
    expect(clean.stderr).not.toContain("is frozen there under its name");
    expect(clean.stderr).not.toContain(fakeMigrationName);

    // An explicit override must still record applied migrations.
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
  try {
    for (const root of seededRepositoryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    seededDirectories.dispose();
  }
});

/** Seeds a throwaway git repository whose only content is one empty commit on `trunk`. */
function seedRepository(): string {
  const root = seededDirectories.create();
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

/** Runs git without failing the caller when it does — cleanup paths run whether or not git can. */
function gitQuietly(root: string, ...args: string[]): void {
  spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

// Use the resolver’s own probe semantics for the checkout expectation.
function refExists(root: string, ref: string): boolean {
  return (
    spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: root, encoding: "utf8" })
      .status === 0
  );
}

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
