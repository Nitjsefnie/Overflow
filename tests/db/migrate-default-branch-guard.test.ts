import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertMigrationsOnDefaultBranch,
  listDefaultBranchMigrationNames,
  listMigrationNames,
  resolveDefaultBranchRef,
  runMigrations,
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

const migrationsOnDisk = vi.hoisted(() => ({ entries: [] as string[] }));
const databaseClient = vi.hoisted(() => ({
  withTransaction: vi.fn(() => Promise.reject(new Error("the database client is stubbed here"))),
  closeSql: vi.fn(() => Promise.resolve()),
}));

// The runMigrations pin below drives the real exported entry point against a mocked listing and
// a stubbed database — the same hermetic shape tests/db/migration-numbering.test.ts uses. Only
// readdir is replaced: the CLI legs' child processes are outside this module graph, and the one
// read this file makes of the real tree uses the synchronous API for exactly that reason.
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

  it("passes the shipped tree against the real default-branch listing", (ctx) => {
    if (resolvedDefaultBranchRef === undefined) {
      return; // No local ref resolved, so there is no listing to compare against here.
    }

    // The leg's premise is a default-branch-shaped shipped tree, which only the default
    // branch's own checkout guarantees. On any other host — a migration-carrying branch above
    // all (issue 522) — the assertion would fail by construction, and the CLI legs carry the
    // guard's real coverage there instead. The yield goes through ctx.skip() rather than an
    // early return so the RUNNER reports it: a passed leg's console output is suppressed under
    // the default reporter, so the skip must surface in the reported counts (issue 522 review).
    const hostBranchName = gitOutput(repositoryRoot, "rev-parse", "--abbrev-ref", "HEAD");
    const defaultBranchName = resolvedDefaultBranchRef.replace(
      /^refs\/(?:remotes|heads)\/(?:origin\/)?/,
      "",
    );
    if (hostBranchName !== defaultBranchName) {
      ctx.skip(
        `the checked-out branch (${hostBranchName}) is not ${defaultBranchName}, so the ` +
          "shipped tree is not default-branch-shaped and the leg's premise does not hold " +
          "(issue 522); the CLI legs carry the guard's coverage on a branch.",
      );
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

describe("the exported runMigrations, which the guard must stay out of", () => {
  beforeEach(() => {
    migrationsOnDisk.entries = [];
    databaseClient.withTransaction.mockClear();
  });

  it("applies a foreign migration without the default-branch refusal, which is the CLI guard's alone", async () => {
    migrationsOnDisk.entries = ["001_a.sql", "999_foreign_to_the_default_branch.sql"];

    // The refusal belongs to the command-line path only: runMigrations() is what testcontainer
    // suites and CI call directly, and routing it through the guard would need every suite to
    // seed refs none carries. The stub rejection below is the pin — the run must proceed past
    // the tree checks and into the runner proper, never the issue-511 refusal.
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

    // The fake migration lives in a private linked worktree rather than the shared
    // db/migrations/: vitest runs test files in parallel workers, every other suite seeds
    // through the unguarded runMigrations(), which enumerates that directory, and a file left
    // there for this suite's window lands in other suites' ledgers (tests/db/schema.test.ts
    // pins exact ledger contents). A linked worktree shares the refs, so the guard's
    // default-branch resolution and listing behave identically to the real tree's.
    privateWorktreeRoot = mkdtempSync(path.join(os.tmpdir(), "migrate-guard-worktree-"));
    git(repositoryRoot, "worktree", "add", privateWorktreeRoot, "HEAD");
    // A migration-carrying host branch must not red this suite (issue 522): created from HEAD,
    // the linked worktree would inherit the host branch's db/migrations, and a branch-only
    // migration there would survive the fake's removal and refuse the clean run below. So the
    // private tree's migration set is pinned to the default branch's: the tracked set is
    // removed first because `git checkout <ref> -- db/migrations` only overwrites the files
    // the ref carries — a branch-only file is left behind (tested, issue 522) — and the
    // default branch's set is checked out over the emptied directory. The CLI under test
    // remains the branch's own scripts/migrate.ts; only the database-facing tree moves. The
    // swap stages a diff in the private worktree — harmless, afterAll force-removes the tree.
    if (resolvedDefaultBranchRef !== undefined) {
      git(privateWorktreeRoot, "rm", "-q", "-r", "db/migrations");
      git(privateWorktreeRoot, "checkout", resolvedDefaultBranchRef, "--", "db/migrations");
    }
    // The linked worktree carries no node_modules of its own; the symlink keeps the spawned
    // runner's imports resolvable without copying the store. Only node runs from here, so the
    // symlink is enough — nothing builds in this tree.
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

  afterAll(async () => {
    if (privateWorktreeRoot !== undefined) {
      // Proper removal first, tolerating its failure so the fallbacks still run: the raw delete
      // keeps a crashed add from stranding the directory, and the prune keeps a half-removed
      // registration from stranding the repository's worktree list.
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
      // The comparison reads the PRIVATE worktree's listing (issue 522): that is the tree the
      // run actually enumerated, while the shared db/migrations/ listing is host-branch-shaped
      // and would compare a default-branch run against a branch-only count.
      expect(applied).toBeGreaterThanOrEqual(
        listMigrationNames(readdirSync(path.join(worktreeRoot(), "db/migrations"))).length,
      );
    } finally {
      await sql.end();
    }
  });

  it("runs clean once the tree carries nothing foreign", async () => {
    rmSync(path.join(worktreeRoot(), "db/migrations", fakeMigrationName), { force: true });

    const clean = runCli(undefined);

    expect(clean.status).toBe(0);
    // The fail-open skip line cites the issue too, so the refusal phrase — not the issue
    // number — is what marks a refusal here.
    expect(clean.stderr).not.toContain("is frozen there under its name");
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

/** Runs git without failing the caller when it does — cleanup paths run whether or not git can. */
function gitQuietly(root: string, ...args: string[]): void {
  spawnSync("git", args, { cwd: root, encoding: "utf8" });
}

function gitOutput(root: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}
