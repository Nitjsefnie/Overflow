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
    // These two input-absolute checks are unreachable: absolute inputs contain
    // a separator and are rejected above. Retain them as defence in depth.
    path.isAbsolute(distDir) ||
    path.win32.isAbsolute(distDir) ||
    distDir === ".." ||
    relativeDir === ".." ||
    relativeDir.startsWith(`..${path.sep}`) ||
    // This check is load-bearing on Windows: separator-free drive-relative
    // inputs (D:build from C:) can resolve onto another drive, making relativeDir
    // absolute. Separator-bearing inputs are already rejected above.
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

// Framing protection (issue 677): refuse cross-site framing everywhere. The
// CSP carries exactly frame-ancestors 'none' — no other directive, so Next's
// inline scripts are unaffected — with X-Frame-Options: DENY as the fallback
// for clients without CSP frame-ancestors support.
const frameProtectionHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig: NextConfig = {
  // next dev generates AGENTS.md and CLAUDE.md at the project root by default
  // (gated on agentRules !== false in next's start-server); this repository's
  // agent documentation is not generated, so a dev run must write nothing.
  agentRules: false,
  ...(distDir ? { distDir, typescript: { tsconfigPath } } : {}),
  async headers() {
    return [{ source: "/:path*", headers: frameProtectionHeaders }];
  },
};

export default nextConfig;
