import { spawnSync } from "node:child_process";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const project = fileURLToPath(new URL("../..", import.meta.url));
const script = path.join(project, "scripts/release.ts");
const name = ".next-release-20260907T060000Z-918a0d4";
let fixture: string;
let tree: string;

beforeEach(async () => {
  fixture = await mkdtemp(path.join(os.tmpdir(), "overflow-release-check-"));
  tree = path.join(fixture, "project");
  await mkdir(tree);
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function release(directory: string) {
  await mkdir(path.join(directory, "cache"), { recursive: true });
  await writeFile(path.join(directory, "BUILD_ID"), "completed");
}

async function snapshot(directory: string): Promise<unknown> {
  const info = await lstat(directory);
  return {
    inode: info.ino, mode: info.mode, mtime: info.mtimeMs, ctime: info.ctimeMs,
    contents: info.isSymbolicLink() ? await readlink(directory)
      : info.isDirectory() ? await Promise.all((await readdir(directory)).map(async (entry) =>
        [entry, await snapshot(path.join(directory, entry))]))
        : await readFile(directory, "utf8"),
  };
}

function run(command: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, command, tree, ...args], { encoding: "utf8" });
}

it.each([
  ["relative", 0], ["absolute", 0], ["alias", 0], ["40 hex digits", 0],
  ["6 hex digits", 1], ["41 hex digits", 1], ["uppercase", 1],
  ["nested", 1], ["outside", 1], ["tree root", 1], ["missing", 1], ["file", 1],
  ["missing BUILD_ID", 1], ["missing cache", 1],
  ["directory BUILD_ID", 1], ["file cache", 1],
  ["symlink BUILD_ID", 1], ["symlink cache", 1],
  ["alias to nested", 1], ["alias to malformed", 1],
] as const)("check and switch agree on %s; check changes nothing", async (kind, status) => {
  const old = path.join(tree, ".next-release-20260906T060000Z-918a0d4");
  await release(old);
  await symlink(path.basename(old), path.join(tree, ".next"));
  let directory = path.join(tree, name);
  if (kind === "nested" || kind === "alias to nested") directory = path.join(tree, "releases", name);
  if (kind === "outside") directory = path.join(fixture, name);
  if (kind === "tree root") directory = tree;
  if (kind === "6 hex digits") directory = path.join(tree, name.slice(0, -1));
  if (kind === "41 hex digits" || kind === "40 hex digits") {
    directory = path.join(tree, `.next-release-20260907T060000Z-${"a".repeat(kind === "41 hex digits" ? 41 : 40)}`);
  }
  if (kind === "uppercase") directory = path.join(tree, name.toUpperCase());
  if (kind === "alias to malformed") directory = path.join(tree, ".next-release-notes");
  if (kind === "file") await writeFile(directory, "not a directory");
  else if (kind !== "missing") await release(directory);
  if (/^(missing|directory|file|symlink) (BUILD_ID|cache)$/.test(kind)) {
    const [form, marker] = kind.split(" ");
    const target = path.join(directory, marker);
    await rm(target, { recursive: true });
    if (form === "directory") await mkdir(target);
    if (form === "file") await writeFile(target, "not a directory");
    if (form === "symlink") await symlink(path.join(old, marker), target);
  }
  let argument = kind === "absolute" ? directory : path.relative(tree, directory) || ".";
  if (kind.startsWith("alias")) {
    argument = ".next-release-20260907T060000Z-aaaaaaa";
    await symlink(path.relative(tree, directory), path.join(tree, argument));
  }
  const before = await snapshot(fixture);

  const checked = run("check", argument);

  expect(checked.status, checked.stderr).toBe(status);
  expect(await snapshot(fixture)).toEqual(before);
  if (status === 0) expect(checked.stdout.trim()).toBe(directory);
  else expect(checked.stderr).toContain(kind === "tree root" || (kind.startsWith("alias") && kind !== "alias to malformed") ? argument : path.basename(directory));
  const switched = run("switch", argument);
  expect(switched.status, switched.stderr).toBe(status);
  if (status === 0) expect(await readlink(path.join(tree, ".next"))).toBe(path.basename(directory));
  else expect(await snapshot(fixture)).toEqual(before);
});

it("checks a migration candidate while leaving the real .next directory intact", async () => {
  await release(path.join(tree, name));
  await release(path.join(tree, ".next"));
  const before = await snapshot(fixture);

  const result = run("check", name);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(path.join(tree, name));
  expect(await snapshot(fixture)).toEqual(before);
});

it.each([[], [name, "extra"]])("rejects malformed check arguments %j without writes", async (...args) => {
  await release(path.join(tree, name));
  const before = await snapshot(fixture);

  const result = run("check", ...args);

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("check");
  expect(await snapshot(fixture)).toEqual(before);
});

it("runs every documented name generator with core.abbrev=4 and switches the result", async () => {
  const document = await readFile(path.join(project, "deploy/README.md"), "utf8");
  const generators = [...document.matchAll(/^release=.*$/gm)];
  expect(generators.length).toBeGreaterThan(0);
  for (const [generator] of generators) {
    const generated = spawnSync("bash", ["-ec", `${generator}\nprintf '%s' "$release"`], {
      cwd: project,
      env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.abbrev", GIT_CONFIG_VALUE_0: "4" },
      encoding: "utf8",
    });
    expect(generated.status, generated.stderr).toBe(0);
    await release(path.join(tree, generated.stdout));

    const result = run("switch", generated.stdout);

    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(tree, ".next"))).toBe(generated.stdout);
  }
});

it.each(["malformed name", "nested", "valid"])("runs the documented migration with a %s candidate", async (kind) => {
  const document = await readFile(path.join(project, "deploy/README.md"), "utf8");
  const blocks = [...document.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  const migration = blocks.find((block) => block.includes("rm -rf -- /srv/overflow/.next"));
  expect(migration).toBeDefined();
  const candidate = kind === "malformed name" ? name.slice(0, -3) : kind === "nested" ? `releases/${name}` : name;
  await release(path.join(tree, candidate));
  await release(path.join(tree, ".next"));
  await mkdir(path.join(tree, "scripts"));
  await copyFile(script, path.join(tree, "scripts/release.ts"));
  const before = await snapshot(fixture);
  // Execute the real procedure in a disposable tree. Only pnpm dispatch and
  // systemd are adapted; candidate validation, rm and switch all run for real.
  const result = spawnSync("bash", ["-ec", `
    pnpm() { test "$1" = release:switch; shift; "$NODE" "$SCRIPT" switch "$@"; }
    systemctl() { test "$*" = 'restart overflow.service'; printf 'restart-reached\\n'; }
    ${migration!.replaceAll("/srv/overflow", tree)}
  `], {
    cwd: tree,
    env: { ...process.env, release: candidate, NODE: process.execPath, SCRIPT: script },
    encoding: "utf8",
  });

  if (kind === "valid") {
    expect(result.status, result.stderr).toBe(0);
    expect(await readlink(path.join(tree, ".next"))).toBe(name);
    expect(result.stdout).toContain("restart-reached");
  } else {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(candidate);
    expect(await snapshot(fixture)).toEqual(before);
    expect(result.stdout).not.toContain("restart-reached");
  }
});
