import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOwnedTempDirectory } from "./owned-temp-directory";

it.each([
  { suite: "tests/lib/http-surface-failures.test.ts", prefixes: ["http-surface-failures-"], filter: "accepts an instanceof brand check", passes: 10 },
  { suite: "tests/scripts/check-prerendered-routes.test.ts", prefixes: ["overflow-1144-prerender-"], filter: "passes the production allowlist", passes: 2 },
  { suite: "tests/scripts/resolve-suite-pull-request.test.ts", prefixes: ["suite-cancelled-outputs-", "suite-pr-outputs-"], filter: "accepts a cancelled suite superseded by a moved head|appends only validated outputs", passes: 3 },
])("observes fixture disposal after $suite exits", ({ suite, prefixes, filter, passes }) => {
  const root = createOwnedTempDirectory(join(tmpdir(), "temp-directory-scope-observer-"));
  try {
    const report = join(root, "vitest.json");
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
    delete env.DATABASE_URL;
    const child = spawnSync("pnpm", ["test", "--run", "--maxWorkers=2", suite, "-t", filter,
      "--reporter=json", `--outputFile=${report}`], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    expect(child.error, child.stderr).toBeUndefined();
    const results = JSON.parse(readFileSync(report, "utf8")) as { numPassedTests: number };
    expect(results.numPassedTests).toBe(passes);
    expect(child.status, child.stdout + child.stderr).toBe(0);
    expect(readdirSync(root).filter(name => prefixes.some(prefix => name.startsWith(prefix)))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
