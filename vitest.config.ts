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
    environment: "node",
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
