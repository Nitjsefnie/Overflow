import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendingMigrationLines, readMigrationTree } from "../../scripts/deploy-migration-status";
import { migrationCompatibilityFixtures } from "../fixtures/migration-compatibility";

let fixturesDirectory: string;
const migrationsDirectory = fileURLToPath(new URL("../../db/migrations/", import.meta.url));

beforeAll(async () => {
  fixturesDirectory = await mkdtemp(path.join(tmpdir(), "overflow-1055-migration-fixtures-"));
  for (const { name, contents } of migrationCompatibilityFixtures) {
    await writeFile(path.join(fixturesDirectory, name), contents);
  }
});

afterAll(async () => {
  if (fixturesDirectory) await rm(fixturesDirectory, { recursive: true, force: true });
});

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
    ["030_unicode_column.sql", "alter type"],
    ["031_dollar_default_data.sql", "add column not null without default"],
    ["032_safe_marker_in_notice.sql", "drop column"],
    ["033_escaped_e_string.sql", "drop column"],
    ["034_quoted_semicolon.sql", "rename"],
    ["035_quoted_whitespace.sql", "alter type"],
    ["036_unicode_optional_column.sql", "alter type"],
    ["037_doubled_string_quote.sql", "drop column"],
    ["038_safe_marker_in_dollar_data.sql", "drop column"],
    ["041_executable_do_body.sql", "drop column"],
    ["042_executable_function_body.sql", "drop column"],
    ["045_doubled_identifier_quote.sql", "alter type"],
    ["046_nested_do_body.sql", "drop column"],
    ["047_nested_do_language.sql", "drop column"],
    ["048_do_named_function_data.sql", "drop column"],
    ["049_nested_quoted_language.sql", "drop column"],
    ["039_ordinary_literal_shapes.sql", "drop column"],
    ["040_dollar_literal_shapes.sql", "drop column"],
    ["043_safe_comment_in_do.sql", "drop column"],
    ["050_ordinary_do_body.sql", "drop column"],
    ["051_e_do_body.sql", "drop column"],
    ["052_ordinary_function_body.sql", "drop column"],
    ["053_fixed_execute_literal.sql", "drop column"],
    ["054_insert_shape_data.sql", "drop column"],
    ["055_nested_ordinary_execute.sql", "drop column"],
    ["056_nested_e_execute.sql", "drop column"],
    ["057_literal_default_clause.sql", "add column not null without default"],
    ["058_e_hex_space.sql", "drop column"],
    ["059_e_octal_space.sql", "drop column"],
    ["060_e_unicode_space.sql", "drop column"],
    ["061_e_long_unicode_space.sql", "drop column"],
  ])("flags %s with its matched shapes", async (name, shapes) => {
    const tree = await readMigrationTree(fixturesDirectory);
    expect(tree.has(name), `disk-backed fixture ${name}`).toBe(true);
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

  it.each(["015_safe_marker.sql"])("downgrades a shape hit with a reasoned safe comment in %s", async (name) => {
    const tree = await readMigrationTree(fixturesDirectory);
    expect(pendingMigrationLines(new Map([[name, tree.get(name)!]]), new Set())).toEqual([
      `${name}\t-\toverflow: mixed-version safe: retained releases stopped using note`,
    ]);
  });

  it.each(["020_review_comment.sql", "044_raw_review_literal.sql"])("honors the raw review marker in %s", async (name) => {
    const tree = await readMigrationTree(fixturesDirectory);
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

  it.each([
    ["062_wide_literal.sql", "", "-"],
    ["063_wide_literal_shape.sql", "SELECT 'ALTER TABLE items DROP COLUMN note;';\n", "review\tdrop column"],
  ])("classifies %s with 150000 child literals without overflowing or skipping the last child", async (name, suffix, status) => {
    const contents = "SELECT $data$" + "SELECT 'a';\n".repeat(150000) + suffix + "$data$;";
    await writeFile(path.join(fixturesDirectory, name), contents);
    const tree = await readMigrationTree(fixturesDirectory);
    expect(tree.get(name)).toBe(contents);
    expect(pendingMigrationLines(new Map([[name, tree.get(name)!]]), new Set())).toEqual([
      `${name}\t${status}`,
    ]);
  });
});
