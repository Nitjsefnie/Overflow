import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The test suite runs against whatever sits in `node_modules/postgres`, and
 * nothing else in CI checks that it is the build the repository pins. Two
 * failures have been observed, in both directions:
 *
 * - a tree whose install drifted (or was never re-installed after the patch
 *   moved) runs the whole suite against a build that does not match
 *   `patches/postgres@3.4.9.patch` and passes, and
 * - a tree resolving to an UNPATCHED postgres@3.4.9 fails exactly one db suite
 *   with a 120-second timeout that reads like a regression in the branch under
 *   work.
 *
 * The two hand-checks people reach for are both wrong: `postgres`' exports map
 * has no `./package.json` entry, so `require.resolve` throws identically
 * whether or not the patch is applied; and a `_patch_hash=` suffix proves *a*
 * patch, not *this* one — the store keeps one directory per patch revision.
 *
 * So this guard pins all four links of the chain, each with a failure message
 * that names its own mismatch, so a drifted install is distinguishable at a
 * glance from a db-suite timeout:
 *
 * 1. the committed pair — sha256 of the patch file equals the `hash:` pnpm
 *    pins under `patchedDependencies` (catches one half edited without the
 *    other);
 * 2. the resolved build — `node_modules/postgres` resolves to the store
 *    directory whose name carries `_patch_hash=<that hash>` (catches an
 *    unpatched or wrong-build resolution);
 * 3. the installed surface — every hunk of the patch's post-image is present,
 *   verbatim, in the installed file it names (catches a drifted
 *   `node_modules` even when the directory name looks right);
 * 4. the CJS entry — `node -e "require('postgres')"` must exit nonzero with
 *    output naming the guard. The exports map routes every CommonJS load
 *    through `cjs/src/index.js`, which the patch makes throw, so a require
 *    that succeeds is the unpatched stock client loading silently — the
 *    end-to-end shape checks 1-3 exist to prevent.
 *
 * The patch now also names `cjs/src/index.js` — the guard hunk — so check 3
 * verifies the installed `cjs/src/index.js` carries it too. The file set of
 * check 3 is derived from the patch itself, so it reads only files the patch
 * names; the `cf/` copy — the `workerd` export condition, unreachable in
 * Node — stays unpatched and unread.
 *
 * The reverse is deliberate too: drift in the between-hunks regions of those
 * files — text the patch never touches, such as `terminate()`'s stock copy of
 * the settled line — is unpinned, because the guard pins patch fidelity of the
 * hunks' post-image surface, not whole-file fidelity.
 */

const PACKAGE = "postgres@3.4.9";
const PATCH_PATH = "patches/postgres@3.4.9.patch";
const LOCKFILE_PATH = "pnpm-lock.yaml";
const INSTALLED_ROOT = "node_modules/postgres";

interface PatchHunk {
  /** 1-based ordinal within the hunk's file. */
  index: number;
  /** The `@@ -a,b +c,d @@` line, quoted verbatim in failure messages. */
  header: string;
  /** Line the hunk's post-image starts on in the patched file, 1-based. */
  newStart: number;
  /** The hunk's post-image: context and added lines, in order, prefixes stripped. */
  postImage: string[];
  /** The lines the hunk adds, for naming the change in a failure message. */
  added: string[];
}

interface PatchFile {
  /** Path relative to the package root, as the diff header's b/ side names it. */
  path: string;
  hunks: PatchHunk[];
}

/**
 * Parse a unified diff into per-file hunk post-images. Hunk bodies are
 * consumed by the line counts their own header declares, so trailing text
 * after the last hunk (and a patch that is not a diff at all) cannot be
 * misread as hunk content.
 */
function parsePatch(patch: string): PatchFile[] {
  const lines = patch.split("\n");
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fileHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (fileHeader) {
      current = { path: fileHeader[2]!, hunks: [] };
      files.push(current);
      continue;
    }

    const hunkHeader = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunkHeader || !current) continue;

    const [, oldCountRaw, newStartRaw, newCountRaw] = hunkHeader;
    const oldCount = oldCountRaw === undefined ? 1 : Number(oldCountRaw);
    const newStart = Number(newStartRaw);
    const newCount = newCountRaw === undefined ? 1 : Number(newCountRaw);
    const postImage: string[] = [];
    const added: string[] = [];
    let oldLeft = oldCount;
    let newLeft = newCount;

    while (oldLeft > 0 || newLeft > 0) {
      const body = lines[++i];
      if (body === undefined) {
        throw new Error(
          `${PATCH_PATH} ends inside the hunk headed "${line}" — not a whole unified diff`,
        );
      }

      if (body.startsWith("\\")) {
        continue; // "\ No newline at end of file": consumes nothing
      }

      if (body === "" || body.startsWith(" ")) {
        postImage.push(body === "" ? "" : body.slice(1));
        oldLeft--;
        newLeft--;
        continue;
      }

      if (body.startsWith("+")) {
        postImage.push(body.slice(1));
        added.push(body.slice(1));
        newLeft--;
        continue;
      }

      if (body.startsWith("-")) {
        oldLeft--;
        continue;
      }

      throw new Error(
        `${PATCH_PATH}: unparseable line inside the hunk headed "${line}": ${JSON.stringify(body)}`,
      );
    }

    current.hunks.push({
      index: current.hunks.length + 1,
      header: line,
      newStart,
      postImage,
      added,
    });
  }

  return files;
}

/** The `hash:`/`path:` pnpm pins for this package, read straight off the YAML. */
function patchedDependenciesEntry(lock: string): { hash: string; path: string } {
  const lines = lock.split("\n");
  const section = lines.indexOf("patchedDependencies:");
  if (section === -1) {
    throw new Error(`${LOCKFILE_PATH} declares no patchedDependencies section`);
  }

  for (let i = section + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0 && !/^\s/.test(line)) break; // next top-level key: section ended

    if (!/^ {2}postgres@3\.4\.9:$/.test(line)) continue;

    let hash: string | undefined;
    let path: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const field = lines[j]!;
      if (field.length > 0 && !/^ {4}/.test(field)) break;
      hash = /^ {4}hash: (\S+)$/.exec(field)?.[1] ?? hash;
      path = /^ {4}path: (\S+)$/.exec(field)?.[1] ?? path;
    }

    if (!hash || !path) {
      throw new Error(
        `${LOCKFILE_PATH}'s patchedDependencies entry for ${PACKAGE} is missing its hash:/path: pair`,
      );
    }

    return { hash, path };
  }

  throw new Error(`${LOCKFILE_PATH}'s patchedDependencies section names no ${PACKAGE} entry`);
}

/** First index at which `needle` appears in `haystack` as a contiguous block, or -1. */
function findBlock(haystack: readonly string[], needle: readonly string[]): number {
  const last = haystack.length - needle.length;

  for (let start = 0; start <= last; start++) {
    let matched = true;

    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }

    if (matched) return start;
  }

  return -1;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readInstalledLines(relativePath: string): string[] {
  let lines: string[] | undefined;
  const absolute = resolve(INSTALLED_ROOT, relativePath);

  try {
    lines = readFileSync(absolute, "utf8").split("\n");
  } catch (error) {
    throw new Error(
      `installed ${INSTALLED_ROOT}/${relativePath} is unreadable (${(error as Error).message}) — ` +
        "run pnpm install --frozen-lockfile to restore the patched build",
    );
  }

  return lines;
}

describe("postgres@3.4.9 patch guard", () => {
  describe("committed pair", () => {
    it("patch file is byte-identical to the hash pnpm-lock.yaml pins", () => {
      const entry = patchedDependenciesEntry(readFileSync(resolve(LOCKFILE_PATH), "utf8"));

      expect(
        entry.path,
        `${LOCKFILE_PATH} pins the patch at ${entry.path}, but this guard hashes ${PATCH_PATH}`,
      ).toBe(PATCH_PATH);

      const digest = sha256Hex(readFileSync(resolve(PATCH_PATH)));
      expect(
        digest,
        `sha256(${PATCH_PATH}) is ${digest}, but ${LOCKFILE_PATH} pins ${entry.hash} under ` +
          "patchedDependencies — the patch was edited without regenerating pnpm-lock.yaml " +
          "(or the lockfile was regenerated without the patch); redo whichever half moved",
      ).toBe(entry.hash);
    });
  });

  describe("resolved build", () => {
    it("node_modules/postgres resolves to the patched build pnpm-lock.yaml names", () => {
      const { hash } = patchedDependenciesEntry(readFileSync(resolve(LOCKFILE_PATH), "utf8"));

      let resolved: string;
      try {
        resolved = realpathSync(resolve(INSTALLED_ROOT));
      } catch (error) {
        throw new Error(
          `node_modules/postgres is not installed (${(error as Error).message}) — ` +
            "run pnpm install --frozen-lockfile",
        );
      }

      expect(
        resolved,
        `node_modules/postgres resolves to ${resolved}, which carries no _patch_hash=${hash} — ` +
          "unpatched or wrong-build postgres resolved (a _patch_hash suffix alone proves a patch, " +
          "not this one); run pnpm install --frozen-lockfile",
      ).toContain(`_patch_hash=${hash}`);
    });
  });

  describe("installed surface", () => {
    const files = parsePatch(readFileSync(resolve(PATCH_PATH), "utf8"));

    it("patch names at least one file to check", () => {
      expect(files.length, `${PATCH_PATH} parsed to no file headers`).toBeGreaterThan(0);
    });

    for (const file of files) {
      describe(file.path, () => {
        file.hunks.forEach((hunk) => {
          it(`hunk ${hunk.index} (${hunk.header}) is present in the installed file`, () => {
            const installed = readInstalledLines(file.path);
            const found = findBlock(installed, hunk.postImage);
            const change = hunk.added.length > 0 ? hunk.added[0]! : hunk.postImage[0]!;

            expect(
              found,
              `${file.path} hunk ${hunk.index} (${hunk.header}) post-image is absent from ` +
                `installed ${INSTALLED_ROOT}/${file.path} — expected around installed line ` +
                `${hunk.newStart}; the patch's change starts "${change.trim()}". The installed ` +
                "postgres does not match patches/postgres@3.4.9.patch (drifted or stale " +
                "node_modules — the db suites still pass against it); run pnpm install --frozen-lockfile",
            ).toBeGreaterThanOrEqual(0);
          });
        });
      });
    }
  });

  describe("cjs load guard", () => {
    it("require('postgres') fails loudly instead of silently loading the unpatched CJS build", () => {
      const probe = spawnSync(process.execPath, ["-e", "require('postgres')"], {
        cwd: process.cwd(), // the tree root, so the probe resolves this tree's node_modules
        encoding: "utf8",
      });

      const output = (probe.stdout ?? "") + (probe.stderr ?? "");

      expect(
        probe.status,
        `node -e "require('postgres')" exited ${probe.status} with output ` +
          `${JSON.stringify(output.trim())} — the stock CJS build loaded silently, so any ` +
          "CommonJS consumer would run the unpatched client; patches/postgres@3.4.9.patch " +
          "must make cjs/src/index.js throw at load (pnpm patch postgres@3.4.9, then " +
          "pnpm patch-commit)",
      ).not.toBe(0);

      expect(
        output,
        `the CJS load failed as required (exit ${probe.status}) but its output does not name ` +
          "the guard — a consumer would see an error it cannot act on; the throw in " +
          "cjs/src/index.js must state the constraint and the fix",
      ).toContain("prebuilt CJS build is removed");
    });
  });
});
