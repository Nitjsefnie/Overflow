import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { commitFiles, git, isShallowCheckout, scratchGitEnv, showFileLines } from "../support/scratch-git";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "gitleaks-redirect-")]);

/** The fingerprints .gitleaksignore lists, comments and blank lines dropped. */
const ENTRIES = readFileSync(resolve(".gitleaksignore"), "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"));

const FINGERPRINT = /^(?:([0-9a-f]{40}):)?(.+):([a-z0-9-]+):([1-9][0-9]*)$/;

describe(".gitleaksignore", () => {
  it("lists findings, each as a fingerprint gitleaks emits, with or without its commit", () => {
    expect(ENTRIES.length, "an empty ignore list is a deleted file, not an empty one").toBeGreaterThan(0);
    for (const entry of ENTRIES) expect(entry, entry).toMatch(FINGERPRINT);
  });

  it("has no two entries sharing a fingerprint", () => {
    expect(new Set(ENTRIES).size, "duplicate fingerprints in .gitleaksignore").toBe(ENTRIES.length);
  });

  it("lists only findings under tests/, which is where this repository's fixtures live", () => {
    for (const entry of ENTRIES) expect(FINGERPRINT.exec(entry)?.[2] ?? "", entry).toMatch(/^tests\//);
  });

  it.skipIf(isShallowCheckout())("names a line that exists in the file at its commit, or at HEAD", () => {
    for (const entry of ENTRIES) {
      const [, commit, file, , line] = FINGERPRINT.exec(entry) ?? [];
      const lines = showFileLines(commit ?? "HEAD", file);
      expect(lines.length, `${entry} names line ${line}, past the end of ${file} at ${commit ?? "HEAD"}`).toBeGreaterThanOrEqual(Number(line));
    }
  });
});

describe("the git reads that decide whether the deep check runs", () => {
  let elsewhere = "";

  beforeAll(async () => {
    elsewhere = await tempDirectories.createAsync(join(tmpdir(), "gitleaks-redirect-"));
    const repo = join(elsewhere, "shallow");
    await mkdir(repo, { recursive: true });
    // A real repository with real commits, so `rev-parse --is-shallow-repository`
    // can only answer `true` about it if git is really being pointed there.
    git(repo, "init", "--quiet", "--initial-branch=main");
    await commitFiles(repo, { "README.md": "# somewhere else\n" }, "root");
    // Make it genuinely shallow, so the redirect is detectable rather than a
    // no-op: a full repository would answer `false` to the same query.
    const marker = join(repo, ".git", "shallow");
    await writeFile(marker, `${git(repo, "rev-parse", "HEAD")}\n`, "utf8");
  });

  afterAll(async () => {
    if (elsewhere) await tempDirectories.disposeAsync(elsewhere);
  });

  const REDIRECTORS = [
    { variable: "GIT_DIR", value: () => join(elsewhere, "shallow", ".git"), redirects: true },
    { variable: "GIT_COMMON_DIR", value: () => join(elsewhere, "shallow", ".git"), redirects: true },
    { variable: "GIT_WORK_TREE", value: () => join(elsewhere, "shallow"), redirects: false },
    {
      variable: "GIT_OBJECT_DIRECTORY",
      value: () => join(elsewhere, "shallow", ".git", "objects"),
      redirects: false,
    },
    {
      variable: "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      value: () => join(elsewhere, "shallow", ".git", "objects"),
      redirects: false,
    },
    { variable: "GIT_INDEX_FILE", value: () => join(elsewhere, "shallow", ".git", "index"), redirects: false },
    { variable: "GIT_NAMESPACE", value: () => "some-namespace", redirects: false },
  ] as const;

  it.skipIf(isShallowCheckout())("reports the ambient depth, not one redirected by a GIT variable", async () => {
    const ambient = isShallowCheckout();
    expect(ambient, "this case only has teeth when the ambient checkout is full depth").toBe(false);
    let biting = 0;

    for (const { variable, value, redirects } of REDIRECTORS) {
      const saved = process.env[variable];
      process.env[variable] = value();
      try {
        const unshielded = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
          encoding: "utf8",
          env: process.env,
        }).stdout.trim();

        if (redirects) {
          expect(unshielded, `${variable} must genuinely redirect, or this case proves nothing`).toBe("true");
          expect(
            unshielded,
            `${variable} must produce a DIFFERENT depth answer from the ambient checkout, or the ` +
              "shielded assertion below is true-to-true and this case certifies nothing",
          ).not.toBe(String(ambient));
          biting += 1;
        }

        vi.resetModules();
        const shielded = await import("../support/scratch-git");
        expect(
          shielded.isShallowCheckout(),
          `with ${variable} pointed elsewhere, the shielded read must still answer about the checkout ` +
            "this test is running in. Answering 'shallow' here skips the deep provenance check on a " +
            "full-depth repository, on a green run.",
        ).toBe(ambient);
      } finally {
        if (saved === undefined) delete process.env[variable];
        else process.env[variable] = saved;
      }
    }
    expect(
      biting,
      "no redirector case could have failed here, so this test certifies nothing in this checkout",
    ).toBeGreaterThan(0);
  });

  it("reports the ambient commits, not one redirected by a GIT variable", async () => {
    const ambientHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: scratchGitEnv })
      .stdout.trim();
    expect(ambientHead, "the ambient checkout must have a HEAD to look for").toMatch(/^[0-9a-f]{40}$/);

    let biting = 0;
    for (const { variable, value, redirects } of REDIRECTORS) {
      const saved = process.env[variable];
      process.env[variable] = value();
      try {
        const unshielded = spawnSync("git", ["cat-file", "-e", `${ambientHead}^{commit}`], {
          encoding: "utf8",
          env: process.env,
        }).status === 0;
        if (redirects) {
          expect(
            unshielded,
            `${variable} must make an unshielded read lose this checkout's HEAD, or the assertion ` +
              "below is true-to-true and this case certifies nothing",
          ).toBe(false);
          biting += 1;
        }

        vi.resetModules();
        const shielded = await import("../support/scratch-git");
        expect(
          shielded.hasCommit(ambientHead),
          `with ${variable} redirected, hasCommit must still find the ambient checkout's own HEAD`,
        ).toBe(true);
      } finally {
        if (saved === undefined) delete process.env[variable];
        else process.env[variable] = saved;
      }
    }
    expect(biting, "at least one redirector case must have run").toBeGreaterThan(0);
  });
});
