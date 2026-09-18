import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

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
  },
});
