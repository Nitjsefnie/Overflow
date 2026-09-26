import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundledMigrationNames, isSchemaUpToDate } from "@/lib/db/migration-manifest";
import { listMigrationNames } from "../../scripts/migrate";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

describe("the bundled migration manifest", () => {
  it("lists exactly the migrations db/migrations carries, in application order", () => {
    expect(bundledMigrationNames).toEqual(listMigrationNames(readdirSync(migrationsDirectory)));
  });
});

describe("the schema up-to-date predicate", () => {
  // Every name is derived from the manifest itself, so the predicate's cases
  // track the real migration set instead of pinning any of its filenames.
  const bundled = bundledMigrationNames;

  it("refuses an empty applied set: nothing applied is behind", () => {
    expect(isSchemaUpToDate([])).toBe(false);
  });

  it("refuses a schema missing the newest bundled migration", () => {
    const newest = bundled[bundled.length - 1];
    expect(isSchemaUpToDate(bundled.filter((name) => name !== newest))).toBe(false);
  });

  it("refuses a schema missing a middle bundled migration", () => {
    const middle = bundled[Math.floor(bundled.length / 2)];
    expect(isSchemaUpToDate(bundled.filter((name) => name !== middle))).toBe(false);
  });

  it("accepts a schema that records exactly the bundled migrations", () => {
    expect(isSchemaUpToDate([...bundled])).toBe(true);
  });

  it("accepts the bundled names however their rows are ordered", () => {
    expect(isSchemaUpToDate([...bundled].reverse())).toBe(true);
  });

  it("accepts a schema ahead of the build: extra applied rows are not staleness", () => {
    expect(isSchemaUpToDate([...bundled, "9999_ahead_of_this_build.sql"])).toBe(true);
  });

  it("refuses a schema ahead AND behind: an extra row does not cover a missing one", () => {
    expect(isSchemaUpToDate([...bundled.slice(1), "9999_ahead_of_this_build.sql"])).toBe(false);
  });
});
