import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const project = fileURLToPath(new URL("../..", import.meta.url));
let tree: string;
let trackedConfig: string;

beforeEach(async () => {
  tree = await mkdtemp(path.join(os.tmpdir(), "overflow-release-build-"));
  await mkdir(path.join(tree, "scripts"));
  await mkdir(path.join(tree, "src/app/review-removal"), { recursive: true });
  for (const file of ["next.config.ts", "tsconfig.json", "package.json", "scripts/release.ts"]) {
    await copyFile(path.join(project, file), path.join(tree, file));
  }
  trackedConfig = await readFile(path.join(tree, "tsconfig.json"), "utf8");
  // Read the installed dependencies without changing their ownership or modes.
  await symlink(path.join(project, "node_modules"), path.join(tree, "node_modules"), "dir");
  await writeFile(path.join(tree, "src/app/layout.tsx"), `
    export default function Layout({ children }: { children: React.ReactNode }) {
      return <html><body>{children}</body></html>;
    }
  `);
  await writeFile(path.join(tree, "src/app/page.tsx"), "export default function Page() { return <p>Home</p>; }");
  await writeFile(path.join(tree, "src/app/review-removal/page.tsx"), "export default function Page() { return <p>Remove me</p>; }");
});

afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
});

function prepare(release: string) {
  const prepared = spawnSync(process.execPath, ["scripts/release.ts", "prepare", tree, release], { cwd: tree, encoding: "utf8" });
  expect(prepared.status, prepared.stderr).toBe(0);
  return prepared.stdout.trim();
}

function build(release: string) {
  // Webpack supports the external node_modules link in this disposable fixture.
  const result = spawnSync(process.execPath, [path.join(project, "node_modules/next/dist/bin/next"), "build", "--webpack"], {
    cwd: tree,
    env: { ...process.env, NEXT_DIST_DIR: release, NEXT_TELEMETRY_DISABLED: "1" },
    encoding: "utf8",
    timeout: 120_000,
  });
  console.log(`Next build ${release}: exit ${result.status}`);
  return result;
}

it("regenerates a deploy config with source includes and no previous release types", async () => {
  const release = ".next-release-20260907T055900Z-918a0d4";
  const previous = JSON.parse(trackedConfig);
  previous.include.push("./.next-release-old/types/**/*.ts", ".next-release-older\\types\\**\\*.ts");
  const input = JSON.stringify(previous);
  await writeFile(path.join(tree, "tsconfig.json"), input);
  await writeFile(path.join(tree, `${release}.tsconfig.json`), '{"include":[".next-release-stale/types/**/*.ts"]}');

  const result = spawnSync(process.execPath, ["scripts/release.ts", "prepare", tree, release], { cwd: tree, encoding: "utf8" });

  expect(result.status, result.stderr).toBe(0);
  const generated = JSON.parse(await readFile(path.join(tree, `${release}.tsconfig.json`), "utf8"));
  expect(generated.include).toEqual(["src/**/*.ts", "src/**/*.tsx", "scripts/**/*.ts", "tests/**/*.ts", "*.ts"]);
  expect(generated.compilerOptions).toEqual(previous.compilerOptions);
  expect(generated.exclude).toEqual(["node_modules"]);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(input);
});

it("builds a replacement after removing a route while its previous release is still selected", async () => {
  const first = ".next-release-20260907T060000Z-918a0d4";
  const second = ".next-release-20260907T060100Z-918a0d4";
  prepare(first);
  const initial = build(first);
  expect(initial.status, initial.stdout + initial.stderr).toBe(0);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(trackedConfig);
  const switched = spawnSync(process.execPath, ["scripts/release.ts", "switch", tree, first], {
    cwd: tree,
    encoding: "utf8",
  });
  expect(switched.status, switched.stderr).toBe(0);
  expect(await readlink(path.join(tree, ".next"))).toBe(first);
  await rm(path.join(tree, "src/app/review-removal"), { recursive: true });

  prepare(second);
  const replacement = build(second);

  expect(replacement.status, replacement.stdout + replacement.stderr).toBe(0);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(trackedConfig);
  expect(await readlink(path.join(tree, ".next"))).toBe(first);
  expect((await readFile(path.join(tree, second, "BUILD_ID"), "utf8")).trim()).not.toBe("");
  const program = spawnSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"), "--showConfig", "--project", `${second}.tsconfig.json`], {
    cwd: tree, encoding: "utf8",
  });
  expect(program.status, program.stderr).toBe(0);
  const files: string[] = JSON.parse(program.stdout).files;
  expect(files).toContain(`./${second}/types/validator.ts`);
  expect(files.some((file) => file.startsWith("./.next/") || file.startsWith(`./${first}/`))).toBe(false);
}, 240_000);

it("type-checks the new release's generated route validators", async () => {
  const release = ".next-release-20260907T060200Z-918a0d4";
  await writeFile(path.join(tree, "src/app/review-removal/page.tsx"), `
    export default function Page() { return <p>Invalid route</p>; }
    export function generateStaticParams() { return 42; }
  `);

  prepare(release);
  const result = build(release);

  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain(`${release}/types/`);
  expect(result.stdout + result.stderr).toContain("generateStaticParams");
  expect(result.stdout + result.stderr).toMatch(/TS\d+/);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(trackedConfig);
});

it("refuses an unprepared release before Next can create a weaker TypeScript config", async () => {
  const release = ".next-release-20260907T060300Z-918a0d4";
  await writeFile(path.join(tree, "src/strict-probe.ts"), "export function identity(value) { return value; }");
  const strict = spawnSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"), "--project", "tsconfig.json"], {
    cwd: tree, encoding: "utf8",
  });
  expect(strict.status, strict.stdout + strict.stderr).toBe(2);
  expect(strict.stdout + strict.stderr).toContain("TS7006");

  const result = build(release);

  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain("scripts/release.ts prepare");
  expect(result.stdout + result.stderr).toContain(release);
  await expect(lstat(path.join(tree, release, "BUILD_ID"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(tree, `${release}.tsconfig.json`))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(tree, "tsconfig.release.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(trackedConfig);

  prepare(release);
  const preparedBuild = build(release);
  expect(preparedBuild.status, preparedBuild.stdout + preparedBuild.stderr).toBe(1);
  expect(preparedBuild.stdout + preparedBuild.stderr).toContain("TS7006");
  await expect(lstat(path.join(tree, release, "BUILD_ID"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(trackedConfig);
});

it("refuses an unprepared replacement when only the previous release's config exists", async () => {
  const first = ".next-release-20260907T060400Z-918a0d4";
  const second = ".next-release-20260907T060500Z-918a0d4";
  const firstConfig = prepare(first);
  const initial = build(first);
  expect(initial.status, initial.stdout + initial.stderr).toBe(0);
  const switched = spawnSync(process.execPath, ["scripts/release.ts", "switch", tree, first], {
    cwd: tree, encoding: "utf8",
  });
  expect(switched.status, switched.stderr).toBe(0);
  const previousConfig = await readFile(firstConfig, "utf8");
  await rm(path.join(tree, "src/app/page.tsx"));
  await mkdir(path.join(tree, "src/app/replacement"));
  await writeFile(path.join(tree, "src/app/replacement/page.tsx"), "export default function Page() { return <p>Replacement</p>; }");
  const updated = JSON.parse(trackedConfig);
  updated.compilerOptions.noUncheckedIndexedAccess = true;
  const input = JSON.stringify(updated);
  await writeFile(path.join(tree, "tsconfig.json"), input);

  const result = build(second);

  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(result.stdout + result.stderr).toContain("scripts/release.ts prepare");
  expect(result.stdout + result.stderr).toContain(second);
  await expect(lstat(path.join(tree, second, "BUILD_ID"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(tree, `${second}.tsconfig.json`))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(firstConfig, "utf8")).toBe(previousConfig);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(input);
  expect(await readlink(path.join(tree, ".next"))).toBe(first);

  prepare(second);
  const replacement = build(second);
  expect(replacement.status, replacement.stdout + replacement.stderr).toBe(0);
  const program = spawnSync(process.execPath, [path.join(project, "node_modules/typescript/bin/tsc"), "--showConfig", "--project", `${second}.tsconfig.json`], {
    cwd: tree, encoding: "utf8",
  });
  expect(program.status, program.stdout + program.stderr).toBe(0);
  const config = JSON.parse(program.stdout);
  expect(config.compilerOptions.noUncheckedIndexedAccess).toBe(true);
  expect(config.files).toContain(`./${second}/types/validator.ts`);
  expect(config.files.some((file: string) => file.startsWith("./.next/") || file.startsWith(`./${first}/`))).toBe(false);
  expect(await readFile(firstConfig, "utf8")).toBe(previousConfig);
  expect(await readFile(path.join(tree, "tsconfig.json"), "utf8")).toBe(input);
  expect(await readlink(path.join(tree, ".next"))).toBe(first);
}, 240_000);
