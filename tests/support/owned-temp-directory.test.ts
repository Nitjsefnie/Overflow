import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOwnedTempDirectory, createOwnedTempDirectoryRegistry, reclaimOwnedTempDirectories } from "./owned-temp-directory";

let root: string;
const helper = new URL("./owned-temp-directory.ts", import.meta.url).href;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "owned-temp-directory-tests-"));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("owned temp directories", () => {
  it("preserves a directory when its owner probe is denied", () => {
    const prefix = join(root, "denied-");
    const directory = createOwnedTempDirectory(prefix);
    const kill = process.kill.bind(process);
    let denied = false;
    const probe = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === process.pid && signal === 0) {
        denied = true;
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      }
      return kill(pid, signal);
    });
    try {
      reclaimOwnedTempDirectories(prefix);
      expect(denied).toBe(true);
      expect(existsSync(directory)).toBe(true);
    } finally {
      probe.mockRestore();
    }
  });

  it("records ownership atomically in the directory name", () => {
    const prefix = join(root, "atomic-");
    const directory = createOwnedTempDirectory(prefix);
    expect(directory.slice(prefix.length)).toMatch(new RegExp(`^${process.pid}-[A-Za-z0-9]{6}$`));
    expect(readdirSync(directory)).toEqual([]);
  });

  it("reclaims the real directory left by a killed owner on the next sweep", () => {
    const prefix = join(root, "killed-");
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { writeFileSync, writeSync } from 'node:fs';
      import { join } from 'node:path';
      import { createOwnedTempDirectory } from ${JSON.stringify(helper)};
      const directory = createOwnedTempDirectory(process.argv[1]);
      writeFileSync(join(directory, 'fixture.json'), '{}');
      writeSync(1, directory);
      process.kill(process.pid, 'SIGKILL');
    `, prefix], { encoding: "utf8", timeout: 10_000 });
    expect(killed.error).toBeUndefined();
    expect(killed.signal).toBe("SIGKILL");
    const directory = killed.stdout;
    expect(existsSync(directory)).toBe(true);

    const live = createOwnedTempDirectory(prefix);
    const foreign = mkdtempSync(join(root, `others-${killed.pid}-`));
    const malformed = `${prefix}${killed.pid}-abcde`;
    mkdirSync(malformed);
    const unmarked = mkdtempSync(prefix);
    const invalidOwner = `${prefix}0-abcdef`;
    mkdirSync(invalidOwner);
    const symlink = `${prefix}${killed.pid}-abcdef`;
    symlinkSync(foreign, symlink, "dir");
    const file = `${prefix}${killed.pid}-ghijkl`;
    writeFileSync(file, "leave regular files alone");

    // A second process sweeps while this run still owns its live directory.
    const sweep = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { reclaimOwnedTempDirectories } from ${JSON.stringify(helper)};
      reclaimOwnedTempDirectories(process.argv[1]);
    `, prefix], { encoding: "utf8", timeout: 10_000 });
    expect(sweep.error).toBeUndefined();
    expect(sweep.status, sweep.stderr).toBe(0);
    expect(existsSync(directory)).toBe(false);
    for (const kept of [live, foreign, malformed, unmarked, invalidOwner, symlink, file]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    reclaimOwnedTempDirectories(prefix); // Repeated and concurrent sweeps are harmless.
  });
});

it("registers fixtures before setup can fail and disposes every registered directory", () => {
  const fixtures = createOwnedTempDirectoryRegistry(join(root, "registered-"));
  const first = fixtures.create();
  const second = fixtures.create();
  expect(existsSync(first)).toBe(true);
  expect(existsSync(second)).toBe(true);
  expect(() => writeFileSync(join(second, "missing/file"), "fixture")).toThrow();
  fixtures.dispose();
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(false);
  fixtures.dispose();
});

it("disposes one registered path without removing another fixture", () => {
  const fixtures = createOwnedTempDirectoryRegistry(join(root, "individual-"));
  const first = fixtures.create();
  const second = fixtures.create();
  fixtures.dispose(first);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(true);
  fixtures.dispose();
  expect(existsSync(second)).toBe(false);
});

it("registers async creations under each armed prefix and disposes them asynchronously", async () => {
  const firstPrefix = join(root, "async-first-");
  const secondPrefix = join(root, "async-second-");
  const fixtures = createOwnedTempDirectoryRegistry([firstPrefix, secondPrefix]);
  const first = await fixtures.createAsync();
  const second = await fixtures.createAsync(secondPrefix);
  expect(first.startsWith(`${firstPrefix}${process.pid}-`)).toBe(true);
  expect(second.startsWith(`${secondPrefix}${process.pid}-`)).toBe(true);
  await fixtures.disposeAsync(first);
  expect(existsSync(first)).toBe(false);
  expect(existsSync(second)).toBe(true);
  await fixtures.disposeAsync();
  expect(existsSync(second)).toBe(false);
});
