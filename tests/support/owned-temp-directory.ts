import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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

export function createOwnedTempDirectoryRegistry(prefixes: string | readonly string[]) {
  const initial = typeof prefixes === "string" ? [prefixes] : prefixes;
  const armed = new Set(initial);
  for (const prefix of armed) reclaimOwnedTempDirectories(prefix);
  const directories = new Set<string>();
  function arm(prefix: string): void {
    if (!armed.has(prefix)) {
      reclaimOwnedTempDirectories(prefix);
      armed.add(prefix);
    }
  }
  return {
    create(prefix = initial[0]): string {
      arm(prefix);
      const directory = createOwnedTempDirectory(prefix);
      directories.add(directory);
      return directory;
    },
    async createAsync(prefix = initial[0]): Promise<string> {
      arm(prefix);
      const directory = await mkdtemp(`${prefix}${process.pid}-`);
      directories.add(directory);
      return directory;
    },
    dispose(directory?: string): void {
      for (const path of directory === undefined ? directories : [directory]) {
        rmSync(path, { recursive: true, force: true });
        directories.delete(path);
      }
    },
    async disposeAsync(directory?: string): Promise<void> {
      for (const path of directory === undefined ? directories : [directory]) {
        await rm(path, { recursive: true, force: true });
        directories.delete(path);
      }
    },
  };
}
