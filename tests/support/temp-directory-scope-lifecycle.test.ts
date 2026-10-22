import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOwnedTempDirectory, reclaimOwnedTempDirectories } from "./owned-temp-directory";

const observerPrefix = join(tmpdir(), "temp-directory-scope-observer-");
reclaimOwnedTempDirectories(observerPrefix);

it.each([
  { suite: "tests/lib/http-surface-non-envelope.test.ts", prefixes: [".next-release-non-envelope-fixture-"], filter: "invokes readiness", passes: 1, inRepository: true },
  { suite: "tests/lib/http-surface-record.test.ts", prefixes: [".next-release-record-fixture-"], filter: "single rejection", passes: 1, inRepository: true },
  { suite: "tests/lib/http-surface-type-edges.test.ts", prefixes: [".next-release-type-edge-fixture-"], filter: "records the evaluated module", passes: 6, inRepository: true },
  { suite: "tests/lib/snapshot-updater-cli.test.ts", prefixes: [".next-release-snapshot-fixture-"], filter: "refuses a missing peer", passes: 2, inRepository: true },
  { suite: "tests/lib/http-surface-failures.test.ts", prefixes: ["http-surface-failures-"], filter: "accepts an instanceof brand check", passes: 10 },
  { suite: "tests/scripts/check-prerendered-routes.test.ts", prefixes: ["overflow-1144-prerender-"], filter: "passes the production allowlist", passes: 2 },
  { suite: "tests/scripts/resolve-suite-pull-request.test.ts", prefixes: ["suite-cancelled-outputs-", "suite-pr-outputs-"], filter: "accepts a cancelled suite superseded by a moved head|appends only validated outputs", passes: 3 },
])("observes fixture disposal after $suite exits", ({ suite, prefixes, filter, passes, inRepository }) => {
  const root = createOwnedTempDirectory(observerPrefix);
  try {
    const parent = inRepository ? process.cwd() : root;
    const workers = join(root, "workers");
    mkdirSync(workers);
    const snapshot = () => readdirSync(parent).filter(name => prefixes.some(prefix => {
      if (!name.startsWith(prefix)) return false;
      const suffix = name.slice(prefix.length);
      return !inRepository || /^[A-Za-z0-9]{6}$/.test(suffix)
        || readdirSync(workers).some(pid => suffix.startsWith(`${pid}-`));
    })).sort();
    const before = snapshot();
    try {
      const report = join(root, "vitest.json");
      const setup = join(root, "worker-pid.mjs");
      const config = join(root, "vitest.config.mjs");
      writeFileSync(setup, `import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(workers)} + "/" + process.pid, "");`);
      writeFileSync(config, `import config from ${JSON.stringify(new URL("../../vitest.config.ts", import.meta.url).href)};
        export default { ...config, test: { ...config.test,
          setupFiles: [...config.test.setupFiles, ${JSON.stringify(setup)}] } };`);
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
      delete env.DATABASE_URL;
      const child = spawnSync("pnpm", ["test", "--run", "--maxWorkers=2", suite, "--config", config, "-t", filter,
        "--reporter=json", `--outputFile=${report}`], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      expect(child.error, child.stderr).toBeUndefined();
      const output = child.stdout + child.stderr + readFileSync(report, "utf8");
      const results = JSON.parse(readFileSync(report, "utf8")) as { numPassedTests: number };
      expect(readdirSync(workers)).toHaveLength(1);
      expect(results.numPassedTests, output).toBe(passes);
      expect(child.status, child.stdout + child.stderr).toBe(0);
      expect(snapshot()).toEqual(before);
    } finally {
      for (const name of snapshot().filter(name => !before.includes(name))) rmSync(join(parent, name), { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
