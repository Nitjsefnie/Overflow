import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("handles only the known transform warning and retains other diagnostics", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const setup = fileURLToPath(new URL("../../scripts/perf-node-setup.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    "--experimental-transform-types", "--import", setup, "--input-type=module", "--eval",
    'await import("./scripts/register-path-aliases.ts"); process.emitWarning("other experiment", "ExperimentalWarning"); process.emitWarning("other diagnostic");',
  ], { cwd: root, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).not.toContain("Transform Types is an experimental feature");
  expect(result.stderr).toContain("ExperimentalWarning: other experiment");
  expect(result.stderr).toContain("Warning: other diagnostic");
});
