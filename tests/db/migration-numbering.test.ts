import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertUniqueMigrationNumbers } from "../../scripts/migrate";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

/** The message, not the throw, is what tells whoever hit this which files to renumber. */
function collisionMessage(migrationNames: readonly string[]): string {
  try {
    assertUniqueMigrationNumbers(migrationNames);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Expected a collision to be reported for ${migrationNames.join(", ")}.`);
}

describe("migration numbering", () => {
  it("accepts the migrations this repository ships", async () => {
    const migrationNames = await readdir(migrationsDirectory);

    expect(() => {
      assertUniqueMigrationNumbers(migrationNames);
    }).not.toThrow();
  });

  it("names the number and both files when two migrations share a number", () => {
    const message = collisionMessage([
      "013_immutable_github_identity.sql",
      "014_a.sql",
      "014_b.sql",
    ]);

    expect(message).toMatch(/\b14\b/);
    expect(message).toContain("014_a.sql");
    expect(message).toContain("014_b.sql");
  });

  it("compares the parsed number, so 013 collides with 13", () => {
    const message = collisionMessage(["013_alpha.sql", "13_beta.sql"]);

    expect(message).toMatch(/\b13\b/);
    expect(message).toContain("013_alpha.sql");
    expect(message).toContain("13_beta.sql");
  });

  it("ignores directory entries that are not numbered migrations", () => {
    expect(() => {
      assertUniqueMigrationNumbers(["README.md", "001_initial.sql"]);
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

  it("rejects a third migration numbered 013 alongside the historical pair", () => {
    const message = collisionMessage([
      "013_immutable_github_identity.sql",
      "013_reconciliation_cooldown.sql",
      "013_something_else.sql",
    ]);

    expect(message).toMatch(/\b13\b/);
    expect(message).toContain("013_something_else.sql");
  });

  it("rejects a grandfathered filename paired with a different 013 migration", () => {
    const message = collisionMessage([
      "013_immutable_github_identity.sql",
      "013_something_else.sql",
    ]);

    expect(message).toContain("013_immutable_github_identity.sql");
    expect(message).toContain("013_something_else.sql");
  });
});
