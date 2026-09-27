import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const migrationHarness = vi.hoisted(() => ({
  entries: [] as string[],
  contents: new Map<string, string>(),
  persistedMigrations: new Map<string, string | null>(),
  transactions: [] as {
    migrationName: string;
    state: "pending" | "committed" | "failed";
  }[],
  failMigration: undefined as string | undefined,
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
import { applyAndRecordMigration } from "../../scripts/migrate";

type TransactionWork = (sql: unknown) => Promise<unknown>;

function installTransactionDouble(): void {
  migrationHarness.withTransaction.mockImplementation(async (work: TransactionWork) => {
    const transaction: {
      migrationName: string;
      state: "pending" | "committed" | "failed";
    } = {
      migrationName: "schema_migrations lookup",
      state: "pending",
    };
    migrationHarness.transactions.push(transaction);
    let pendingMigration: { name: string; checksum: string } | undefined;

    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const statement = strings.join("");
        if (statement.includes("select name, checksum from schema_migrations")) {
          return [...migrationHarness.persistedMigrations].map(([name, checksum]) => ({
            name,
            checksum,
          }));
        }

        if (statement.includes("insert into schema_migrations")) {
          pendingMigration = {
            name: String(values[0]),
            checksum: String(values[1]),
          };
          transaction.migrationName = pendingMigration.name;
        }

        return [];
      },
      {
        unsafe: async (statement: string) => {
          const migrationName = [...migrationHarness.contents].find(
            ([, contents]) => contents === statement,
          )?.[0];
          if (migrationName !== undefined) {
            transaction.migrationName = migrationName;
            if (migrationHarness.failMigration === migrationName) {
              throw new Error(`Failed migration ${migrationName}`);
            }
          }

          return [];
        },
      },
    );

    try {
      const result = await work(sql);
      if (pendingMigration !== undefined) {
        migrationHarness.persistedMigrations.set(
          pendingMigration.name,
          pendingMigration.checksum,
        );
      }
      transaction.state = "committed";
      return result;
    } catch (error) {
      transaction.state = "failed";
      throw error;
    }
  });
}

describe("migration reporting", () => {
  beforeEach(() => {
    migrationHarness.entries = ["001_a.sql", "002_b.sql"];
    migrationHarness.contents = new Map([
      ["001_a.sql", "select 1;"],
      ["002_b.sql", "select 2;"],
    ]);
    migrationHarness.persistedMigrations = new Map();
    migrationHarness.transactions = [];
    migrationHarness.failMigration = undefined;
    migrationHarness.withTransaction.mockReset();
    installTransactionDouble();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns the names of migrations whose transactions committed and stays library-quiet", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const appliedNames = await migrationModule.runMigrations();

    expect(appliedNames).toEqual(["001_a.sql", "002_b.sql"]);
    expect(migrationHarness.transactions).toEqual([
      { migrationName: "schema_migrations lookup", state: "committed" },
      { migrationName: "001_a.sql", state: "committed" },
      { migrationName: "002_b.sql", state: "committed" },
    ]);
    expect([...migrationHarness.persistedMigrations.keys()]).toEqual([
      "001_a.sql",
      "002_b.sql",
    ]);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("does not settle or persist a migration after a later migration fails", async () => {
    migrationHarness.failMigration = "002_b.sql";
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await expect(migrationModule.runMigrations()).rejects.toThrow("Failed migration 002_b.sql");

    expect(migrationHarness.transactions).toEqual([
      { migrationName: "schema_migrations lookup", state: "committed" },
      { migrationName: "001_a.sql", state: "committed" },
      { migrationName: "002_b.sql", state: "failed" },
    ]);
    expect([...migrationHarness.persistedMigrations.keys()]).toEqual(["001_a.sql"]);
    expect(stderrWrite).not.toHaveBeenCalled();
    expect(stdoutWrite).not.toHaveBeenCalled();

    migrationHarness.failMigration = undefined;
    migrationHarness.transactions = [];
    await expect(migrationModule.runMigrations()).resolves.toEqual(["002_b.sql"]);
    expect(migrationHarness.transactions).toEqual([
      { migrationName: "schema_migrations lookup", state: "committed" },
      { migrationName: "002_b.sql", state: "committed" },
    ]);
    expect([...migrationHarness.persistedMigrations.keys()]).toEqual([
      "001_a.sql",
      "002_b.sql",
    ]);
  });

  it("records a migration name only after its transaction resolves", async () => {
    const appliedNames: string[] = [];
    let settleTransaction!: () => void;
    const transaction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleTransaction = resolve;
        }),
    );

    const recording = applyAndRecordMigration(appliedNames, "001_a.sql", transaction);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(appliedNames).toEqual([]);
    settleTransaction();
    await recording;
    expect(appliedNames).toEqual(["001_a.sql"]);
  });

  it("does not record a migration name when its transaction rejects", async () => {
    const appliedNames: string[] = [];

    await expect(
      applyAndRecordMigration(appliedNames, "002_b.sql", async () => {
        throw new Error("transaction rolled back");
      }),
    ).rejects.toThrow("transaction rolled back");

    expect(appliedNames).toEqual([]);
  });

  it("prints each applied filename through the direct CLI entry and leaves stdout empty", async () => {
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalEntrypoint = process.argv[1];
    vi.stubEnv("OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD", "skip");
    process.argv[1] = fileURLToPath(new URL("../../scripts/migrate.ts", import.meta.url));

    try {
      vi.resetModules();
      await import("../../scripts/migrate");
    } finally {
      process.argv[1] = originalEntrypoint;
    }

    const stderr = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(
      stderr.endsWith(
        "applied db/migrations/001_a.sql\n" +
          "applied db/migrations/002_b.sql\n" +
          "applied 2 migrations\n",
      ),
    ).toBe(true);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("uses the singular count for a one-migration direct CLI run", async () => {
    migrationHarness.entries = ["001_a.sql"];
    migrationHarness.contents = new Map([["001_a.sql", "select 1;"]]);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const originalEntrypoint = process.argv[1];
    vi.stubEnv("OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD", "skip");
    process.argv[1] = fileURLToPath(new URL("../../scripts/migrate.ts", import.meta.url));

    try {
      vi.resetModules();
      await import("../../scripts/migrate");
    } finally {
      process.argv[1] = originalEntrypoint;
    }

    const stderr = stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(
      stderr.endsWith("applied db/migrations/001_a.sql\n" + "applied 1 migration\n"),
    ).toBe(true);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
