import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Returns one violation for every migration carried by base that is missing or changed on head. */
export function migrationImmutabilityViolations(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
): string[] {
  const violations: string[] = [];

  for (const [name, baseBlob] of base) {
    const headBlob = head.get(name);
    if (headBlob === baseBlob) {
      continue;
    }

    violations.push(
      headBlob === undefined
        ? `${name} is missing from the head (deleted or renamed).`
        : `${name} changed on the head (base blob ${baseBlob}, head blob ${headBlob}).`,
    );
  }

  return violations;
}

/** Reads regular file blobs below db/migrations at one revision. */
function migrationBlobsAt(revision: string): Map<string, string> {
  const result = spawnSync(
    "git",
    ["ls-tree", "-r", "-z", revision, "--", "db/migrations"],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (result.error !== undefined || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim();
    throw new Error(
      `Could not list db/migrations on ${revision}${detail.length === 0 ? "." : `: ${detail}`}`,
    );
  }

  const blobs = new Map<string, string>();
  for (const entry of result.stdout.split("\0")) {
    if (entry.length === 0) {
      continue;
    }

    const separator = entry.indexOf("\t");
    if (separator < 0) {
      throw new Error(`Could not parse a git ls-tree entry for db/migrations on ${revision}.`);
    }

    const [mode, type, blob] = entry.slice(0, separator).split(" ");
    const name = entry.slice(separator + 1);
    if (
      type === "blob" &&
      (mode === "100644" || mode === "100755") &&
      name.startsWith("db/migrations/")
    ) {
      if (blob === undefined || blob.length === 0) {
        throw new Error(`Could not parse a git ls-tree blob for ${name} on ${revision}.`);
      }
      blobs.set(name, blob);
    }
  }

  return blobs;
}

function main(args: readonly string[]): void {
  if (args.length !== 2) {
    process.stderr.write("Usage: node scripts/check-migration-edits.ts <base> <head>\n");
    process.exitCode = 1;
    return;
  }

  const [baseRevision, headRevision] = args;
  if (baseRevision === undefined || headRevision === undefined) {
    process.stderr.write("Usage: node scripts/check-migration-edits.ts <base> <head>\n");
    process.exitCode = 1;
    return;
  }

  try {
    const base = migrationBlobsAt(baseRevision);
    const head = migrationBlobsAt(headRevision);
    const violations = migrationImmutabilityViolations(base, head);

    if (violations.length > 0) {
      for (const violation of violations) {
        process.stdout.write(`${violation}\n`);
      }
      process.stdout.write(
        "db/migrations is append-only: a migration merged to the default branch is immutable " +
          "(issue 657). Revert the edit and write a new migration instead.\n",
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `${base.size} migrations carried on ${baseRevision} are byte-identical on ${headRevision}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
