import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createOwnedTempDirectory, createOwnedTempDirectoryRegistry } from "./owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "temp-directory-lifecycle-")]);

let root: string;
const helper = new URL("./owned-temp-directory.ts", import.meta.url).href;

beforeAll(() => {
  root = tempDirectories.create(join(tmpdir(), "temp-directory-lifecycle-"));
});

afterAll(() => {
  if (root) tempDirectories.dispose();
});

it.each([
  {
    label: "HTTP startup and file cleanup",
    suite: "tests/lib/http-surface-snapshot.test.ts",
    prefixes: ["http-snapshot-fixture-", "http-snapshot-identity-"],
    filter: "leaves no fixture|cleans up",
    passes: 6,
    teardownFailure: false,
  },
  {
    label: "migration startup and failed-write cleanup",
    suite: "tests/db/migration-checksum.test.ts",
    prefixes: ["overflow-1055-migration-"],
    filter: "records drop_column from a real migration file|retains cleanup ownership",
    passes: 2,
    teardownFailure: false,
  },
  {
    label: "migration failed-teardown cleanup",
    suite: "tests/db/migration-checksum.test.ts",
    prefixes: ["overflow-1055-migration-"],
    filter: "cleans fixtures despite database teardown failure",
    passes: 1,
    teardownFailure: true,
  },
])("observes $label after the real suite exits", ({ suite, prefixes, filter, passes, teardownFailure }) => {
  const directory = tempDirectories.create(join(root, "run-"));
  const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync, writeSync } from 'node:fs';
    import { join } from 'node:path';
    import { createOwnedTempDirectory } from ${JSON.stringify(helper)};
    const directories = process.argv.slice(1).map(prefix => {
      const directory = createOwnedTempDirectory(prefix);
      writeFileSync(join(directory, 'fixture.json'), '{}');
      return directory;
    });
    writeSync(1, JSON.stringify(directories));
    process.kill(process.pid, 'SIGKILL');
  `, ...prefixes.map((prefix) => join(directory, prefix))], { encoding: "utf8", timeout: 10_000 });
  expect(killed.error).toBeUndefined();
  expect(killed.signal).toBe("SIGKILL");
  const orphans = JSON.parse(killed.stdout) as string[];
  for (const orphan of orphans) expect(existsSync(orphan)).toBe(true);
  const live = prefixes.map((prefix) => createOwnedTempDirectory(join(directory, prefix)));
  const report = join(directory, "vitest.json");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory,
    OVERFLOW_TEMP_DIRECTORY_TEARDOWN_PROBE: teardownFailure ? "1" : "0" };
  delete env.OVERFLOW_DATABASE_URL;
  const child = spawnSync("pnpm", ["test", "--run", "--maxWorkers=2", suite, "-t", filter,
    "--reporter=json", `--outputFile=${report}`], { env, encoding: "utf8", timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  expect(child.error, child.stderr).toBeUndefined();
  // This observer survives removal of the child's entire cleanup registration.
  const remaining = readdirSync(directory).filter((name) => prefixes.some((prefix) => name.startsWith(prefix))).sort();
  expect(remaining, "only the live parent's directories may remain after suite exit").toEqual(live.map((path) => basename(path)).sort());
  for (const orphan of orphans) expect(existsSync(orphan), "suite startup must reclaim killed owners").toBe(false);
  const results = JSON.parse(readFileSync(report, "utf8")) as { numPassedTests: number; testResults: { message: string }[] };
  expect(results.numPassedTests).toBe(passes);
  expect(child.status, child.stdout + child.stderr).toBe(teardownFailure ? 1 : 0);
  if (teardownFailure) expect(results.testResults.map(({ message }) => message).join("\n")).toContain("fixture teardown failure");
});
