import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const distDir = process.env.NEXT_DIST_DIR?.trim();
const tsconfigPath = distDir ? `${distDir}.tsconfig.json` : undefined;

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

  try {
    const filename = path.join(projectDir, tsconfigPath!);
    if (!lstatSync(filename).isFile()) throw new Error("Expected a regular config file");
    const { releaseConfig, ...config } = JSON.parse(readFileSync(filename, "utf8"));
    const sourceHash = createHash("sha256").update(readFileSync(path.join(projectDir, "tsconfig.json"))).digest("hex");
    // Next may append only this release's validators after the initial config
    // load. Exclude those additions from the preparation fingerprint.
    config.include = config.include.filter((entry: string) =>
      entry !== `${distDir}/types/**/*.ts` && entry !== `${distDir}/dev/types/**/*.ts`,
    );
    const configHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    if (releaseConfig?.distDir !== distDir || releaseConfig.sourceHash !== sourceHash || releaseConfig.configHash !== configHash) {
      throw new Error("Config does not match its preparation or the tracked tsconfig.json");
    }
  } catch (cause) {
    const args = [projectDir, distDir].map((argument) => `'${argument.replaceAll("'", "'\\''")}'`).join(" ");
    throw new Error(
      `Missing, stale or invalid ${tsconfigPath} for NEXT_DIST_DIR=${distDir}; run node scripts/release.ts prepare ${args} before building.`,
      { cause },
    );
  }
}

const nextConfig: NextConfig = distDir
  ? { distDir, typescript: { tsconfigPath } }
  : {};

export default nextConfig;
