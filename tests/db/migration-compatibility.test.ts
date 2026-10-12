import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { pendingMigrationLines, readMigrationTree } from "../../scripts/deploy-migration-status";

const fixturesDirectory = fileURLToPath(new URL("../fixtures/migration-compatibility/", import.meta.url));
const migrationsDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

describe("migration compatibility fixtures", () => {
  it.each([
    ["001_drop_column.sql", "drop column"],
    ["002_drop_table.sql", "drop table"],
    ["003_rename_column.sql", "rename"],
    ["004_rename_table.sql", "rename"],
    ["005_alter_column_type.sql", "alter type"],
    ["006_alter_type_without_column.sql", "alter type"],
    ["007_set_data_type.sql", "alter type"],
    ["008_set_not_null.sql", "set not null"],
    ["009_add_not_null.sql", "add column not null without default"],
    ["016_empty_safe.sql", "drop column"],
    ["017_review_beats_safe.sql", "drop column"],
    ["021_per_column_default.sql", "add column not null without default"],
    ["023_comment_between_tokens.sql", "drop column"],
    ["024_multiple_shapes.sql", "drop column, rename"],
    ["025_default_in_check.sql", "add column not null without default"],
    ["026_default_column_name.sql", "add column not null without default"],
    ["028_quoted_comment_delimiter.sql", "drop column"],
    ["029_identifier_comment_delimiter.sql", "drop column"],
  ])("flags %s with its matched shapes", async (name, shapes) => {
    const tree = await readMigrationTree(fixturesDirectory);
    expect(pendingMigrationLines(new Map([[name, tree.get(name)!]]), new Set())).toEqual([
      `${name}\treview\t${shapes}`,
    ]);
  });

  it.each([
    "010_create_table.sql", "011_add_default.sql", "012_add_nullable.sql",
    "013_create_index.sql", "014_drop_not_null.sql", "018_line_comment.sql",
    "019_block_comment.sql", "022_drop_default.sql", "027_nested_comment.sql",
  ])("does not flag %s", async (name) => {
    const tree = await readMigrationTree(fixturesDirectory);
    expect(pendingMigrationLines(new Map([[name, tree.get(name)!]]), new Set())).toEqual([`${name}\t-`]);
  });

  it("downgrades a shape hit with a reasoned safe comment", async () => {
    const tree = await readMigrationTree(fixturesDirectory);
    const name = "015_safe_marker.sql";
    expect(pendingMigrationLines(new Map([[name, tree.get(name)!]]), new Set())).toEqual([
      `${name}\t-\toverflow: mixed-version safe: retained releases stopped using note`,
    ]);
  });

  it("honors a review marker inside a block comment", async () => {
    const tree = await readMigrationTree(fixturesDirectory);
    const name = "020_review_comment.sql";
    expect(pendingMigrationLines(new Map([[name, tree.get(name)!]]), new Set())).toEqual([`${name}\treview`]);
  });

  it("classifies every bundled migration and flags the evidence column removal", async () => {
    const tree = await readMigrationTree(migrationsDirectory);
    const lines = pendingMigrationLines(tree, new Set());
    expect(lines).toHaveLength(tree.size);
    expect(lines.find((line) => line.startsWith("057_fold_evidence_facts.sql\t"))).toBe(
      "057_fold_evidence_facts.sql\treview\tdrop column",
    );
  });
});
