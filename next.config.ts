import type { NextConfig } from "next";
import { lstatSync } from "node:fs";
import path from "node:path";

const distDir = process.env.NEXT_DIST_DIR?.trim();

if (distDir) {
  const projectDir = process.cwd();
  const relativeDir = path.relative(projectDir, path.resolve(projectDir, distDir));

  if (
    path.isAbsolute(distDir) ||
    path.win32.isAbsolute(distDir) ||
    distDir.split(/[\\/]/).includes("..") ||
    relativeDir === ".." ||
    relativeDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDir)
  ) {
    throw new Error(`Invalid NEXT_DIST_DIR: ${process.env.NEXT_DIST_DIR}`);
  }

  let ancestor = projectDir;
  for (const segment of path.normalize(distDir).split(path.sep)) {
    if (!segment || segment === ".") continue;
    ancestor = path.join(ancestor, segment);
    let entry;
    try {
      entry = lstatSync(ancestor, { throwIfNoEntry: false });
    } catch {
      // Leave inaccessible or invalid output paths to Next's own diagnostics.
      break;
    }
    if (entry?.isSymbolicLink()) {
      throw new Error(`Invalid NEXT_DIST_DIR: ${process.env.NEXT_DIST_DIR}`);
    }
    if (!entry?.isDirectory()) break;
  }
}

const nextConfig: NextConfig = distDir ? { distDir } : {};

export default nextConfig;
