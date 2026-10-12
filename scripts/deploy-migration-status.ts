import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSql, withTransaction } from "../src/lib/db/client.ts";
import { listMigrationNames } from "./migrate.ts";
import { classifyMigrationCompatibility } from "./migration-compatibility.ts";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

export function pendingMigrationLines(
  tree: ReadonlyMap<string, string>,
  applied: ReadonlySet<string>,
): string[] {
  return [...tree.entries()]
    .filter(([name]) => !applied.has(name))
    .map(([name, contents]) => {
      const { verdict, shapes, note } = classifyMigrationCompatibility(contents);
      const detail = note ?? shapes.join(", ");
      return `${name}\t${verdict}${detail ? `\t${detail}` : ""}`;
    });
}

/** The CLI's file-reading path, also usable with a fixture directory. */
export async function readMigrationTree(directory = migrationsDirectory): Promise<Map<string, string>> {
  const migrationNames = listMigrationNames(await readdir(directory));
  const tree = new Map<string, string>();
  for (const name of migrationNames) {
    tree.set(name, await readFile(path.join(directory, name), "utf8"));
  }
  return tree;
}

async function listPendingMigrationLines(): Promise<string[]> {
  const tree = await readMigrationTree();
  const applied = await withTransaction(async (sql) => {
    const rows = await sql<{ name: string }[]>`select name from schema_migrations`;
    return new Set(rows.map(({ name }) => name));
  });

  return pendingMigrationLines(tree, applied);
}

if (isDirectExecution()) {
  try {
    const lines = await listPendingMigrationLines();
    if (lines.length > 0) {
      process.stdout.write(`${lines.join("\n")}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Could not list pending migrations: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await closeSql();
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
