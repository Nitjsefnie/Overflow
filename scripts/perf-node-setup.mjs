// Runtime setup for performance measurement and migration children.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Retain Node's existing warning handlers, including their formatting/stack
// behavior. Only this known transform notice is handled; all others pass through.
for (const handler of process.rawListeners("warning")) {
  process.removeListener("warning", handler);
  process.on("warning", function (warning) {
    if (warning.name === "ExperimentalWarning"
      && warning.message === "Transform Types is an experimental feature and might change at any time") return;
    handler.call(this, warning);
  });
}

// NODE_OPTIONS reaches pnpm too. Guard only the actual migration entry point,
// and inspect the singleton client that migrate.ts subsequently uses.
const migrationPath = fileURLToPath(new URL("./migrate.ts", import.meta.url));
if (process.env.PERF_EXPECTED_DATABASE !== undefined
  && resolve(process.argv[1] ?? "") === migrationPath) {
  const { getSql, closeSql } = await import("../src/lib/db/client.ts");
  const expected = process.env.PERF_EXPECTED_DATABASE;
  try {
    const [row] = await getSql()`select current_database() as database`;
    if (row?.database !== expected) {
      throw new Error(`database target mismatch: expected ${expected}, got ${row?.database ?? "absent"}`);
    }
    process.stderr.write(`performance migration verified database: ${expected}\n`);
  } catch (error) {
    await closeSql();
    throw error;
  }
}
