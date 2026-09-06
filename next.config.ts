import type { NextConfig } from "next";
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
}

const nextConfig: NextConfig = distDir ? { distDir } : {};

export default nextConfig;
