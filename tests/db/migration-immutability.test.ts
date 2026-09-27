import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migrationImmutabilityViolations } from "../../scripts/check-migration-edits";

describe("migration immutability", () => {
  const migration = "db/migrations/001_initial.sql";

  it("accepts identical migration maps", () => {
    const base = new Map<string, string>([[migration, "blob-a"]]);
    const head = new Map(base);

    expect(migrationImmutabilityViolations(base, head)).toEqual([]);
  });

  it("names an edited migration", () => {
    const base = new Map<string, string>([[migration, "blob-a"]]);
    const head = new Map<string, string>([[migration, "blob-b"]]);

    const violations = migrationImmutabilityViolations(base, head);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(migration);
  });

  it("names a migration missing from the head", () => {
    const base = new Map<string, string>([[migration, "blob-a"]]);

    const violations = migrationImmutabilityViolations(base, new Map());

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(migration);
  });

  it("does not report migrations added on the head", () => {
    const addedMigration = "db/migrations/002_added.sql";
    const head = new Map<string, string>([[addedMigration, "blob-b"]]);

    expect(migrationImmutabilityViolations(new Map(), head)).toEqual([]);
  });

  it("reports a renamed migration under its removed base name", () => {
    const renamedMigration = "db/migrations/002_renamed.sql";
    const base = new Map<string, string>([[migration, "blob-a"]]);
    const head = new Map<string, string>([[renamedMigration, "blob-a"]]);

    const violations = migrationImmutabilityViolations(base, head);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(migration);
    expect(violations[0]).not.toContain(renamedMigration);
  });

  it("fails closed when the CLI cannot resolve a revision", () => {
    const missingRevision = "__task2_missing_base_revision__";
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/check-migration-edits.ts"), missingRevision, "HEAD"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Could not list db/migrations on ${missingRevision}`);
  });
});
