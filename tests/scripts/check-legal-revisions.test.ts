import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { legalRevisionViolations } from "../../scripts/check-legal-revisions";

const TERMS = "src/app/terms/page.tsx";
const RULES = "src/app/rules/page.tsx";
const ACCOUNT_DATA = "src/app/account-data/page.tsx";
const GUARD = "src/lib/legal-revisions.ts";

describe("legal revision gate", () => {
  it("names a commit that changes a legal page without the guard file", () => {
    const violations = legalRevisionViolations([
      { sha: "sha-page-only", files: [TERMS, "src/lib/unrelated.ts"] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("sha-page-only");
    expect(violations[0]).toContain(TERMS);
  });

  it("accepts a commit that changes a legal page and the guard file together", () => {
    expect(
      legalRevisionViolations([{ sha: "sha-both", files: [TERMS, GUARD] }]),
    ).toEqual([]);
  });

  it("accepts a commit that touches only the guard file", () => {
    expect(legalRevisionViolations([{ sha: "sha-guard", files: [GUARD] }])).toEqual(
      [],
    );
  });

  it("accepts a commit that touches neither a legal page nor the guard file", () => {
    expect(
      legalRevisionViolations([{ sha: "sha-neither", files: ["src/lib/unrelated.ts"] }]),
    ).toEqual([]);
  });

  it("names only the offending commits in a mixed range", () => {
    const violations = legalRevisionViolations([
      { sha: "sha-clean", files: ["src/lib/unrelated.ts"] },
      { sha: "sha-offending", files: [RULES] },
      { sha: "sha-also-clean", files: [GUARD, "src/lib/unrelated.ts"] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("sha-offending");
    expect(violations[0]).not.toContain("sha-clean");
    expect(violations[0]).not.toContain("sha-also-clean");
  });

  it("accepts an empty range", () => {
    expect(legalRevisionViolations([])).toEqual([]);
  });

  it("does not let a neighbouring commit's guard bump excuse the page commit", () => {
    const violations = legalRevisionViolations([
      { sha: "sha-page-first", files: [ACCOUNT_DATA] },
      { sha: "sha-guard-after", files: [GUARD] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("sha-page-first");
  });

  it("reports one violation per legal page touched by an offending commit", () => {
    const violations = legalRevisionViolations([
      { sha: "sha-two-pages", files: [TERMS, RULES] },
    ]);

    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes(TERMS))).toBe(true);
    expect(violations.some((v) => v.includes(RULES))).toBe(true);
  });

  it("counts a rename as touching the legal page", () => {
    const renamedTo = "src/app/legal/terms/page.tsx";
    const violations = legalRevisionViolations([
      { sha: "sha-rename", files: [TERMS, renamedTo] },
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(TERMS);
  });

  it("fails closed when the CLI cannot resolve the base revision", () => {
    const missingRevision = "__task1_missing_base_revision__";
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/check-legal-revisions.ts"), missingRevision, "HEAD"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Could not list commits in ${missingRevision}..HEAD`);
  });
});
