import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

/**
 * The installed vitest (5.0.0) defaults `expect.poll` to timeout=1000ms,
 * interval=50ms — see `timeout = 1e3` at line 910 of the installed bundle's
 * chunks/index.OVGXnVRj.js. A default-budget poll cannot outlast one second of
 * load: tests/fold/reconciliation-write-fencing.test.ts failed exactly this way
 * under a full-suite run — four poll sites watching a postgres lock wait
 * appeared empty because the fence path needed longer than the silent default
 * to reach its first blocked statement (issue 286).
 *
 * This guard is a tree-wide scan, not a lint rule: every `expect.poll(` call
 * under tests/ must carry an explicit `timeout:` in its trailing options
 * object, so no future poll can land silently on the 1-second default. The
 * scan is textual and deliberately conservative — an options argument built by
 * a helper call cannot prove it carries a timeout, so it is flagged; inline
 * the object instead. The marker is matched verbatim: an aliased or
 * whitespace-split spelling evades the scan, and none exists.
 */
const MARKER = "expect.poll" + "(";

interface Scan {
  /** One entry per call missing an explicit timeout, named by line. */
  violations: string[];
  /** Occurrences of the marker across the scanned tree. */
  siteCount: number;
  /** Scanned files that actually contain the marker. */
  filesWithSites: string[];
}

function scanSource(source: string): { violations: string[]; siteCount: number } {
  const violations: string[] = [];
  let siteCount = 0;

  let markerAt = source.indexOf(MARKER);
  while (markerAt !== -1) {
    siteCount++;
    const openParen = markerAt + MARKER.length - 1;
    const closeParen = matchingParen(source, openParen);
    if (closeParen === -1) {
      violations.push(
        `${describePosition(source, markerAt)} — call never closes; the guard could not parse it. ` +
          "Add the explicit timeout and simplify the call so the scan can read it.",
      );
      markerAt = source.indexOf(MARKER, markerAt + MARKER.length);
      continue;
    }

    const argsText = source.slice(openParen + 1, closeParen);
    const args = splitTopLevelArgs(argsText);
    if (args.length < 2) {
      violations.push(
        `${describePosition(source, markerAt)} — no options argument; ` +
          `poll runs on vitest's silent 1000ms default. Pass { timeout: … } explicitly.`,
      );
    } else {
      const options = args[args.length - 1].trim();
      if (!/(^|[{,\s(])timeout\s*:/.test(options)) {
        violations.push(
          `${describePosition(source, markerAt)} — options ${options} carries no explicit timeout; ` +
            `poll runs on vitest's silent 1000ms default. Pass { timeout: … } explicitly.`,
        );
      }
    }
    markerAt = source.indexOf(MARKER, closeParen + 1);
  }

  return { violations, siteCount };
}

function describePosition(source: string, at: number): string {
  return `line ${source.slice(0, at).split("\n").length}`;
}

/**
 * Index of the paren closing the one at `open`, skipping string and template
 * literals (including ${…} interpolation), line and block comments. Returns -1
 * when the call never closes: the guard refuses to stay silent about source it
 * cannot parse.
 */
function matchingParen(source: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function splitTopLevelArgs(argsText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < argsText.length) {
    const ch = argsText[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(argsText, i);
      continue;
    }
    if (ch === "/" && argsText[i + 1] === "/") {
      const newline = argsText.indexOf("\n", i);
      i = newline === -1 ? argsText.length : newline + 1;
      continue;
    }
    if (ch === "/" && argsText[i + 1] === "*") {
      const end = argsText.indexOf("*/", i + 2);
      i = end === -1 ? argsText.length : end + 2;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === "," && depth === 0) {
      parts.push(argsText.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(argsText.slice(start));
  return parts;
}

/** Index just past the string opening at `start`, honoring escapes and ${…}. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      i = skipBraces(source, i + 2);
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return source.length;
}

function skipBraces(source: string, sourceStart: number): number {
  let depth = 1;
  let i = sourceStart;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      i = skipString(source, i);
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;
  }
  return i;
}

function scanTestsTree(): Scan {
  const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const violations: string[] = [];
  let siteCount = 0;
  const filesWithSites: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts")) {
        // This guard's own fixtures quote the call shape inside string
        // literals; the scan reads raw source and would flag its own file.
        if (full === path.join(testsDir, "support", "expect-poll-budget.test.ts")) continue;
        const { violations: fileViolations, siteCount: fileSites } = scanSource(readFileSync(full, "utf8"));
        const relative = path.relative(testsDir, full);
        violations.push(...fileViolations.map((entry) => entry.replace(/^line (\d+)/, `${relative}:$1`)));
        siteCount += fileSites;
        if (fileSites > 0) filesWithSites.push(relative);
      }
    }
  };
  walk(testsDir);

  return { violations, siteCount, filesWithSites };
}

describe("every expect.poll under tests/ carries an explicit timeout", () => {
  it("flags a bare single-argument poll", () => {
    expect(scanSource(`await expect.poll(() => pids()).toContain(3);`)).toEqual({
      violations: [
        "line 1 — no options argument; poll runs on vitest's silent 1000ms default. Pass { timeout: … } explicitly.",
      ],
      siteCount: 1,
    });
  });

  it("flags a poll whose options carry an interval but no timeout", () => {
    const result = scanSource(`await expect.poll(fn, { interval: 50 }).toBe(true);`);

    expect(result.siteCount).toBe(1);
    expect(result.violations[0]).toMatch(/carries no explicit timeout/);
    expect(result.violations[0]).toMatch(/interval: 50/);
  });

  it("passes a poll whose options name a timeout", () => {
    expect(
      scanSource(`await expect.poll(fn, { timeout: 1000 }).toBe(true);`).violations,
    ).toEqual([]);
    expect(
      scanSource(`await expect.poll(fn, { timeout: 60_000, interval: 50 }).toSatisfy(Boolean);`).violations,
    ).toEqual([]);
  });

  it("tracks nesting so an inner call does not close the poll's argument list", () => {
    const result = scanSource(`await expect.poll(() => outer(inner("a,b(c"))).toBe(1);`);

    expect(result.siteCount).toBe(1);
    // Single argument despite the comma and paren inside the string literal.
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/no options argument/);
  });

  it("reads a multi-line call and names the line the marker sits on", () => {
    const result = scanSource(
      [
        "const a = 1;",
        "const b = 2;",
        "",
        "await expect.poll(() => {",
        "  return counters.shift();",
        "}).toBe(2);",
      ].join("\n"),
    );

    expect(result.violations).toEqual([
      "line 4 — no options argument; poll runs on vitest's silent 1000ms default. Pass { timeout: … } explicitly.",
    ]);
  });

  it("skips nothing else on the way past a site it already judged", () => {
    const result = scanSource(
      [
        "await expect.poll(a, { timeout: 5 }).toBe(1);",
        "const middle = 2;",
        "await expect.poll(b, { interval: 5 }).toBe(2);",
      ].join("\n"),
    );

    expect(result.siteCount).toBe(2);
    expect(result.violations).toEqual([
      expect.stringMatching(/line 3.*carries no explicit timeout/),
    ]);
  });

  it("refuses to stay silent when a call never closes", () => {
    const result = scanSource(`await expect.poll(() => never(`);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatch(/never closes/);
  });

  it("finds every poll site in the tree and leaves none unprotected", () => {
    const { violations, siteCount, filesWithSites } = scanTestsTree();

    // The violation list is the load-bearing output: it names every
    // unprotected site. Assert it first so a failure lists them all.
    expect(violations).toEqual([]);

    // A floor, not an inventory: lower it consciously if sites are removed.
    // Six today — four in tests/fold/reconciliation-write-fencing.test.ts and
    // one each in the two github deadline suites.
    expect(siteCount).toBeGreaterThanOrEqual(6);
    expect(filesWithSites).toContain("fold/reconciliation-write-fencing.test.ts");
    expect(filesWithSites).toContain("github/workflow-deadline.test.ts");
    expect(filesWithSites).toContain("github/request-deadline.test.ts");
  });
});
