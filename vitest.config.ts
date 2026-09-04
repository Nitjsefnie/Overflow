import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDirectory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(rootDirectory, "src"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
});
