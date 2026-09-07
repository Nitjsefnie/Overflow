import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const hookPath = fileURLToPath(new URL("../../scripts/register-path-aliases.ts", import.meta.url));

function importOutsideRepositoryRoot(source: string) {
  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  const result = spawnSync(process.execPath, [
    "--experimental-transform-types", "--import", hookPath, "--input-type=module", "--eval", source,
  ], {
    // A real directory inside the package still allows ordinary package resolution,
    // but makes a hook incorrectly anchored at process.cwd() look in tests/src/.
    cwd: new URL("../", import.meta.url),
    env: environment,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}

describe("Node path alias preload", () => {
  it("resolves aliases, packages and builtins outside the repository root", () => {
    const result = importOutsideRepositoryRoot(`
      import { validateDifficultyScheme } from "@/lib/domain/difficulty-scheme";
      import { z } from "zod";
      import { basename } from "node:path";
      console.log(JSON.stringify([
        typeof validateDifficultyScheme,
        z.string().parse("package resolved"),
        basename("/a/builtin resolved"),
      ]));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["function", "package resolved", "builtin resolved"]);
  });

  it("preserves ERR_MODULE_NOT_FOUND for a missing alias", () => {
    const result = importOutsideRepositoryRoot('import "@/missing-reconcile-cli-test-module";');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
  });
});
