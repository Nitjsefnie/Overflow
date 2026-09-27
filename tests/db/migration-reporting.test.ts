import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const migrationHarness = vi.hoisted(() => ({
  entries: [] as string[],
  contents: new Map<string, string>(),
  withTransaction: vi.fn(),
  closeSql: vi.fn(() => Promise.resolve()),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readdir: () => Promise.resolve(migrationHarness.entries),
  readFile: (fileName: string) => {
    const migrationName = fileName.split(/[\\/]/).at(-1) ?? "";
    const contents = migrationHarness.contents.get(migrationName);
    return contents === undefined
      ? Promise.reject(new Error(`Unexpected migration read: ${fileName}`))
      : Promise.resolve(contents);
  },
}));

vi.mock("../../src/lib/db/client.ts", () => ({
  withTransaction: migrationHarness.withTransaction,
  closeSql: migrationHarness.closeSql,
}));

import * as migrationModule from "../../scripts/migrate";

describe("migration reporting", () => {
  beforeEach(() => {
    migrationHarness.entries = ["001_a.sql", "002_b.sql"];
    migrationHarness.contents = new Map([
      ["001_a.sql", "select 1;"],
      ["002_b.sql", "select 2;"],
    ]);
    migrationHarness.withTransaction.mockReset();
    migrationHarness.withTransaction
      .mockResolvedValueOnce(new Map())
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns only the migration filenames whose transactions applied", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(migrationModule.runMigrations()).resolves.toEqual([
      "001_a.sql",
      "002_b.sql",
    ]);

    expect(stderrWrite).not.toHaveBeenCalled();
  });

  it("prints every applied filename and their total count to stderr", () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const printAppliedMigrations = (
      migrationModule as unknown as {
        printAppliedMigrations?: (migrationNames: string[]) => void;
      }
    ).printAppliedMigrations;

    expect(printAppliedMigrations).toBeTypeOf("function");
    if (printAppliedMigrations === undefined) {
      return;
    }

    printAppliedMigrations(["001_a.sql", "002_b.sql"]);

    expect(stderrWrite.mock.calls.map(([chunk]) => chunk).join("")).toBe(
      "applied db/migrations/001_a.sql\n" +
        "applied db/migrations/002_b.sql\n" +
        "applied 2 migrations\n",
    );
  });
});
