import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { legalRevisionViolations } from "../../scripts/check-legal-revisions";
import * as legalRevisions from "../../src/lib/legal-revisions";

const TERMS = "src/app/terms/page.tsx";
const RULES = "src/app/rules/page.tsx";
const ACCOUNT_DATA = "src/app/account-data/page.tsx";
const GUARD = "src/lib/legal-revisions.ts";
const GATE_SCRIPT = "scripts/check-legal-revisions.ts";

/**
 * Reads LEGAL_PAGES out of the gate script's source. The array is
 * module-private — the script exports only the violation walker — and this
 * pin must not widen the script's export surface just to be readable, so the
 * test parses the literal instead. A parse that comes back empty fails the
 * length guard in the test loudly rather than passing vacuously.
 */
async function gateLegalPages(): Promise<string[]> {
  const source = await readFile(resolve(GATE_SCRIPT), "utf8");
  const block = source.match(/const LEGAL_PAGES[^=]*=\s*\[([\s\S]*?)\]/);
  if (block === null) {
    throw new Error(`could not read LEGAL_PAGES out of ${GATE_SCRIPT}`);
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

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

  it("exits 1 over a violating range, naming the sha and the revision-record line", async () => {
    // The CLI resolves the repository it walks from its own location, so the
    // fixture is a throwaway git repository carrying a copy of the script: the
    // copy makes that repository the one under test while this checkout's
    // history and working tree stay untouched. The commits are real throwaway
    // commits and the whole fixture is removed again below.
    const fixture = await mkdtemp(join(tmpdir(), "legal-revisions-"));
    try {
      await mkdir(join(fixture, "scripts"), { recursive: true });
      await copyFile(
        resolve("scripts/check-legal-revisions.ts"),
        join(fixture, "scripts/check-legal-revisions.ts"),
      );

      const git = (...args: string[]): string => {
        const run = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
        if (run.error !== undefined || run.status !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
        }
        return run.stdout;
      };

      git("init", "--quiet");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "Legal Revision Fixture");
      git("config", "commit.gpgsign", "false");

      await writeFile(join(fixture, "README.md"), "fixture base\n");
      git("add", "README.md");
      git("commit", "--quiet", "-m", "base");
      const baseSha = git("rev-parse", "HEAD").trim();

      await mkdir(join(fixture, "src/app/terms"), { recursive: true });
      await writeFile(
        join(fixture, "src/app/terms/page.tsx"),
        "export default () => null;\n",
      );
      git("add", "src/app/terms/page.tsx");
      git("commit", "--quiet", "-m", "page without the revision record");
      const headSha = git("rev-parse", "HEAD").trim();

      const result = spawnSync(
        process.execPath,
        [resolve(fixture, "scripts/check-legal-revisions.ts"), baseSha, headSha],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(headSha);
      expect(result.stdout).toContain("src/lib/legal-revisions.ts");
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("exits 0 over a one-commit range and names the count and range correctly", async () => {
    // Same fixture shape as the violating-range leg above: the CLI resolves the
    // repository it walks from its own location, so the fixture is a throwaway
    // git repository carrying a byte-identical copy of the script. This leg
    // covers the success path through the real binary — a legal page and its
    // revision record landing in the SAME commit — and pins the success
    // message's count and range wording for the one-commit case.
    const fixture = await mkdtemp(join(tmpdir(), "legal-revisions-"));
    try {
      await mkdir(join(fixture, "scripts"), { recursive: true });
      await copyFile(
        resolve("scripts/check-legal-revisions.ts"),
        join(fixture, "scripts/check-legal-revisions.ts"),
      );

      const git = (...args: string[]): string => {
        const run = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
        if (run.error !== undefined || run.status !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
        }
        return run.stdout;
      };

      git("init", "--quiet");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "Legal Revision Fixture");
      git("config", "commit.gpgsign", "false");

      await writeFile(join(fixture, "README.md"), "fixture base\n");
      git("add", "README.md");
      git("commit", "--quiet", "-m", "base");
      const baseSha = git("rev-parse", "HEAD").trim();

      await mkdir(join(fixture, "src/app/terms"), { recursive: true });
      await mkdir(join(fixture, "src/lib"), { recursive: true });
      await writeFile(
        join(fixture, "src/app/terms/page.tsx"),
        "export default () => null;\n",
      );
      await writeFile(
        join(fixture, "src/lib/legal-revisions.ts"),
        "export const LEGAL_REVISIONS = 1;\n",
      );
      git("add", "src/app/terms/page.tsx", "src/lib/legal-revisions.ts");
      git("commit", "--quiet", "-m", "terms page with its revision record");
      const headSha = git("rev-parse", "HEAD").trim();

      const result = spawnSync(
        process.execPath,
        [resolve(fixture, "scripts/check-legal-revisions.ts"), baseSha, headSha],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("1 commit in");
      expect(result.stdout, "the count must not be pluralized for one commit").not.toContain(
        "1 commits",
      );
      expect(result.stdout).toContain(`${baseSha}..${headSha}`);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it("exits 0 over an empty range and says so", async () => {
    // base == head: rev-list over the range lists nothing, so this leg pins
    // the success path's zero-commit shape — exit 0, the pluralized "0
    // commits" count, and the range echoed exactly as passed.
    const fixture = await mkdtemp(join(tmpdir(), "legal-revisions-"));
    try {
      await mkdir(join(fixture, "scripts"), { recursive: true });
      await copyFile(
        resolve("scripts/check-legal-revisions.ts"),
        join(fixture, "scripts/check-legal-revisions.ts"),
      );

      const git = (...args: string[]): string => {
        const run = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
        if (run.error !== undefined || run.status !== 0) {
          throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
        }
        return run.stdout;
      };

      git("init", "--quiet");
      git("config", "user.email", "fixture@example.invalid");
      git("config", "user.name", "Legal Revision Fixture");
      git("config", "commit.gpgsign", "false");

      await writeFile(join(fixture, "README.md"), "fixture base\n");
      git("add", "README.md");
      git("commit", "--quiet", "-m", "base");
      const baseSha = git("rev-parse", "HEAD").trim();

      const result = spawnSync(
        process.execPath,
        [resolve(fixture, "scripts/check-legal-revisions.ts"), baseSha, baseSha],
        { cwd: process.cwd(), encoding: "utf8" },
      );

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`0 commits in ${baseSha}..${baseSha}`);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

/**
 * The gate is only as complete as the span between its page list and the
 * record module's exports: a fourth legal document added as a new page plus a
 * new *_REVISION export, without a LEGAL_PAGES entry, would ship silently
 * ungated — the gate would walk three pages and never look at the fourth.
 * This pin closes that direction: every record the module exports must name a
 * document whose page exists and is one the gate walks.
 *
 * The module side is imported, not parsed: the exports are typed values, so
 * the language enumerates them and a rename or reformat cannot rot the pin.
 * The script side is parsed from source because LEGAL_PAGES is module-private
 * and widening the script's export surface just to be readable is a
 * production change this pin does not get to make; an unparsable or empty
 * list fails the length guard below loudly instead of passing vacuously.
 */
describe("the gate's coverage of the revision record module", () => {
  it("walks a page for every document the record module stamps", async () => {
    const legalPages = await gateLegalPages();
    expect(
      legalPages.length,
      "LEGAL_PAGES must parse out of scripts/check-legal-revisions.ts — an unparsable " +
        "or empty list would make this pin vacuous",
    ).toBeGreaterThan(0);

    const records = Object.entries(legalRevisions).filter(([name]) =>
      name.endsWith("_REVISION"),
    );
    expect(
      records.length,
      "the record module must export at least one *_REVISION record — an empty module " +
        "would make this pin vacuous",
    ).toBeGreaterThan(0);

    for (const [name, record] of records) {
      const page = `src/app/${record.document}/page.tsx`;

      await expect(
        access(resolve(page)),
        `${name} stamps document "${record.document}", but no page renders at ` +
          `${page} — the record cites a document the site does not serve`,
      ).resolves.toBeUndefined();

      expect(
        legalPages,
        `${page} renders a document the record module stamps, but it is missing from ` +
          `LEGAL_PAGES — edits to its text would ship without a revision-record bump`,
      ).toContain(page);
    }
  });
});
