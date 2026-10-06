import { writeSync } from "node:fs";

/**
 * The string whose presence in a run's test files means the run needs the
 * shared postgres server. Importing startPostgresContainer IS the dependency
 * edge: the shared path provisions through it, and an unused import cannot
 * survive the lint gate.
 */
export const SHARED_POSTGRES_MARKER = "startPostgresContainer";

function warnToStderr(message: string): void {
  writeSync(2, `${message}\n`);
}

/**
 * Whether any of the run's test files needs the shared postgres server
 * (issue 1070): true iff any file's content contains the marker. Read errors
 * on an individual file are no-match for that file plus a stderr warning —
 * a vanished file between spec resolution and the scan must not crash the
 * run, and must not silently decide a DB run needs no server. The empty list
 * is false (no files, no suite, no need): vitest resolves the specifications
 * before global setup and throws FilesNotFoundError on zero, so the reachable
 * cases are all non-empty, and a missed need fails a DB suite loudly while an
 * unneeded start is the defect this scan exists to prevent.
 *
 * Substring semantics: a mention without the import is a false positive on
 * the safe side (a container starts that the run does not need); a missed
 * need is the loud direction.
 */
export function runNeedsSharedPostgres(
  filePaths: readonly string[],
  readFile: (path: string) => string,
  warn: (message: string) => void = warnToStderr,
): boolean {
  for (const path of filePaths) {
    let contents: string;
    try {
      contents = readFile(path);
    } catch (error) {
      warn(`shared-postgres need scan: could not read ${path} (${String(error)}); treating it as not needing the shared postgres`);
      continue;
    }
    if (contents.includes(SHARED_POSTGRES_MARKER)) {
      return true;
    }
  }
  return false;
}
