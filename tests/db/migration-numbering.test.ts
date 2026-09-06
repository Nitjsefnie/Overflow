import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertUniformMigrationNumberWidth,
  assertUniqueMigrationNumbers,
  listMigrationNames,
  runMigrations,
} from "../../scripts/migrate";

const migrationsOnDisk = vi.hoisted(() => ({ entries: [] as string[] }));
const databaseClient = vi.hoisted(() => ({
  withTransaction: vi.fn(() => Promise.reject(new Error("the database client is stubbed here"))),
  closeSql: vi.fn(() => Promise.resolve()),
}));

// Standing in for the directory is what lets the production entry point be driven at all, and
// standing in for the database is what makes the run hermetic: without it, the only thing keeping
// these cases off whatever `DATABASE_URL` names is the guard they are testing.
//
// The listing is spread over the real module rather than replacing it, so that the day anything
// in this module graph reaches for a third `node:fs/promises` export it finds the real one
// instead of a hole. `readFile` guards a path no case here reaches: with the guards in place a
// bad directory stops before any migration is read, and a run that got that far would rather say
// so than read from disk.
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readdir: () => Promise.resolve(migrationsOnDisk.entries),
  readFile: () => Promise.reject(new Error("a migration was read despite unusable numbering")),
}));
vi.mock("../../src/lib/db/client.ts", () => databaseClient);

// Read with the synchronous API on purpose: the promise-based one is mocked above, and this is
// the one test that has to see the real directory.
const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

/** The message, not the throw, is what tells whoever hit this which files are wrong. */
function rejectionMessage(check: () => void): string {
  try {
    check();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected the numbering to be rejected.");
}

describe("migration numbering", () => {
  beforeEach(() => {
    migrationsOnDisk.entries = [];
    databaseClient.withTransaction.mockClear();
  });

  it("accepts the migrations this repository ships", () => {
    const migrationNames = listMigrationNames(readdirSync(migrationsDirectory));

    expect(migrationNames.length).toBeGreaterThan(0);
    expect(() => {
      assertUniqueMigrationNumbers(migrationNames);
    }).not.toThrow();
    expect(() => {
      assertUniformMigrationNumberWidth(migrationNames);
    }).not.toThrow();
  });

  it("selects migrations by the rule the runner applies them by, in filename order", () => {
    const migrationNames = listMigrationNames([
      "010_c.sql",
      "README.md",
      "001_initial.sql",
      "013_reconciliation_cooldown.sql.orig",
      "002_b.sql",
    ]);

    expect(migrationNames).toEqual(["001_initial.sql", "002_b.sql", "010_c.sql"]);
  });

  it("names the number and both files when two migrations share a number", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers([
        "013_immutable_github_identity.sql",
        "014_a.sql",
        "014_b.sql",
      ]);
    });

    expect(message).toMatch(/\b14\b/);
    expect(message).toContain("014_a.sql, 014_b.sql");
  });

  it("compares the parsed number, so 013 collides with 13", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers(["13_beta.sql", "013_alpha.sql"]);
    });

    expect(message).toMatch(/\b13\b/);
    expect(message).toContain("013_alpha.sql, 13_beta.sql");
  });

  it("counts nothing the runner would not apply, such as a merge leftover", () => {
    expect(() => {
      assertUniqueMigrationNumbers([
        "README.md",
        "013_reconciliation_cooldown.sql.orig",
        "013_reconciliation_cooldown.sql",
      ]);
    }).not.toThrow();
  });

  it("permits the historical 013 pair that is already applied to production", () => {
    expect(() => {
      assertUniqueMigrationNumbers([
        "012_unwritable_closure_kinds.sql",
        "013_immutable_github_identity.sql",
        "013_reconciliation_cooldown.sql",
        "014_opening_authority_precondition.sql",
      ]);
    }).not.toThrow();
  });

  it("reports every colliding number in one throw", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers(["015_d.sql", "014_a.sql", "015_c.sql", "014_b.sql"]);
    });

    expect(message).toContain("numbered 14: 014_a.sql, 014_b.sql; 15: 015_c.sql, 015_d.sql");
  });

  it("reports colliding numbers in numeric order, not in filename order", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers(["001_a.sql", "001_b.sql", "0003_c.sql", "0003_d.sql"]);
    });

    expect(message).toContain("numbered 1: 001_a.sql, 001_b.sql; 3: 0003_c.sql, 0003_d.sql");
  });

  it("rejects a third migration numbered 013 alongside the historical pair", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers([
        "013_immutable_github_identity.sql",
        "013_reconciliation_cooldown.sql",
        "013_something_else.sql",
      ]);
    });

    expect(message).toMatch(/\b13\b/);
    expect(message).toContain("013_something_else.sql");
  });

  it("rejects a grandfathered filename paired with a different 013 migration", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers([
        "013_immutable_github_identity.sql",
        "013_something_else.sql",
      ]);
    });

    expect(message).toContain("013_immutable_github_identity.sql, 013_something_else.sql");
  });

  it("does not exempt a grandfathered filename listed twice in place of its partner", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers([
        "013_immutable_github_identity.sql",
        "013_immutable_github_identity.sql",
        "013_reconciliation_cooldown.sql",
      ]);
    });

    expect(message).toContain("013_immutable_github_identity.sql");
  });

  it("does not exempt a case-differing spelling of a grandfathered filename", () => {
    const message = rejectionMessage(() => {
      assertUniqueMigrationNumbers([
        "013_Immutable_GitHub_Identity.sql",
        "013_reconciliation_cooldown.sql",
      ]);
    });

    expect(message).toContain("013_Immutable_GitHub_Identity.sql");
  });

  it("rejects a numeric prefix narrower than the rest", () => {
    const message = rejectionMessage(() => {
      assertUniformMigrationNumberWidth(["018_a.sql", "019_b.sql", "20_c.sql"]);
    });

    expect(message).toContain("2 digits (20_c.sql)");
    expect(message).toContain("3 digits (018_a.sql, 019_b.sql)");
  });

  it("rejects a numeric prefix wider than the rest", () => {
    const message = rejectionMessage(() => {
      assertUniformMigrationNumberWidth(["001_a.sql", "002_b.sql", "0003_c.sql"]);
    });

    expect(message).toContain("3 digits (001_a.sql, 002_b.sql)");
    expect(message).toContain("4 digits (0003_c.sql)");
  });

  it("reports every width in width order when more than two are in use", () => {
    const message = rejectionMessage(() => {
      assertUniformMigrationNumberWidth(["0001_a.sql", "001_b.sql", "01_c.sql"]);
    });

    expect(message).toContain("2 digits (01_c.sql), 3 digits (001_b.sql), 4 digits (0001_a.sql)");
  });

  it("says what to do at the boundary crossing that has no width to renumber to", () => {
    const message = rejectionMessage(() => {
      assertUniformMigrationNumberWidth(["8_h.sql", "9_i.sql", "10_j.sql"]);
    });

    expect(message).toContain("1 digit (8_h.sql, 9_i.sql), 2 digits (10_j.sql)");
    expect(message).toContain("before the first migration at the new width is applied");
  });

  it("accepts a uniform width other than the one this repository writes", () => {
    expect(() => {
      assertUniformMigrationNumberWidth(["01_a.sql", "02_b.sql"]);
    }).not.toThrow();
  });

  it("refuses to run a directory in which two migrations share a number", async () => {
    migrationsOnDisk.entries = ["002_c.sql", "001_a.sql", "002_b.sql"];

    await expect(runMigrations()).rejects.toThrow(
      "More than one migration is numbered 2: 002_b.sql, 002_c.sql",
    );
    expect(databaseClient.withTransaction).not.toHaveBeenCalled();
  });

  it("refuses to run a directory that mixes numeric prefix widths", async () => {
    migrationsOnDisk.entries = ["001_a.sql", "002_b.sql", "03_c.sql"];

    await expect(runMigrations()).rejects.toThrow("db/migrations mixes numeric prefix widths");
    expect(databaseClient.withTransaction).not.toHaveBeenCalled();
  });

  it("refuses a collision even when upTo stops short of it", async () => {
    migrationsOnDisk.entries = ["001_a.sql", "002_b.sql", "002_c.sql"];

    await expect(runMigrations({ upTo: "001_a.sql" })).rejects.toThrow(
      "More than one migration is numbered 2: 002_b.sql, 002_c.sql",
    );
    expect(databaseClient.withTransaction).not.toHaveBeenCalled();
  });

  it("refuses a mixed prefix width even when upTo stops short of it", async () => {
    migrationsOnDisk.entries = ["001_a.sql", "002_b.sql", "03_c.sql"];

    await expect(runMigrations({ upTo: "001_a.sql" })).rejects.toThrow(
      "db/migrations mixes numeric prefix widths",
    );
    expect(databaseClient.withTransaction).not.toHaveBeenCalled();
  });

  // The witness for every `not.toHaveBeenCalled` above: an unbound mock reports no calls just as
  // quietly as a bound one the guards stopped short of, so one usable directory has to reach it.
  it("reaches the database once the numbering is usable", async () => {
    migrationsOnDisk.entries = ["001_a.sql", "002_b.sql"];

    await expect(runMigrations()).rejects.toThrow("the database client is stubbed here");
    expect(databaseClient.withTransaction).toHaveBeenCalled();
  });
});
