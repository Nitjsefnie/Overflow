import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const planningArtifacts = [
  "docs/superpowers/plans/2026-09-04-overflow-mvp.md",
  "docs/superpowers/plans/2026-09-09-issue-330-recalibration-credit-adjustment.md",
  "docs/superpowers/specs/2026-09-04-overflow-mvp-design.html",
  "docs/superpowers/specs/2026-09-04-overflow-mvp-design.md",
];

// Every docs/ probe must be ignored by the deny-by-default `*` on line 1 of
// .gitignore and by nothing else: a docs-specific rule of either sign, at any
// depth, changes the attributed source even when it is inert (a `!docs/`
// re-include that the next `docs/*` line re-excludes leaves every path ignored
// and `git ls-files docs/` empty, so only the attribution catches it).
const docsProbes = [
  "docs/probe.md",
  "docs/probe.html",
  "docs/reviews/probe.html",
  "docs/reviews/nested/probe.html",
  "docs/anything/deep/probe.md",
];

const forgeEvidenceContract = [
  "docs/forge-evidence-contract.md",
  "docs/forge-evidence-contract.html",
];

describe("docs/superpowers planning artifacts are untracked", () => {
  it("no longer ships the four removed planning artifacts", () => {
    for (const pathname of planningArtifacts) {
      expect(existsSync(resolve(pathname)), pathname).toBe(false);
    }
  });

  it("ignores future docs/superpowers plan and spec paths", () => {
    expect(checkIgnore("docs/superpowers/plans/probe.md")).toBe(0);
    expect(checkIgnore("docs/superpowers/specs/probe.md")).toBe(0);
    expect(checkIgnore("docs/superpowers/specs/probe.html")).toBe(0);
  });
});

describe("docs/ is denied as a prefix with no exemption beneath it", () => {
  it("ignores every docs/** probe by the line-1 `*` deny and no docs-specific rule", () => {
    for (const pathname of docsProbes) {
      expect(checkIgnoreVerbose(pathname), pathname).toStrictEqual({
        status: 0,
        attribution: `.gitignore:1:*\t${pathname}`,
      });
    }
  });

  it("tracks nothing under docs/", () => {
    const tracked = spawnSync("git", ["ls-files", "-z", "docs/"], {
      cwd: resolve("."),
      encoding: "utf8",
    });
    expect(tracked.status).toBe(0);
    expect(tracked.stdout.split("\0").filter(Boolean)).toStrictEqual([]);
  });
});

describe("docs/forge-evidence-contract is untracked", () => {
  it("no longer ships the re-added forge-evidence contract", () => {
    for (const pathname of forgeEvidenceContract) {
      expect(existsSync(resolve(pathname)), pathname).toBe(false);
    }
    for (const pathname of forgeEvidenceContract) {
      expect(checkIgnore(pathname), pathname).toBe(0);
    }
  });
});

function checkIgnoreVerbose(pathname: string): {
  status: number | null;
  attribution: string;
} {
  const result = spawnSync("git", ["check-ignore", "--verbose", "--no-index", pathname], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  return { status: result.status, attribution: result.stdout.trimEnd() };
}

function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
  }).status;
}
