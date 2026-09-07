import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDistDir = process.env.NEXT_DIST_DIR;

afterEach(() => {
  if (originalDistDir === undefined) {
    delete process.env.NEXT_DIST_DIR;
  } else {
    process.env.NEXT_DIST_DIR = originalDistDir;
  }
  vi.resetModules();
});

describe("NEXT_DIST_DIR", () => {
  describe("filesystem containment", () => {
    let fixtureDir: string;
    let projectDir: string;

    beforeEach(() => {
      fixtureDir = mkdtempSync(path.join(process.cwd(), ".next-config-test-"));
      projectDir = path.join(fixtureDir, "project");
      const outsideDir = path.join(fixtureDir, "outside");
      mkdirSync(projectDir);
      mkdirSync(outsideDir);
      symlinkSync(outsideDir, path.join(projectDir, "release-link"), "dir");
      vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      rmSync(fixtureDir, { recursive: true, force: true });
    });

    it.each(["release-link/build-123", "release-link"])(
      "rejects an external symlink at %s",
      async (value) => {
        process.env.NEXT_DIST_DIR = value;
        vi.resetModules();

        const configImport = import("../../next.config");

        await expect(configImport).rejects.toThrowError(Error);
        await expect(configImport).rejects.toThrow("NEXT_DIST_DIR");
        await expect(configImport).rejects.toThrow(value);
      },
    );

    it("accepts a new nested build directory without creating it", async () => {
      process.env.NEXT_DIST_DIR = "releases/new/build-123";
      vi.resetModules();

      const { default: config } = await import("../../next.config");

      expect(config.distDir).toBe("releases/new/build-123");
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
  ])("rejects %s with the variable name and value", async (_description, value) => {
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const configImport = import("../../next.config");

    await expect(configImport).rejects.toThrowError(Error);
    await expect(configImport).rejects.toThrow("NEXT_DIST_DIR");
    await expect(configImport).rejects.toThrow(value);
  });

  it("trims surrounding whitespace from a relative path", async () => {
    process.env.NEXT_DIST_DIR = " \t.next-releases/20260907T101500Z-abc1234\n ";
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config.distDir).toBe(".next-releases/20260907T101500Z-abc1234");
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
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config).not.toHaveProperty("distDir");
  });

  it.each([
    ["a simple relative path", "build-output"],
    ["a path with interior whitespace", "build outputs/release 1"],
    ["a filename containing two dots", "release..candidate/build"],
    ["a path with a leading dot segment", "./build-output"],
    ["a nested release path", ".next-releases/20260907T101500Z-abc1234"],
  ])("uses %s unchanged", async (_description, value) => {
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config.distDir).toBe(value);
  });
});
