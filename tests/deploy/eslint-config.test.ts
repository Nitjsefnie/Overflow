import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: fileURLToPath(new URL("../..", import.meta.url)) });

describe("ESLint release output ignores", () => {
  it.each([
    ".next-release-20260907T061600Z-918a0d4/server/app/page.js",
    ".next-release-20260907T061600Z-0123456789abcdef0123456789abcdef01234567/types/validator.ts",
  ])("ignores generated output at %s", async (filename) => {
    expect(await eslint.isPathIgnored(filename)).toBe(true);
  });

  it.each([
    "src/app/page.tsx",
    ".next-release-helper.ts",
    "src/.next-release-20260907T061600Z-918a0d4/helper.ts",
  ])("keeps source linted at %s", async (filename) => {
    expect(await eslint.isPathIgnored(filename)).toBe(false);
  });
});
