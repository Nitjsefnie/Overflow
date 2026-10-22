import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Ownership is part of the name at creation, so even a kill immediately after
 * mkdtemp leaves a reclaimable directory rather than an unmarked orphan.
 */
export function createOwnedTempDirectory(prefix: string): string {
  return mkdtempSync(`${prefix}${process.pid}-`);
}

/**
 * Reclaims only this prefix's dead owners. Live or inaccessible PIDs, legacy
 * unmarked directories and symlinks stay untouched, protecting parallel runs.
 */
export function reclaimOwnedTempDirectories(prefix: string): void {
  const parent = dirname(prefix);
  const stem = basename(prefix);
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(stem)) continue;
    const owner = /^([1-9]\d*)-[A-Za-z0-9]{6}$/.exec(entry.name.slice(stem.length));
    if (!owner) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        rmSync(join(parent, entry.name), { recursive: true, force: true });
      }
    }
  }
}
