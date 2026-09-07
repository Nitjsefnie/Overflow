import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../scripts/release.ts", import.meta.url));
const release = ".next-release-20260907T070000Z-abc1234";
let tree: string;

beforeEach(async () => {
  tree = await mkdtemp(path.join(os.tmpdir(), "overflow-release-prepare-"));
});

afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
});

function prepare(...args: string[]) {
  return spawnSync(process.execPath, [script, "prepare", tree, ...args], { encoding: "utf8" });
}

it("accepts TypeScript config comments and trailing commas without changing the tracked input", async () => {
  const input = `{
    // Preserve the repository's checking rules.
    "compilerOptions": { "strict": true, "noUncheckedIndexedAccess": true, },
    "include": ["src/**/*.ts", ".next/types/**/*.ts",],
  }`;
  await writeFile(path.join(tree, "tsconfig.json"), input);

  const result = prepare(release);

  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(await readFile(path.join(tree, `${release}.tsconfig.json`), "utf8"));
  expect(config.compilerOptions).toEqual({ strict: true, noUncheckedIndexedAccess: true });
  expect(config.include).toEqual(["src/**/*.ts"]);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(input);
});

it.each([
  { config: { compilerOptions: { strict: true } }, diagnostic: "include" },
  { config: { include: "src/**/*.ts" }, diagnostic: "include" },
  { config: { include: [42] }, diagnostic: "include" },
  { config: { include: ["src/**/*.ts"], extends: "./base.json" }, diagnostic: "extends" },
  { config: { include: ["src/**/*.ts"], references: [] }, diagnostic: "references" },
  { config: { include: ["src/**/*.ts"], releaseConfig: {} }, diagnostic: "releaseConfig" },
])("diagnoses unsupported $diagnostic input before replacing a generated config", async ({ config, diagnostic }) => {
  const input = JSON.stringify(config);
  await writeFile(path.join(tree, "tsconfig.json"), input);
  const previous = "previous preparation";
  await writeFile(path.join(tree, `${release}.tsconfig.json`), previous);

  const result = prepare(release);

  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stderr).toContain("tsconfig.json");
  expect(result.stderr).toContain(diagnostic);
  expect(await readFile(path.join(tree, `${release}.tsconfig.json`), "utf8")).toBe(previous);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(input);
});

it("reports a TypeScript diagnostic for a malformed tracked config without generating a file", async () => {
  await writeFile(path.join(tree, "tsconfig.json"), '{ "include": [ }');

  const result = prepare(release);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("tsconfig.json");
  expect(result.stderr).toMatch(/TS\d+/);
  expect(await readdir(tree)).toEqual(["tsconfig.json"]);
});

it.each([[], [release, "extra"], [""], ["."], [".."], ["../outside"], ["/tmp/outside"], ["nested/release"], ["nested\\release"]])(
  "rejects invalid preparation arguments %j before writing a config",
  async (...args) => {
    const input = '{"include":["src/**/*.ts"]}';
    await writeFile(path.join(tree, "tsconfig.json"), input);

    const result = prepare(...args);

    expect(result.status).toBe(1);
    expect(result.stderr.trim()).not.toBe("");
    expect(await readdir(tree)).toEqual(["tsconfig.json"]);
    expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(input);
  },
);
