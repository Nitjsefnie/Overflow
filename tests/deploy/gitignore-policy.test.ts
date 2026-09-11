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

  it("keeps the docs/reviews audit reachable by the ignore policy", () => {
    expect(checkIgnore("docs/reviews/2026-09-05-full-application-audit.html")).toBe(1);
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

  it("ignores probe paths directly under docs/", () => {
    expect(checkIgnore("docs/probe.md")).toBe(0);
    expect(checkIgnore("docs/probe.html")).toBe(0);
  });
});

function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
  }).status;
}
