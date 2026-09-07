import type { NextConfig } from "next";
import { lstatSync } from "node:fs";
import path from "node:path";

const distDir = process.env.NEXT_DIST_DIR?.trim();

if (distDir) {
  const projectDir = process.cwd();
  const relativeDir = path.relative(projectDir, path.resolve(projectDir, distDir));

  if (!relativeDir || /[\\/]/.test(distDir)) {
    throw new Error(
      `Invalid NEXT_DIST_DIR: ${process.env.NEXT_DIST_DIR}; use a direct child directory beside .next.`,
    );
  }

  if (
    path.isAbsolute(distDir) ||
    path.win32.isAbsolute(distDir) ||
    distDir === ".." ||
    relativeDir === ".." ||
    relativeDir.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeDir)
  ) {
    throw new Error(`Invalid NEXT_DIST_DIR: ${process.env.NEXT_DIST_DIR}`);
  }

  let entry;
  try {
    entry = lstatSync(path.join(projectDir, distDir), { throwIfNoEntry: false });
  } catch {
    // Leave inaccessible or invalid output paths to Next's own diagnostics.
  }
  if (entry?.isSymbolicLink()) {
    throw new Error(`Invalid NEXT_DIST_DIR: ${process.env.NEXT_DIST_DIR}`);
  }
}

const nextConfig: NextConfig = distDir
  ? { distDir, typescript: { tsconfigPath: "tsconfig.release.json" } }
  : {};

export default nextConfig;
