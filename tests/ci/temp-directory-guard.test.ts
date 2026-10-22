import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint();
const rawFixture = 'import * as fs from "node:fs"; export const directory = fs.mkdtempSync("fixture-");';

const fixtures = [
  ["named import", (name: string) => `import { ${name} } from "node:fs"; void ${name}("fixture-");`],
  ["aliased import", (name: string) => `import { ${name} as make } from "node:fs/promises"; void make("fixture-");`],
  ["namespace", (name: string) => `import * as fs from "node:fs"; void fs.${name}("fixture-");`],
  ["computed member", (name: string) => `import * as fs from "node:fs"; void fs["${name}"]("fixture-");`],
  ["static template member", (name: string) => `import fs from "node:fs"; void fs[\`${name}\`]("fixture-");`],
  ["escaped static template member", (name: string) => `import fs from "node:fs"; void fs[\`${name.replace("m", "\\u006d")}\`]("fixture-");`],
  ["static template destructuring", (name: string) => `const { [\`${name}\`]: make } = require("node:fs"); void make("fixture-");`],
  ["optional member", (name: string) => `import * as fs from "node:fs"; void fs?.${name}?.("fixture-");`],
  ["destructured require", (name: string) => `const { "${name}": make } = require("node:fs"); void make("fixture-");`],
] as const;

describe("owned temp directory ESLint guard", () => {
  for (const name of ["mkdtemp", "mkdtempSync"]) {
    it.each(fixtures)(`rejects ${name} through %s`, async (_shape, source) => {
      const [result] = await eslint.lintText(source(name), { filePath: "tests/fixtures/temp-guard-control.ts" });
      expect(result.fatalErrorCount).toBe(0);
      expect(result.messages.some(({ ruleId, severity }) => ruleId === "no-restricted-syntax" && severity === 2)).toBe(true);
    });
  }

  it.each([
    "tests/support/owned-temp-directory.test.ts",
    "tests/support/owned-temp-directory-extra.ts",
    "tests/support/owned-temp-directory.tsx",
  ])("also rejects a raw creator in the helper's sibling %s", async (filePath) => {
    const [result] = await eslint.lintText(rawFixture, { filePath });
    expect(result.fatalErrorCount).toBe(0);
    expect(result.messages.some(({ ruleId, severity }) => ruleId === "no-restricted-syntax" && severity === 2)).toBe(true);
  });

  it.each(["tests/support/owned-temp-directory.ts", "scripts/temp-guard-control.ts"])(
    "allows the raw implementation at %s", async (filePath) => {
      const [result] = await eslint.lintText(rawFixture, { filePath });
      expect(result.errorCount).toBe(0);
      expect(result.warningCount).toBe(0);
    },
  );

  it.each([
    'export const first = `mkdtempSync`[0];',
    'const key = "file"; export const value = { [key]: `mkdtempSync` };',
  ])("allows allocator-name templates outside property lookup: %s", async (source) => {
    const [result] = await eslint.lintText(source, { filePath: "tests/fixtures/temp-guard-control.ts" });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  it("allows owned allocation and disposal in tests", async () => {
    const [result] = await eslint.lintText([
      'import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";',
      'const fixtures = createOwnedTempDirectoryRegistry("fixture-");',
      "fixtures.create(); fixtures.dispose();",
    ].join("\n"), { filePath: "tests/fixtures/temp-guard-control.ts" });
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });
});
