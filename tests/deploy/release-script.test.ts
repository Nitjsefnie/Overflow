import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readlink, realpath, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/release.ts", import.meta.url));
let tree: string;

beforeEach(async () => {
  tree = await mkdtemp(path.join(os.tmpdir(), "overflow-release-test-"));
});

afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
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
  it("keeps generated types at the same lexical depth through .next and the release directory", async () => {
    const directory = await release("20260907T101500Z-abc1234");
    const source = path.join(directory, "types", "x.ts");
    await mkdir(path.dirname(source));
    await writeFile(source, 'import "../../src/app/page.js";');
    await symlink(path.relative(tree, directory), path.join(tree, ".next"));
    const alias = path.join(tree, ".next", "types", "x.ts");
    expect(await realpath(alias)).toBe(source);

    const roots = [source, alias].map((filename) => path.resolve(path.dirname(filename), "../.."));
    const imports = [source, alias].map((filename) =>
      path.resolve(path.dirname(filename), "../../src/app/page.js"),
    );

    expect(roots).toEqual([tree, tree]);
    expect(imports).toEqual([path.join(tree, "src/app/page.js"), path.join(tree, "src/app/page.js")]);
  });

  it("stores a relative target and reports the release after consecutive switches", async () => {
    for (const name of ["20260904", "20260907"]) {
      const directory = await release(name);

      const result = run("switch", tree, directory);

      expect(result.status, result.stderr).toBe(0);
      expect(await readlink(path.join(tree, ".next"))).toBe(`.next-release-${name}`);
      expect(await realpath(path.join(tree, ".next"))).toBe(directory);
      expect(path.resolve(tree, result.stdout.trim())).toBe(directory);
    }
  });

  it("lists both subcommands in the usage message", () => {
    const result = run();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/\bswitch\b/);
    expect(result.stderr).toMatch(/\bprune\b/);
  });

  it.each(["relative", "absolute"])(
    "refuses a nested %s release argument with the type-include depth reason",
    async (form) => {
      const old = await release("20260904");
      const nested = await release("20260907/nested");
      await symlink(old, path.join(tree, ".next"));
      const entries = await readdir(tree);
      const argument = form === "absolute" ? nested : path.relative(tree, nested);

      const result = run("switch", tree, argument);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(argument);
      expect(result.stderr).toContain("tsconfig.json");
      expect(result.stderr).toContain(".next/types/**/*.ts");
      expect(result.stderr).toContain("one segment");
      expect(await realpath(path.join(tree, ".next"))).toBe(old);
      expect(await readdir(tree)).toEqual(entries);
    },
  );

  it("rejects surplus switch arguments without changing the live release", async () => {
    const old = await release("20260904");
    const directory = await release("20260907");
    await symlink(".next-release-20260904", path.join(tree, ".next"));
    const entries = await readdir(tree);

    const result = run("switch", tree, directory, "extra");

    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).not.toBe("");
    expect(await realpath(path.join(tree, ".next"))).toBe(old);
    expect(await readdir(tree)).toEqual(entries);
  });

  it.each(["BUILD_ID", "cache"])("refuses a %s symlink through the old live build", async (marker) => {
    const old = await release("20260904");
    const directory = await release("20260907");
    const current = path.join(tree, ".next");
    await symlink(".next-release-20260904", current);
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
    const directory = await release("20260907");
    await symlink(directory, path.join(tree, ".next"));

    const result = run("switch", tree, ".next");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
  });

  it.each(["missing", "file", "BUILD_ID", "cache", "BUILD_ID directory", "cache file"])(
    "refuses an invalid release: %s, preserving the current release",
    async (invalid) => {
      const old = await release("20260906");
      await symlink(old, path.join(tree, ".next"));
      let directory = path.join(tree, ".next-release-20260907");
      let offending = directory;
      if (invalid === "file") {
        await writeFile(directory, "not a directory");
      } else if (invalid !== "missing") {
        directory = await release("20260907");
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
    const directory = await release("20260907");
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
    const directory = await release("20260907");
    const old = await release("20260906");
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
      const old = await release("20260906");
      const directory = await release("20260907");
      const current = path.join(tree, ".next");
      if (link === "relative") {
        const first = run("switch", tree, old);
        expect(first.status, first.stderr).toBe(0);
        expect(await readlink(current)).toBe(".next-release-20260906");
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
    const old = await release("20260906");
    const directory = await release("20260907");
    await symlink(old, path.join(tree, ".next"));
    const entries = await readdir(tree);

    const result = run("switch", tree, directory);

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
    expect(await readdir(tree)).toEqual(entries);
  });

  it("stores a relative symlink target even for an absolute release argument", async () => {
    const directory = await release("20260907");

    const result = run("switch", tree, directory);

    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(tree, ".next"))).toBe(".next-release-20260907");
  });

  it("switches a tree without .next onto a completed release", async () => {
    const directory = await release("20260907");

    const result = run("switch", tree, ".next-release-20260907");

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(await realpath(path.join(tree, ".next"))).toBe(directory);
    expect(path.resolve(tree, result.stdout.trim())).toBe(directory);
  });
});

describe("release prune", () => {
  it("prunes only real release directories among the tree's own entries", async () => {
    await release("20260904");
    await release("20260907");
    for (const name of [".next", ".next-dev", ".next-switch-stale", "unrelated"]) {
      await mkdir(path.join(tree, name));
    }
    await mkdir(path.join(tree, ".next-releases", "20260904"), { recursive: true });
    await mkdir(path.join(tree, ".next-releases", "20260907"));
    await writeFile(path.join(tree, ".next-release-20990101"), "keep");
    await symlink("unrelated", path.join(tree, ".next-release-20000101"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([
      ".next", ".next-dev", ".next-release-20000101", ".next-release-20260907",
      ".next-release-20990101", ".next-releases", ".next-switch-stale", "unrelated",
    ]);
    expect(await readdir(path.join(tree, ".next-releases"))).toEqual(["20260904", "20260907"]);
    expect(await readlink(path.join(tree, ".next-release-20000101"))).toBe("unrelated");
    expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260904"));
  });

  it("protects the served release when the tree is reached through a symlink", async () => {
    const storage = path.join(tree, "stored-tree");
    const alias = path.join(tree, "tree-link");
    await mkdir(storage);
    for (const name of ["20260904", "20260905", "20260907"]) {
      const directory = await release(name);
      await rename(directory, path.join(storage, path.basename(directory)));
    }
    await symlink("stored-tree", alias);
    await symlink(".next-release-20260904", path.join(storage, ".next"));

    const result = run("prune", alias, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(alias, ".next"))).toBe(path.join(storage, ".next-release-20260904"));
    expect(await readdir(storage)).toEqual([".next", ".next-release-20260904", ".next-release-20260907"]);
    expect(result.stdout.trim()).toBe(path.join(alias, ".next-release-20260905"));
  });

  it("preserves directories traversed before resolving symlink-relative parent components", async () => {
    for (const name of ["20260903", "20260904", "20260905", "20260906", "20260907"]) await release(name);
    await symlink("../.next-release-20260906", path.join(tree, ".next-release-20260905", "jump"));
    await symlink(
      "../.next-release-20260905/jump/../.next-release-20260907",
      path.join(tree, ".next-release-20260904", "redirect"),
    );
    await symlink(".next-release-20260904/redirect", path.join(tree, ".next"));
    expect(await realpath(path.join(tree, ".next"))).toBe(path.join(tree, ".next-release-20260907"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(path.join(tree, ".next-release-20260907"));
    expect(await readdir(tree)).toEqual([
      ".next", ".next-release-20260904", ".next-release-20260905", ".next-release-20260906", ".next-release-20260907",
    ]);
    expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260903"));
  });

  it("preserves release directories traversed by the live symlink chain", async () => {
    const intermediate = await release("20260904");
    await release("20260905");
    const served = await release("20260907");
    await symlink("../.next-release-20260907", path.join(intermediate, "redirect"));
    await symlink(".next-release-20260904/redirect", path.join(tree, ".next"));
    expect(await realpath(path.join(tree, ".next"))).toBe(served);

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await realpath(path.join(tree, ".next"))).toBe(served);
    expect(await readdir(tree)).toEqual([".next", ".next-release-20260904", ".next-release-20260907"]);
    expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260905"));
  });

  it("does not recursively delete a release containing the served build", async () => {
    const served = await release("20260904/nested");
    await release("20260906");
    await release("20260907");
    await symlink(served, path.join(tree, ".next"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([".next", ".next-release-20260904", ".next-release-20260907"]);
    expect(await realpath(path.join(tree, ".next"))).toBe(served);
  });

  it.each(["relative", "absolute", "indirect"])(
    "protects an older served release through a %s link in addition to the newest N",
    async (link) => {
      for (const name of ["20260904", "20260905", "20260906", "20260907"]) await release(name);
      const served = path.join(tree, ".next-release-20260904");
      let target = link === "absolute" ? served : ".next-release-20260904";
      if (link === "indirect") {
        await symlink(target, path.join(tree, "active"));
        target = "active";
      }
      await symlink(target, path.join(tree, ".next"));

      const result = run("prune", tree, "--keep", "2");

      expect(result.status, result.stderr).toBe(0);
      expect(await readdir(tree)).toEqual([
        ".next", ".next-release-20260904", ".next-release-20260906", ".next-release-20260907",
        ...(link === "indirect" ? ["active"] : []),
      ]);
      expect(await realpath(path.join(tree, ".next"))).toBe(served);
      expect(result.stdout.trim()).toBe(path.join(tree, ".next-release-20260905"));
    },
  );

  it.each(["missing", "dangling"])("protects nothing and reports a %s .next", async (state) => {
    await release("20260906");
    await release("20260907");
    if (state === "dangling") await symlink(".next-release-gone", path.join(tree, ".next"));

    const result = run("prune", tree, "--keep", "1");

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([
      ...(state === "dangling" ? [".next"] : []), ".next-release-20260907",
    ]);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(path.join(tree, ".next"));
    expect(lines[1]).toBe(path.join(tree, ".next-release-20260906"));
  });

  it.each(["1.5", "0", "-1", "abc", "2x", "", "Infinity", "1e3"])(
    "rejects invalid --keep %j without deleting releases",
    async (keep) => {
      await release("20260906");
      await release("20260907");

      const result = run("prune", tree, "--keep", keep);

      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).not.toBe("");
      expect(await readdir(tree)).toEqual([".next-release-20260906", ".next-release-20260907"]);
    },
  );

  it.each([["--keep"], ["--unknown", "2"], ["--keep", "2", "extra"]])(
    "rejects malformed prune arguments %j",
    async (...args) => {
      await release("20260907");

      const result = run("prune", tree, ...args);

      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).not.toBe("");
      expect(await readdir(tree)).toEqual([".next-release-20260907"]);
    },
  );

  it.each([
    { args: ["--keep", "2"], kept: ["20260906", "20260907"], removed: ["20260904", "20260905"] },
    { args: [], kept: ["20260905", "20260906", "20260907"], removed: ["20260904"] },
  ])("keeps the newest releases with arguments $args", async ({ args, kept, removed }) => {
    for (const name of ["20260906", "20260904", "20260907", "20260905"]) await release(name);
    await symlink(".next-release-20260907", path.join(tree, ".next"));

    const result = run("prune", tree, ...args);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(await readdir(tree)).toEqual([".next", ...kept.map((name) => `.next-release-${name}`)]);
    expect(result.stdout.trim().split("\n").sort()).toEqual(
      removed.map((name) => path.join(tree, `.next-release-${name}`)),
    );
  });

  it("does nothing when no directory matches the release prefix", async () => {
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
    const directory = await release("20260907");
    await symlink(directory, path.join(tree, ".next"));

    const result = run("prune", tree);

    expect(result.status, result.stderr).toBe(0);
    expect(await readdir(tree)).toEqual([".next", ".next-release-20260907"]);
    expect(result.stdout.trim()).not.toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  });
});
