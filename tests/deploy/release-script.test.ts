import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/release.ts", import.meta.url));
let fixtureDir: string;
let tree: string;

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "overflow-release-test-"));
  tree = path.join(fixtureDir, "project");
  await mkdir(tree);
});

afterEach(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

async function release(name: string) {
  const directory = path.join(tree, `.next-release-${name}`);
  await mkdir(path.join(directory, "cache"), { recursive: true });
  await writeFile(path.join(directory, "BUILD_ID"), name);
  return directory;
}

describe("release switch", () => {
  it("stores a relative target and reports the release after consecutive switches", async () => {
    for (const name of ["20260904T101500Z-abc1234", "20260907T101500Z-abc1234"]) {
      const directory = await release(name);

      const result = run("switch", tree, directory);

      expect(result.status, result.stderr).toBe(0);
      expect(await readlink(path.join(tree, ".next"))).toBe(`.next-release-${name}`);
      expect(await realpath(path.join(tree, ".next"))).toBe(directory);
      expect(path.resolve(tree, result.stdout.trim())).toBe(directory);
    }
  });

  it("lists switch and prune in the usage message", () => {
    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\bswitch\b/);
    expect(result.stderr).toMatch(/\bprune\b/);
  });

  it.each(["relative", "absolute"])(
    "refuses a nested %s release argument",
    async (form) => {
      const old = await release("20260904T101500Z-abc1234");
      const nested = await release("20260907T101500Z-abc1234/nested");
      await symlink(old, path.join(tree, ".next"));
      const entries = await readdir(tree);
      const argument = form === "absolute" ? nested : path.relative(tree, nested);

      const result = run("switch", tree, argument);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(argument);
      expect(await realpath(path.join(tree, ".next"))).toBe(old);
      expect(await readdir(tree)).toEqual(entries);
    },
  );

  it.each(["nested", "root", "outside"])(
    "refuses a release alias resolving to the %s directory",
    async (location) => {
      const old = await release("20260904T101500Z-abc1234");
      const current = path.join(tree, ".next");
      await symlink(path.basename(old), current);
      let target = tree;
      if (location === "root") {
        await mkdir(path.join(target, "cache"));
        await writeFile(path.join(target, "BUILD_ID"), "root-build");
      } else {
        const directory = await release("20260907T101500Z-abc1234");
        const parent = location === "nested" ? path.join(tree, ".next-releases") : fixtureDir;
        await mkdir(parent, { recursive: true });
        target = path.join(parent, path.basename(directory));
        await rename(directory, target);
      }
      const argument = ".next-release-alias";
      await symlink(path.relative(tree, target) || ".", path.join(tree, argument));
      expect(await realpath(path.join(tree, argument))).toBe(target);
      const entries = await readdir(tree);

      const result = run("switch", tree, argument);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(argument);
      expect(await readlink(current)).toBe(path.basename(old));
      expect(await realpath(current)).toBe(old);
      expect(await readdir(tree)).toEqual(entries);
    },
  );

  it("refuses .next when it aliases a nested release", async () => {
    const directory = await release("20260907T101500Z-abc1234");
    const parent = path.join(tree, ".next-releases");
    await mkdir(parent);
    const nested = path.join(parent, path.basename(directory));
    await rename(directory, nested);
    const current = path.join(tree, ".next");
    const target = path.relative(tree, nested);
    await symlink(target, current);
    const entries = await readdir(tree);

    const result = run("switch", tree, ".next");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".next");
    expect(await readlink(current)).toBe(target);
    expect(await realpath(current)).toBe(nested);
    expect(await readdir(tree)).toEqual(entries);
  });

  it.each(["canonical", "aliased"])(
    "accepts an absolute child through an aliased tree with the %s tree argument",
    async (form) => {
      const directory = await release("20260907T101500Z-abc1234");
      const alias = path.join(fixtureDir, "tree-link");
      await symlink(tree, alias);
      const argument = path.join(alias, path.basename(directory));

      const result = run("switch", form === "canonical" ? tree : alias, argument);

      expect(result.status, result.stderr).toBe(0);
      expect(await readlink(path.join(tree, ".next"))).toBe(path.basename(directory));
      expect(await realpath(path.join(tree, ".next"))).toBe(directory);
      expect(result.stdout.trim()).toBe(directory);
    },
  );

  it.each([
    "000-human-notes",
    "20260907T021341Z-abc123",
    "20260907T021341Z-0123456789abcdef0123456789abcdef012345678",
    "20260907T021341Z-ABC1234",
    "20260907T021341Z-abc123g",
    "20260907t021341Z-abc1234",
    "20260907T021341z-abc1234",
    "2026097T021341Z-abc1234",
    "20260907T21341Z-abc1234",
    "20260907T021341Z-abc1234-extra",
    "20260907T021341Z-abc1234\n",
  ])("refuses a malformed release name %j", async (name) => {
    const old = await release("20260904T101500Z-abc1234");
    const directory = await release(name);
    const current = path.join(tree, ".next");
    await symlink(path.basename(old), current);
    const entries = await readdir(tree);

    const result = run("switch", tree, directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.basename(directory));
    expect(await readlink(current)).toBe(path.basename(old));
    expect(await realpath(current)).toBe(old);
    expect(await readdir(tree)).toEqual(entries);
  });

  it("refuses a validly named alias to a malformed release", async () => {
    const old = await release("20260904T101500Z-abc1234");
    const directory = await release("000-human-notes");
    const current = path.join(tree, ".next");
    await symlink(path.basename(old), current);
    const argument = ".next-release-20260907T021341Z-5a79df2";
    await symlink(path.basename(directory), path.join(tree, argument));
    const entries = await readdir(tree);

    const result = run("switch", tree, argument);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(path.basename(directory));
    expect(await readlink(current)).toBe(path.basename(old));
    expect(await realpath(current)).toBe(old);
    expect(await readdir(tree)).toEqual(entries);
  });

  it.each([
    "20260907T021341Z-5a79df2",
    "20260907T021341Z-0123456789abcdef0123456789abcdef01234567",
  ])("accepts a release at the hash-length boundary %s", async (name) => {
    const directory = await release(name);

    const result = run("switch", tree, directory);

    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(tree, ".next"))).toBe(`.next-release-${name}`);
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
    expect(result.stdout.trim()).toBe(directory);
  });

  it("rejects surplus switch arguments without changing the live release", async () => {
    const old = await release("20260904T101500Z-abc1234");
    const directory = await release("20260907T101500Z-abc1234");
    await symlink(".next-release-20260904T101500Z-abc1234", path.join(tree, ".next"));
    const entries = await readdir(tree);

    const result = run("switch", tree, directory, "extra");

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(await realpath(path.join(tree, ".next"))).toBe(old);
    expect(await readdir(tree)).toEqual(entries);
  });

  it.each(["BUILD_ID", "cache"])("refuses a %s symlink through the old live build", async (marker) => {
    const old = await release("20260904T101500Z-abc1234");
    const directory = await release("20260907T101500Z-abc1234");
    const current = path.join(tree, ".next");
    await symlink(".next-release-20260904T101500Z-abc1234", current);
    const markerPath = path.join(directory, marker);
    await rm(markerPath, { recursive: true });
    await symlink(`../.next/${marker}`, markerPath);
    expect(await realpath(markerPath)).toBe(path.join(old, marker));
    const entries = await readdir(tree);

    const result = run("switch", tree, directory);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(markerPath);
    expect(await realpath(current)).toBe(old);
    expect(await realpath(path.join(current, marker))).toBe(path.join(old, marker));
    expect(await readdir(tree)).toEqual(entries);
  });

  it("resolves a release argument through .next before replacing that link", async () => {
    const directory = await release("20260907T101500Z-abc1234");
    await symlink(directory, path.join(tree, ".next"));
    expect(await readlink(path.join(tree, ".next"))).toBe(directory);

    const result = run("switch", tree, ".next");

    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(tree, ".next"))).toBe(".next-release-20260907T101500Z-abc1234");
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
  });

  it.each(["missing", "file", "BUILD_ID", "cache", "BUILD_ID directory", "cache file"])(
    "refuses an invalid release: %s, preserving the current release",
    async (invalid) => {
      const old = await release("20260906T101500Z-abc1234");
      await symlink(old, path.join(tree, ".next"));
      let directory = path.join(tree, ".next-release-20260907T101500Z-abc1234");
      let offending = directory;
      if (invalid === "file") {
        await writeFile(directory, "not a directory");
      } else if (invalid !== "missing") {
        directory = await release("20260907T101500Z-abc1234");
        const marker = invalid.startsWith("BUILD_ID") ? "BUILD_ID" : "cache";
        offending = path.join(directory, marker);
        await rm(offending, { recursive: true });
        if (invalid === "BUILD_ID directory") await mkdir(offending);
        if (invalid === "cache file") await writeFile(offending, "not a directory");
      }
      const entries = await readdir(tree);

      const result = run("switch", tree, directory);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(offending);
      expect(await realpath(path.join(tree, ".next"))).toBe(old);
      expect(await readdir(tree)).toEqual(entries);
    },
  );

  it("refuses a real .next directory with a migration explanation", async () => {
    const directory = await release("20260907T101500Z-abc1234");
    const current = path.join(tree, ".next");
    await mkdir(current);
    await writeFile(path.join(current, "existing"), "keep");
    const entries = await readdir(tree);

    const result = run("switch", tree, directory);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(current);
    expect(result.stderr.toLowerCase()).toContain("migration");
    expect(await readdir(current)).toEqual(["existing"]);
    expect(await readdir(tree)).toEqual(entries);
  });

  it("removes its temporary symlink when the actual rename fails", async () => {
    const directory = await release("20260907T101500Z-abc1234");
    const old = await release("20260906T101500Z-abc1234");
    const current = path.join(tree, ".next");
    await symlink(old, current);
    const collision = path.join(tree, "collision.mjs");
    // Create a real destination collision after validation, immediately before
    // rename. This works even as root and exercises the kernel's rename failure.
    await writeFile(collision, `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const rename = fs.rename;
      fs.rename = async (source, destination) => {
        await fs.unlink(destination);
        await fs.mkdir(destination);
        return rename(source, destination);
      };
      syncBuiltinESMExports();
    `);
    const entries = await readdir(tree);

    const result = spawnSync(process.execPath, ["--import", collision, script, "switch", tree, directory], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(current);
    expect(await readdir(tree)).toEqual(entries);
    expect(await readdir(current)).toEqual([]);
    expect(await readdir(old)).toEqual(["BUILD_ID", "cache"]);
  });

  it.each(["absolute", "relative"])(
    "keeps .next resolvable across each filesystem mutation during %s symlink replacement",
    async (link) => {
      const old = await release("20260906T101500Z-abc1234");
      const directory = await release("20260907T101500Z-abc1234");
      const current = path.join(tree, ".next");
      if (link === "relative") {
        const first = run("switch", tree, old);
        expect(first.status, first.stderr).toBe(0);
        expect(await readlink(current)).toBe(".next-release-20260906T101500Z-abc1234");
      } else {
        await symlink(old, current);
      }
      const observer = path.join(tree, "observe.mjs");
      // Observe real filesystem state after every mutation, without scheduling a poll
      // in the potentially tiny unlink/symlink gap. All operations still run on disk.
      await writeFile(observer, `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const current = ${JSON.stringify(current)};
        for (const name of ["symlink", "rename", "unlink", "rm"]) {
          const original = fs[name];
          fs[name] = async (...args) => {
            const result = await original(...args);
            const resolved = await fs.realpath(current);
            if (![${JSON.stringify(old)}, ${JSON.stringify(directory)}].includes(resolved)) {
              throw new Error("Unexpected live release: " + resolved);
            }
            return result;
          };
        }
        syncBuiltinESMExports();
      `);

      const result = spawnSync(process.execPath, ["--import", observer, script, "switch", tree, directory], {
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(await realpath(current)).toBe(directory);
    },
  );

  it("replaces an existing symlink to an older release", async () => {
    const old = await release("20260906T101500Z-abc1234");
    const directory = await release("20260907T101500Z-abc1234");
    await symlink(old, path.join(tree, ".next"));
    const entries = await readdir(tree);

    const result = run("switch", tree, directory);

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
    expect(await readdir(tree)).toEqual(entries);
  });

  it("stores a relative symlink target even for an absolute release argument", async () => {
    const directory = await release("20260907T101500Z-abc1234");

    const result = run("switch", tree, directory);

    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(tree, ".next"))).toBe(".next-release-20260907T101500Z-abc1234");
  });

  it("switches a tree without .next onto a completed release", async () => {
    const directory = await release("20260907T101500Z-abc1234");

    const result = run("switch", tree, ".next-release-20260907T101500Z-abc1234");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
    expect(path.resolve(tree, result.stdout.trim())).toBe(directory);
  });
});

describe("release prune", () => {
  it.each([".next-release-000-human-notes", ".next-release-zzz-human-notes"])(
    "ignores malformed directory %s without consuming a retention slot",
    async (name) => {
      const old = await release("20260904T101500Z-abc1234");
      const newest = await release("20260907T101500Z-abc1234");
      const notes = path.join(tree, name, "operator-notes.txt");
      await mkdir(path.dirname(notes));
      await writeFile(notes, "operator notes");

      const result = run("prune", tree, "--keep", "1");

      expect(result.status, result.stderr).toBe(0);
      expect(await readdir(tree)).toEqual([name, path.basename(newest)].sort());
      expect(await readFile(notes, "utf8")).toBe("operator notes");
      expect(result.stdout.trim().split("\n").slice(1)).toEqual([old]);
    },
  );

  it("prunes a failed build without a BUILD_ID", async () => {
    const failed = path.join(tree, ".next-release-20260904T101500Z-abc1234");
    await mkdir(failed);
    await writeFile(path.join(failed, "partial-output"), "incomplete");
    const newest = await release("20260907T101500Z-abc1234");
    await symlink(path.basename(newest), path.join(tree, ".next"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([".next", path.basename(newest)]);
    expect(result.stdout.trim()).toBe(failed);
  });

  it("prunes only real release directories among the tree's own entries", async () => {
    await release("20260904T101500Z-abc1234");
    await release("20260907T101500Z-abc1234");
    for (const name of [".next", ".next-dev", ".next-switch-stale", "unrelated"]) {
      await mkdir(path.join(tree, name));
    }
    await mkdir(path.join(tree, ".next-releases", "20260904T101500Z-abc1234"), { recursive: true });
    await mkdir(path.join(tree, ".next-releases", "20260907T101500Z-abc1234"));
    await writeFile(path.join(tree, ".next-release-20990101T101500Z-abc1234"), "keep");
    await symlink("unrelated", path.join(tree, ".next-release-20000101T101500Z-abc1234"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([
      ".next", ".next-dev", ".next-release-20000101T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234",
      ".next-release-20990101T101500Z-abc1234", ".next-releases", ".next-switch-stale", "unrelated",
    ]);
    expect(await readdir(path.join(tree, ".next-releases"))).toEqual(["20260904T101500Z-abc1234", "20260907T101500Z-abc1234"]);
    expect(await readlink(path.join(tree, ".next-release-20000101T101500Z-abc1234"))).toBe("unrelated");
    expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260904T101500Z-abc1234"));
  });

  it("protects the served release when the tree is reached through a symlink", async () => {
    const storage = path.join(tree, "stored-tree");
    const alias = path.join(tree, "tree-link");
    await mkdir(storage);
    for (const name of ["20260904T101500Z-abc1234", "20260905T101500Z-abc1234", "20260907T101500Z-abc1234"]) {
      const directory = await release(name);
      await rename(directory, path.join(storage, path.basename(directory)));
    }
    await symlink("stored-tree", alias);
    await symlink(".next-release-20260904T101500Z-abc1234", path.join(storage, ".next"));

    const result = run("prune", alias, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(alias, ".next"))).toBe(path.join(storage, ".next-release-20260904T101500Z-abc1234"));
    expect(await readdir(storage)).toEqual([".next", ".next-release-20260904T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234"]);
    expect(result.stdout.trim()).toBe(path.join(alias, ".next-release-20260905T101500Z-abc1234"));
  });

  it("preserves directories traversed before resolving symlink-relative parent components", async () => {
    for (const name of ["20260903T101500Z-abc1234", "20260904T101500Z-abc1234", "20260905T101500Z-abc1234", "20260906T101500Z-abc1234", "20260907T101500Z-abc1234"]) await release(name);
    await symlink("../.next-release-20260906T101500Z-abc1234", path.join(tree, ".next-release-20260905T101500Z-abc1234", "jump"));
    await symlink(
      "../.next-release-20260905T101500Z-abc1234/jump/../.next-release-20260907T101500Z-abc1234",
      path.join(tree, ".next-release-20260904T101500Z-abc1234", "redirect"),
    );
    await symlink(".next-release-20260904T101500Z-abc1234/redirect", path.join(tree, ".next"));
    expect(await realpath(path.join(tree, ".next"))).toBe(path.join(tree, ".next-release-20260907T101500Z-abc1234"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(path.join(tree, ".next-release-20260907T101500Z-abc1234"));
    expect(await readdir(tree)).toEqual([
      ".next", ".next-release-20260904T101500Z-abc1234", ".next-release-20260905T101500Z-abc1234", ".next-release-20260906T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234",
    ]);
    expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260903T101500Z-abc1234"));
  });

  it("preserves release directories traversed by the live symlink chain", async () => {
    const intermediate = await release("20260904T101500Z-abc1234");
    await release("20260905T101500Z-abc1234");
    const served = await release("20260907T101500Z-abc1234");
    await symlink("../.next-release-20260907T101500Z-abc1234", path.join(intermediate, "redirect"));
    await symlink(".next-release-20260904T101500Z-abc1234/redirect", path.join(tree, ".next"));
    expect(await realpath(path.join(tree, ".next"))).toBe(served);

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(served);
    expect(await readdir(tree)).toEqual([".next", ".next-release-20260904T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234"]);
    expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260905T101500Z-abc1234"));
  });

  it("does not recursively delete a release containing the served build", async () => {
    const served = await release("20260904T101500Z-abc1234/nested");
    await release("20260906T101500Z-abc1234");
    await release("20260907T101500Z-abc1234");
    await symlink(served, path.join(tree, ".next"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([".next", ".next-release-20260904T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234"]);
    expect(await realpath(path.join(tree, ".next"))).toBe(served);
  });

  it.each(["relative", "absolute", "indirect"])(
    "protects an older served release through a %s link in addition to the newest N",
    async (link) => {
      for (const name of ["20260904T101500Z-abc1234", "20260905T101500Z-abc1234", "20260906T101500Z-abc1234", "20260907T101500Z-abc1234"]) await release(name);
      const served = path.join(tree, ".next-release-20260904T101500Z-abc1234");
      let target = link === "absolute" ? served : ".next-release-20260904T101500Z-abc1234";
      if (link === "indirect") {
        await symlink(target, path.join(tree, "active"));
        target = "active";
      }
      await symlink(target, path.join(tree, ".next"));

      const result = run("prune", tree, "--keep", "2");

      expect(result.status, result.stderr).toBe(0);
      expect(await readdir(tree)).toEqual([
        ".next", ".next-release-20260904T101500Z-abc1234", ".next-release-20260906T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234",
        ...(link === "indirect" ? ["active"] : []),
      ]);
      expect(await realpath(path.join(tree, ".next"))).toBe(served);
      expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260905T101500Z-abc1234"));
    },
  );

  it.each(["missing", "dangling"])("protects nothing and reports a %s .next", async (state) => {
    await release("20260906T101500Z-abc1234");
    await release("20260907T101500Z-abc1234");
    if (state === "dangling") await symlink(".next-release-gone", path.join(tree, ".next"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([
      ...(state === "dangling" ? [".next"] : []), ".next-release-20260907T101500Z-abc1234",
    ]);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(path.join(tree, ".next"));
    expect(lines[1]).toBe(path.join(tree, ".next-release-20260906T101500Z-abc1234"));
  });

  it.each(["1.5", "0", "-1", "abc", "2x", "", "Infinity", "1e3"])(
    "rejects invalid --keep %j without deleting releases",
    async (keep) => {
      await release("20260906T101500Z-abc1234");
      await release("20260907T101500Z-abc1234");

      const result = run("prune", tree, "--keep", keep);

      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).not.toBe("");
      expect(await readdir(tree)).toEqual([".next-release-20260906T101500Z-abc1234", ".next-release-20260907T101500Z-abc1234"]);
    },
  );

  it.each([["--keep"], ["--unknown", "2"], ["--keep", "2", "extra"]])(
    "rejects malformed prune arguments %j",
    async (...args) => {
      await release("20260907T101500Z-abc1234");

      const result = run("prune", tree, ...args);

      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).not.toBe("");
      expect(await readdir(tree)).toEqual([".next-release-20260907T101500Z-abc1234"]);
    },
  );

  it.each([
    { args: ["--keep", "2"], kept: ["20260906T101500Z-abc1234", "20260907T101500Z-abc1234"], removed: ["20260904T101500Z-abc1234", "20260905T101500Z-abc1234"] },
    { args: [], kept: ["20260905T101500Z-abc1234", "20260906T101500Z-abc1234", "20260907T101500Z-abc1234"], removed: ["20260904T101500Z-abc1234"] },
  ])("keeps the newest releases with arguments $args", async ({ args, kept, removed }) => {
    for (const name of ["20260906T101500Z-abc1234", "20260904T101500Z-abc1234", "20260907T101500Z-abc1234", "20260905T101500Z-abc1234"]) await release(name);
    await symlink(".next-release-20260907T101500Z-abc1234", path.join(tree, ".next"));

    const result = run("prune", tree, ...args);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readdir(tree)).toEqual([".next", ...kept.map((name) => `.next-release-${name}`)]);
    expect(result.stdout.trim().split("\n").sort()).toEqual(
      removed.map((name) => path.join(tree, `.next-release-${name}`)),
    );
  });

  it("does nothing when no directory matches the release grammar", async () => {
    await writeFile(path.join(tree, "unrelated"), "keep");
    await mkdir(path.join(tree, ".next"));
    await mkdir(path.join(tree, ".next-releases", "old"), { recursive: true });
    await writeFile(path.join(tree, ".next-release-file"), "keep");
    await symlink(".next-releases", path.join(tree, ".next-release-link"));
    const entries = await readdir(tree);

    const result = run("prune", tree);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readdir(tree)).toEqual(entries);
    expect(await readdir(path.join(tree, ".next-releases"))).toEqual(["old"]);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });

  it("prints a single no-op line when all releases are retained", async () => {
    const directory = await release("20260907T101500Z-abc1234");
    await symlink(directory, path.join(tree, ".next"));

    const result = run("prune", tree);

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([".next", ".next-release-20260907T101500Z-abc1234"]);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });
});
