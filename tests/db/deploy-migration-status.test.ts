import { describe, expect, it } from "vitest";
import { pendingMigrationLines } from "../../scripts/deploy-migration-status";

describe("pending deploy migration status", () => {
  it("marks only unapplied migrations containing the mixed-version review marker", () => {
    const tree = new Map([
      ["052_unmarked.sql", "alter table items add column note text;\n"],
      [
        "053_mixed_version_review.sql",
        "-- reviewed later: overflow: mixed-version review\nalter table items add constraint items_note_check check (note <> '');\n",
      ],
      ["054_applied.sql", "-- overflow: mixed-version review\nselect 1;\n"],
    ]);
    const applied = new Set(["054_applied.sql"]);

    expect(pendingMigrationLines(tree, applied)).toEqual([
      "052_unmarked.sql\t-",
      "053_mixed_version_review.sql\treview",
    ]);
  });
});
