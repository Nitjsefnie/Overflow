import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOwnedTempDirectory, reclaimOwnedTempDirectories } from "./owned-temp-directory";

let root: string;
const helper = new URL("./owned-temp-directory.ts", import.meta.url).href;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "owned-temp-directory-tests-"));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("owned temp directories", () => {
  it("records ownership atomically in the directory name", () => {
    const prefix = join(root, "atomic-");
    const directory = createOwnedTempDirectory(prefix);
    expect(directory.slice(prefix.length)).toMatch(new RegExp(`^${process.pid}-[A-Za-z0-9]{6}$`));
    expect(readdirSync(directory)).toEqual([]);
  });

  it("reclaims the real directory left by a killed owner on the next sweep", () => {
    const prefix = join(root, "killed-");
    const killed = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { writeSync } from 'node:fs';
      import { createOwnedTempDirectory } from ${JSON.stringify(helper)};
      writeSync(1, createOwnedTempDirectory(process.argv[1]));
      process.kill(process.pid, 'SIGKILL');
    `, prefix], { encoding: "utf8", timeout: 10_000 });
    expect(killed.error).toBeUndefined();
    expect(killed.signal).toBe("SIGKILL");
    const directory = killed.stdout;
    expect(existsSync(directory)).toBe(true);

    const live = createOwnedTempDirectory(prefix);
    const foreign = createOwnedTempDirectory(join(root, "unrelated-"));
    const unmarked = mkdtempSync(prefix);
    const invalidOwner = `${prefix}0-invalid`;
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
    for (const kept of [live, foreign, unmarked, invalidOwner, symlink, file]) {
      expect(existsSync(kept), kept).toBe(true);
    }
    reclaimOwnedTempDirectories(prefix); // Repeated and concurrent sweeps are harmless.
  });
});
