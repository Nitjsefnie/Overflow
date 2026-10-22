import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createOwnedTempDirectory, reclaimOwnedTempDirectories } from "./owned-temp-directory";

const observerPrefix = join(tmpdir(), "temp-directory-scope-observer-");
reclaimOwnedTempDirectories(observerPrefix);

it.each([
  { suite: "tests/api/readiness.test.ts", prefixes: ["overflow-1055-readiness-", "overflow-1055-readiness-order-"], filter: "real runner applies an extra|journals only ahead flagged", passes: 4 },
  { suite: "tests/api/readiness.test.ts", prefixes: ["overflow-1055-final-fix-"], filter: "final fix real chain", passes: 0, fault: ["async", "writeFile", "overflow-1055-final-fix-"] },
  { suite: "tests/db/migrate-default-branch-guard.test.ts", prefixes: ["migrate-guard-repository-"], filter: "prefers origin/HEAD", passes: 0, fault: ["child", "spawnSync", "migrate-guard-repository-"] },
  { suite: "tests/deploy/deploy-readme-fallback.test.ts", prefixes: ["overflow-readme-fallback-"], filter: "refuses a stray ignored source", passes: 0, fault: ["async", "mkdir", "overflow-readme-fallback-"] },
  { suite: "tests/deploy/deploy-revision.test.ts", prefixes: ["overflow-deploy-revision-"], filter: "completes when old-release readiness", passes: 0, fault: ["async", "mkdir", "overflow-deploy-revision-"] },
  { suite: "tests/fold/reconciliation-app-routing.test.ts", prefixes: ["reconciliation-app-keys-"], filter: "routes the composite", passes: 0, fault: ["sync", "writeFileSync", "reconciliation-app-keys-"] },
  { suite: "tests/scripts/check-legal-revisions.test.ts", prefixes: ["legal-revisions-"], filter: "exits 1 over a violating range", passes: 0, fault: ["async", "mkdir", "legal-revisions-"] },
  { suite: "tests/scripts/db-migrate-env-file.test.ts", prefixes: ["db-migrate-env-file-"], filter: "loads .env when", passes: 0, fault: ["sync", "mkdirSync", "db-migrate-env-file-"] },
  { suite: "tests/support/scratch-git.test.ts", prefixes: ["scratch-git-"], filter: "ignores config", passes: 0, fault: ["async", "realpath", "scratch-git-"] },
  { suite: "tests/scripts/owned-processes.test.ts", prefixes: ["owned-processes-test-"], filter: "removes the workdir on normal cleanup", passes: 0, fault: ["async", "rm", "owned-processes-test-"] },
  { suite: "tests/scripts/check-page-geometry-ownership.test.ts", prefixes: ["gate-ownership-test-"], filter: "releases acquisition hooks", passes: 0, fault: ["corrupt", "writeFile", "allocation-failure.mjs", "not valid JSON"] },
  { suite: "tests/db/backup-restore.test.ts", prefixes: ["overflow-backup-test-", "overflow-backup-partial-", "overflow-backup-stub-", "overflow-backup-bound-", "overflow-backup-symlink-", "overflow-backup-race-", "overflow-backup-reap-", "overflow-backup-barrier-"], filter: "", passes: 13 },
  { suite: "tests/lib/http-surface-non-envelope.test.ts", prefixes: [".next-release-non-envelope-fixture-"], filter: "invokes readiness", passes: 1, inRepository: true },
  { suite: "tests/lib/http-surface-record.test.ts", prefixes: [".next-release-record-fixture-"], filter: "single rejection", passes: 1, inRepository: true },
  { suite: "tests/lib/http-surface-type-edges.test.ts", prefixes: [".next-release-type-edge-fixture-"], filter: "records the evaluated module", passes: 6, inRepository: true },
  { suite: "tests/lib/snapshot-updater-cli.test.ts", prefixes: [".next-release-snapshot-fixture-"], filter: "refuses a missing peer", passes: 2, inRepository: true },
  { suite: "tests/lib/http-surface-failures.test.ts", prefixes: ["http-surface-failures-"], filter: "accepts an instanceof brand check", passes: 10 },
  { suite: "tests/scripts/check-prerendered-routes.test.ts", prefixes: ["overflow-1144-prerender-"], filter: "passes the production allowlist", passes: 2 },
  { suite: "tests/scripts/resolve-suite-pull-request.test.ts", prefixes: ["suite-cancelled-outputs-", "suite-pr-outputs-"], filter: "accepts a cancelled suite superseded by a moved head|appends only validated outputs", passes: 3 },
])("observes fixture disposal after $suite exits", ({ suite, prefixes, filter, passes, inRepository, fault }) => {
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
      const faultState = join(root, "fault.json");
      const injection = fault ? `
        import fs from "node:fs";
        import childProcess from "node:child_process";
        import { dirname, join } from "node:path";
        import { syncBuiltinESMExports } from "node:module";
        const target = ${fault[0] === "child" ? "childProcess" : fault[0] === "sync" ? "fs" : "fs.promises"};
        const method = ${JSON.stringify(fault[1])};
        const original = target[method];
        target[method] = function(...args) {
          const location = ${fault[0] === "child" ? "args[2]?.cwd" : "args[0]"};
          if (String(location).includes(${JSON.stringify(fault[2])})) {
            const directory = ${fault[0] === "child" || ["realpath", "rm"].includes(fault[1]) ? "String(location)" : "dirname(String(location))"};
            fs.writeFileSync(${JSON.stringify(faultState)}, JSON.stringify({ directory, existed: fs.existsSync(directory) }));
            ${fault[0] === "corrupt" ? 'return original.apply(this, args).then(() => original(join(dirname(args[0]), "chrome.json"), "injected fixture boundary failure"));' : 'throw new Error("injected fixture boundary failure");'}
          }
          return original.apply(this, args);
        };
        syncBuiltinESMExports();` : "";
      writeFileSync(setup, `import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(workers)} + "/" + process.pid, "");
        ${injection}`);
      writeFileSync(config, `import config from ${JSON.stringify(new URL("../../vitest.config.ts", import.meta.url).href)};
        export default { ...config, test: { ...config.test,
          setupFiles: [...config.test.setupFiles, ${JSON.stringify(setup)}] } };`);
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, TMP: root, TEMP: root };
      delete env.DATABASE_URL;
      const child = spawnSync("pnpm", ["test", "--run", "--maxWorkers=2", suite, "--config", config, "-t", filter,
        "--reporter=default", "--reporter=json", `--outputFile=${report}`], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
      expect(child.error, child.stderr).toBeUndefined();
      const output = child.stdout + child.stderr + readFileSync(report, "utf8");
      const results = JSON.parse(readFileSync(report, "utf8")) as { numPassedTests: number };
      expect(readdirSync(workers)).toHaveLength(1);
      if (fault) {
        expect(child.status, output).toBe(1);
        expect(output).toContain(fault[3] ?? "injected fixture boundary failure");
        const witness = JSON.parse(readFileSync(faultState, "utf8")) as { directory: string; existed: boolean };
        expect(witness.existed).toBe(true);
        expect(existsSync(witness.directory)).toBe(false);
      } else {
        expect(results.numPassedTests, output).toBe(passes);
        expect(child.status, output).toBe(0);
      }
      expect(snapshot()).toEqual(before);
    } finally {
      for (const name of snapshot().filter(name => !before.includes(name))) rmSync(join(parent, name), { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
