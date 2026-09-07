import { randomUUID } from "node:crypto";
import { lstat, readdir, realpath, rename, rm, stat, symlink, unlink } from "node:fs/promises";
import path from "node:path";

async function main(): Promise<void> {
  const [command, tree, ...args] = process.argv.slice(2);
  if (command === "prune" && tree) {
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--keep")) {
      throw new Error("Usage: node scripts/release.ts prune <tree> [--keep N]");
    }
    const keep = args.length === 0 ? "3" : args[1];
    if (!/^\d+$/.test(keep) || Number(keep) <= 0) {
      throw new Error(`--keep must be a positive integer: ${keep}`);
    }
    await pruneReleases(tree, Number(keep));
    return;
  }
  const [releaseDir] = args;
  if (command !== "switch" || !tree || !releaseDir) {
    throw new Error("Usage: node scripts/release.ts switch <tree> <releaseDir>");
  }
  await switchRelease(tree, releaseDir);
}

async function switchRelease(tree: string, releaseDir: string): Promise<void> {
  tree = await realpath(tree);
  const requested = path.resolve(tree, releaseDir);
  if (!(await stat(requested)).isDirectory()) {
    throw new Error(`Release is not a directory: ${requested}`);
  }
  for (const [name, directory] of [["BUILD_ID", false], ["cache", true]] as const) {
    const marker = path.join(requested, name);
    const info = await stat(marker);
    if (directory ? !info.isDirectory() : !info.isFile()) {
      throw new Error(`Expected ${directory ? "directory" : "file"}: ${marker}`);
    }
  }
  // Resolve aliases before replacing .next, including a release argument through .next itself.
  const directory = await realpath(requested);
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
  await symlink(path.relative(tree, directory) || ".", temporary, "dir");
  try {
    await rename(temporary, current);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
  console.log(directory);
}

async function pruneReleases(tree: string, keep: number): Promise<void> {
  const releases = path.resolve(tree, ".next-releases");
  const current = path.resolve(tree, ".next");
  const served = await realpath(current).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    return undefined;
  });
  const entries = await readdir(releases, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return [];
  });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const unprotected = served === undefined ? `${current} is missing or dangling; protecting no release.` : "";
  let removed = 0;
  for (const name of names.slice(keep)) {
    const directory = path.join(releases, name);
    const resolved = await realpath(directory);
    if (served === resolved || served?.startsWith(resolved + path.sep)) continue;
    await rm(directory, { recursive: true });
    if (removed === 0 && unprotected) console.log(unprotected);
    console.log(directory);
    removed++;
  }
  if (removed === 0) console.log(["Nothing to remove.", unprotected].filter(Boolean).join(" "));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
