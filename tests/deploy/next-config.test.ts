import { spawnSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDistDir = process.env.NEXT_DIST_DIR;
const project = fileURLToPath(new URL("../..", import.meta.url));
const preparedTrees: string[] = [];

async function expectPathRefusal(configImport: Promise<unknown>, value: string) {
  await expect(configImport).rejects.toThrowError(Error);
  // Preparation failures wrap their underlying cause; path refusals do not.
  await expect(configImport).rejects.not.toHaveProperty("cause");
  await expect(configImport).rejects.toThrow("NEXT_DIST_DIR");
  await expect(configImport).rejects.toThrow(value);
}

function writePreparedConfig(tree: string, release: string) {
  copyFileSync(path.join(project, "tsconfig.json"), path.join(tree, "tsconfig.json"));
  const prepared = spawnSync(process.execPath, [path.join(project, "scripts/release.ts"), "prepare", tree, release], { encoding: "utf8" });
  expect(prepared.status, prepared.stderr).toBe(0);
  return prepared.stdout.trim();
}

function prepareConfig(release = ".next-release-20260907T101500Z-abc1234") {
  const tree = mkdtempSync(path.join(os.tmpdir(), "overflow-next-config-"));
  preparedTrees.push(tree);
  const filename = writePreparedConfig(tree, release);
  vi.spyOn(process, "cwd").mockReturnValue(tree);
  return { tree, filename };
}

function mapFixtureFilesystem(mapPath: (target: string) => string) {
  vi.doMock("node:fs", () => ({
    lstatSync: (target: string, options?: Parameters<typeof lstatSync>[1]) => lstatSync(mapPath(target), options),
    readFileSync: (target: string, encoding?: BufferEncoding) => readFileSync(mapPath(target), { encoding }),
  }));
}

function prepareInvalidPathConfig(value: string, tree?: string, paths = path) {
  const prepared = tree
    ? { tree, filename: writePreparedConfig(tree, "build-output") }
    : prepareConfig("build-output");
  // The prepare CLI correctly rejects these paths. Retarget only its metadata
  // and map the requested filename to the real generated file, keeping writes
  // inside the fixture and preserving the nested-output non-creation check.
  const config = JSON.parse(readFileSync(prepared.filename, "utf8"));
  config.releaseConfig.distDir = value.trim();
  writeFileSync(prepared.filename, JSON.stringify(config));
  const projectDir = paths === path.win32 ? "C:\\project" : prepared.tree;
  const requestedConfig = paths.join(projectDir, `${value.trim()}.tsconfig.json`);
  vi.spyOn(process, "cwd").mockReturnValue(projectDir);
  if (paths === path.win32) vi.doMock("node:path", () => ({ default: path.win32 }));
  mapFixtureFilesystem((target) => target === requestedConfig
    ? prepared.filename
    : path.join(prepared.tree, ...paths.relative(projectDir, target).split(paths.sep)),
  );
}

afterEach(() => {
  if (originalDistDir === undefined) {
    delete process.env.NEXT_DIST_DIR;
  } else {
    process.env.NEXT_DIST_DIR = originalDistDir;
  }
  vi.doUnmock("node:fs");
  vi.restoreAllMocks();
  for (const tree of preparedTrees.splice(0)) rmSync(tree, { recursive: true, force: true });
  vi.resetModules();
});

describe("NEXT_DIST_DIR", () => {
  describe("filesystem containment", () => {
    let fixtureDir: string;
    let projectDir: string;

    beforeEach(() => {
      fixtureDir = mkdtempSync(path.join(os.tmpdir(), "overflow-next-containment-"));
      projectDir = path.join(fixtureDir, "project");
      const outsideDir = path.join(fixtureDir, "outside");
      mkdirSync(projectDir);
      mkdirSync(outsideDir);
      writePreparedConfig(projectDir, "release-link");
      symlinkSync(outsideDir, path.join(projectDir, "release-link"), "dir");
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    });

    afterEach(() => {
      vi.doUnmock("node:path");
      vi.doUnmock("node:fs");
      vi.restoreAllMocks();
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it.each(["release-link/build-123", "release-link\\build-123"])(
      "rejects a Windows path separator in %s",
      async (value) => {
        prepareInvalidPathConfig(value, projectDir, path.win32);
        process.env.NEXT_DIST_DIR = value;
        vi.resetModules();

        const configImport = import("../../next.config");

        await expectPathRefusal(configImport, value);
      },
    );

    it("rejects a separator-free Windows drive-relative path before preparation", async () => {
      prepareInvalidPathConfig("D:build", projectDir, path.win32);
      process.env.NEXT_DIST_DIR = "D:build";
      vi.resetModules();

      const configImport = import("../../next.config");

      await expectPathRefusal(configImport, "D:build");
    });

    it("rejects a direct Windows symlink", async () => {
      const windowsProjectDir = "C:\\project";
      vi.spyOn(process, "cwd").mockReturnValue(windowsProjectDir);
      vi.doMock("node:path", () => ({ default: path.win32 }));
      // Map Windows paths to the real fixture; retain native symlink metadata.
      mapFixtureFilesystem((target) =>
        path.join(projectDir, ...path.win32.relative(windowsProjectDir, target).split("\\")),
      );
      process.env.NEXT_DIST_DIR = "release-link";
      vi.resetModules();

      const configImport = import("../../next.config");

      await expectPathRefusal(configImport, "release-link");
    });

    it("rejects a direct external symlink", async () => {
      process.env.NEXT_DIST_DIR = "release-link";
      vi.resetModules();

      const configImport = import("../../next.config");

      await expectPathRefusal(configImport, "release-link");
    });

    it("rejects a new nested build directory without creating it", async () => {
      prepareInvalidPathConfig("releases/new/build-123", projectDir);
      process.env.NEXT_DIST_DIR = "releases/new/build-123";
      vi.resetModules();

      const configImport = import("../../next.config");

      await expectPathRefusal(configImport, "releases/new/build-123");
      expect(lstatSync(path.join(projectDir, "releases"), { throwIfNoEntry: false })).toBeUndefined();
    });
  });

  it.each([
    ["an absolute path", "/tmp/overflow-build"],
    ["a leading parent segment", "../overflow-build"],
    ["a middle parent segment", ".next-releases/../overflow-build"],
    ["a trailing parent segment", ".next-releases/.."],
    ["a Windows absolute path", "C:\\overflow-build"],
    ["a Windows parent segment", ".next-releases\\..\\overflow-build"],
    ["an absolute path with surrounding whitespace", " /tmp/overflow-build "],
  ])("rejects %s as an output path", async (_description, value) => {
    prepareInvalidPathConfig(value);
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const configImport = import("../../next.config");

    await expectPathRefusal(configImport, value);
  });

  it.each(["..", " \t..\n "])("rejects a whole parent segment %j before preparation", async (value) => {
    const { tree, filename } = prepareConfig("build-output");
    // Retarget the real prepared file: without the parent guard, preparation
    // must succeed so it cannot mask acceptance of the project parent.
    const config = JSON.parse(readFileSync(filename, "utf8"));
    config.releaseConfig.distDir = "..";
    writeFileSync(path.join(tree, "...tsconfig.json"), JSON.stringify(config));
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const configImport = import("../../next.config");

    await expectPathRefusal(configImport, value);
  });

  it("trims surrounding whitespace from a relative path", async () => {
    prepareConfig();
    process.env.NEXT_DIST_DIR = " \t.next-release-20260907T101500Z-abc1234\n ";
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config.distDir).toBe(".next-release-20260907T101500Z-abc1234");
    expect(config.typescript?.tsconfigPath).toBe(".next-release-20260907T101500Z-abc1234.tsconfig.json");
  });

  it.each([".", " \t.\n "])("rejects zero-depth %j", async (value) => {
    prepareInvalidPathConfig(value);
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const configImport = import("../../next.config");

    await expectPathRefusal(configImport, value);
  });

  it.each([
    ".next-releases/20260907T101500Z-abc1234",
    " \t.next-releases/20260907T101500Z-abc1234\n ",
    ".next-releases\\20260907T101500Z-abc1234",
    "build outputs/release 1",
    "release..candidate/build",
    "./build-output",
    "build-output/",
  ])("rejects path separators in %j", async (value) => {
    prepareInvalidPathConfig(value);
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const configImport = import("../../next.config");

    await expectPathRefusal(configImport, value);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace-only", " \t\n "],
  ])("omits distDir when %s", async (_description, value) => {
    if (value === undefined) {
      delete process.env.NEXT_DIST_DIR;
    } else {
      process.env.NEXT_DIST_DIR = value;
    }
    vi.doMock("node:fs", () => ({
      lstatSync: () => { throw new Error("Unexpected filesystem work"); },
      readFileSync: () => { throw new Error("Unexpected filesystem work"); },
    }));
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config).not.toHaveProperty("distDir");
    expect(config.typescript?.tsconfigPath).toBeUndefined();
  });

  it.each([
    ["a simple relative path", "build-output"],
    ["a path with interior whitespace", "build output 1"],
    ["a filename containing two dots", "release..candidate"],
    ["a single-segment release path", ".next-release-20260907T101500Z-abc1234"],
  ])("uses %s unchanged", async (_description, value) => {
    prepareConfig(value);
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config.distDir).toBe(value);
    expect(config.typescript?.tsconfigPath).toBe(`${value}.tsconfig.json`);
  });

  it.each(["compiler options", "source includes", "malformed JSON", "symlink", "directory", "other release", "tracked config"])(
    "refuses a prepared config with changed %s before Next reads it",
    async (changed) => {
      const { tree, filename } = prepareConfig();
      const release = ".next-release-20260907T101500Z-abc1234";
      if (changed === "tracked config") {
        const config = JSON.parse(readFileSync(path.join(tree, "tsconfig.json"), "utf8"));
        config.compilerOptions.noUncheckedIndexedAccess = true;
        writeFileSync(path.join(tree, "tsconfig.json"), JSON.stringify(config));
      } else if (changed === "other release") {
        copyFileSync(filename, path.join(tree, ".next-release-20260907T101600Z-abc1234.tsconfig.json"));
      } else if (changed === "malformed JSON") {
        writeFileSync(filename, "{");
      } else if (changed === "symlink" || changed === "directory") {
        const copy = path.join(tree, "saved-config.json");
        copyFileSync(filename, copy);
        rmSync(filename);
        if (changed === "symlink") symlinkSync(copy, filename);
        else mkdirSync(filename);
      } else {
        const config = JSON.parse(readFileSync(filename, "utf8"));
        if (changed === "compiler options") config.compilerOptions.strict = false;
        else config.include = ["*.ts"];
        writeFileSync(filename, JSON.stringify(config));
      }
      process.env.NEXT_DIST_DIR = changed === "other release" ? ".next-release-20260907T101600Z-abc1234" : release;
      vi.resetModules();

      const configImport = import("../../next.config");

      await expect(configImport).rejects.toThrow("scripts/release.ts prepare");
      await expect(configImport).rejects.toThrow(process.env.NEXT_DIST_DIR);
    },
  );
});
