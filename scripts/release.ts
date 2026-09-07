import { randomUUID } from "node:crypto";
import { lstat, readdir, readlink, realpath, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";

const releaseNamePattern = /^\.next-release-\d{8}T\d{6}Z-[a-f0-9]{7,40}$/;

const usage =
  "Usage: node scripts/release.ts switch <tree> <releaseDir>\n" +
  "       node scripts/release.ts prune <tree> [--keep N]";

async function main(): Promise<void> {
  const [command, tree, ...args] = process.argv.slice(2);
  if (command === "prune" && tree) {
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--keep")) {
      throw new Error(usage);
    }
    const keep = args.length === 0 ? "3" : args[1];
    if (!/^\d+$/.test(keep) || Number(keep) <= 0) {
      throw new Error(`--keep must be a positive integer: ${keep}`);
    }
    await pruneReleases(tree, Number(keep));
    return;
  }
  const [releaseDir] = args;
  if (command !== "switch" || !tree || !releaseDir || args.length !== 1) {
    throw new Error(usage);
  }
  await switchRelease(tree, releaseDir);
}

async function switchRelease(tree: string, releaseDir: string): Promise<void> {
  tree = await realpath(tree);
  const requested = path.resolve(tree, releaseDir);
  // Resolve aliases before validating the directory that will replace .next.
  const directory = await realpath(requested);
  const relative = path.relative(tree, directory);
  if (!relative || relative === ".." || /[\\/]/.test(relative) || path.isAbsolute(relative)) {
    throw new Error(
      `Invalid release directory: ${releaseDir}; the tracked tsconfig.json include ` +
      ".next/types/**/*.ts only resolves when distDir is one segment deep.",
    );
  }
  if (!releaseNamePattern.test(relative)) {
    throw new Error(
      `Invalid release directory name: ${relative}; expected ` +
      ".next-release-<YYYYMMDDTHHMMSSZ>-<7 to 40 lowercase hex characters>.",
    );
  }
  if (!(await stat(directory)).isDirectory()) {
    throw new Error(`Release is not a directory: ${directory}`);
  }
  for (const [name, isDirectory] of [["BUILD_ID", false], ["cache", true]] as const) {
    const marker = path.join(directory, name);
    const info = await lstat(marker);
    if (isDirectory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`Expected ${isDirectory ? "directory" : "file"}: ${marker}`);
    }
  }
  const current = path.join(tree, ".next");
  const existing = await lstat(current).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (existing?.isDirectory()) {
    throw new Error(
      `One-time migration: remove the existing ${current} directory by hand before switching.`,
    );
  }
  const temporary = path.join(tree, `.next-switch-${process.pid}-${randomUUID()}`);
  await symlink(relative, temporary, "dir");
  try {
    await rename(temporary, current);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
  console.log(directory);
}

async function pruneReleases(tree: string, keep: number): Promise<void> {
  const releases = path.resolve(tree);
  const current = path.resolve(tree, ".next");
  const served = await realpath(current).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return undefined;
  });
  const livePaths = served === undefined ? [] : await traceLivePaths(current);
  const entries = await readdir(releases, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const names = entries
    .filter((entry) => releaseNamePattern.test(entry.name) && entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const unprotected = served === undefined ? `${current} is missing or dangling; protecting no release.` : "";
  let removed = 0;
  for (const name of names.slice(keep)) {
    const directory = path.join(releases, name);
    const resolved = await realpath(directory);
    if (livePaths.some((live) => live === resolved || live.startsWith(resolved + path.sep))) continue;
    await rm(directory, { recursive: true });
    if (removed === 0 && unprotected) console.log(unprotected);
    console.log(directory);
    removed++;
  }
  if (removed === 0) console.log(["Nothing to remove.", unprotected].filter(Boolean).join(" "));
}

/** Keep intermediate link locations as well as the final target of the live path. */
async function traceLivePaths(filename: string): Promise<string[]> {
  const separator = path.sep === "\\" ? /[\\/]+/ : /\/+/;
  let resolved = path.parse(filename).root;
  let pending = filename.slice(resolved.length).split(separator);
  const required = new Set<string>();
  let links = 0;
  while (pending.length > 0) {
    const component = pending.shift()!;
    if (component === "" || component === ".") continue;
    if (component === "..") {
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, component);
    const info = await lstat(candidate);
    required.add(candidate);
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new Error(`Too many symbolic links in live path: ${filename}`);
      const target = await readlink(candidate);
      const root = path.parse(target).root;
      if (path.isAbsolute(target)) resolved = root;
      // Expand before interpreting '..': lexical normalization would erase dependencies.
      pending = [...target.slice(root.length).split(separator), ...pending];
    } else {
      resolved = candidate;
    }
  }
  return [...required];
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
