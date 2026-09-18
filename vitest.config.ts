import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Issue 626 — bound this run's worker pool (own block so overlapping branches
// rebase cleanly).
//
// VITEST_MAX_WORKERS (numeric) wins; else the key stays absent — vitest's own
// unbounded default — when CI is set; otherwise a local default of 2 bounds
// the pool on the shared box. A non-numeric VITEST_MAX_WORKERS is treated as
// unset. Pinned by tests/config/vitest-max-workers.test.ts.
// ---------------------------------------------------------------------------
const rawMaxWorkers = process.env.VITEST_MAX_WORKERS;
const numericMaxWorkers =
  rawMaxWorkers !== undefined && /^\d+$/.test(rawMaxWorkers) ? Number(rawMaxWorkers) : undefined;
const maxWorkers = numericMaxWorkers ?? (process.env.CI === undefined ? 2 : undefined);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.join(rootDirectory, "src"),
    },
  },
  test: {
    // A new cross-file leak must fail the suite instead of being absorbed by
    // per-file worker isolation.
    isolate: false,
    environment: "node",
    // ONE postgres container per run (issue 626): global setup starts it and
    // provides its facts; suites get per-suite databases on it through
    // startPostgresContainer, and tests/support/global-setup.ts stops it at
    // teardown.
    globalSetup: ["./tests/support/global-setup.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // next-auth is ESM that imports "next/server" without an extension, which
    // only a bundler resolves (next ships no exports map). Inlining it lets
    // the suites that exercise the real Auth.js sign-in path
    // (tests/security/github-authorization-url.test.ts) load it; suites that
    // vi.mock("next-auth") are unaffected.
    server: { deps: { inline: ["next-auth"] } },
    hookTimeout: 120_000,
    testTimeout: 120_000,
    // Issue 626 (see the block above the config): maxWorkers resolves from the
    // environment there and is spread here only when set. teardownTimeout
    // pins the globalSetup teardown that stops the shared postgres container —
    // vitest's 10 s default is unpinned headroom for that stop.
    ...(maxWorkers === undefined ? {} : { maxWorkers }),
    teardownTimeout: 120_000,
  },
});
