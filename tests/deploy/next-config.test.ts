import { afterEach, describe, expect, it, vi } from "vitest";

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
    ["a nested release path", ".next-releases/20260907T101500Z-abc1234"],
  ])("uses %s unchanged", async (_description, value) => {
    process.env.NEXT_DIST_DIR = value;
    vi.resetModules();

    const { default: config } = await import("../../next.config");

    expect(config.distDir).toBe(value);
  });
});
