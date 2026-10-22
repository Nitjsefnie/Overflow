import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Put ownership in the name so a kill cannot leave an unmarked directory.
export function createOwnedTempDirectory(prefix: string): string {
  return mkdtempSync(`${prefix}${process.pid}-`);
}

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

export function createOwnedTempDirectoryRegistry(prefix: string) {
  reclaimOwnedTempDirectories(prefix);
  const directories = new Set<string>();
  return {
    create(): string {
      const directory = createOwnedTempDirectory(prefix);
      directories.add(directory);
      return directory;
    },
    dispose(): void {
      for (const directory of directories) {
        rmSync(directory, { recursive: true, force: true });
        directories.delete(directory);
      }
    },
  };
}
