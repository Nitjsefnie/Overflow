import { describe, expect, it } from "vitest";
import { SHARED_POSTGRES_MARKER, runNeedsSharedPostgres } from "./shared-postgres-need";

describe("runNeedsSharedPostgres", () => {
  it("pins the marker to the helper import that is the dependency edge", () => {
    expect(SHARED_POSTGRES_MARKER).toBe("startPostgresContainer");
  });

  it("returns true when a file contains the marker", () => {
    const sources = new Map([
      ["tests/db/some-suite.test.ts", `import { startPostgresContainer } from "../support/postgres-container";\n`],
    ]);
    expect(runNeedsSharedPostgres([...sources.keys()], (path) => sources.get(path)!)).toBe(true);
  });

  it("returns false when no file contains the marker", () => {
    const sources = new Map([
      ["tests/github/plain.test.ts", `import { expect } from "vitest";\n`],
      ["tests/lib/other.test.ts", `describe("unit", () => {});\n`],
    ]);
    expect(runNeedsSharedPostgres([...sources.keys()], (path) => sources.get(path)!)).toBe(false);
  });

  it("returns true on a match after an unreadable file", () => {
    const sources = new Map<string, string>([
      ["tests/db/gone.test.ts", undefined as unknown as string],
      ["tests/db/real.test.ts", `const start = startPostgresContainer;\n`],
    ]);
    const warnings: string[] = [];
    expect(
      runNeedsSharedPostgres([...sources.keys()], (path) => {
        const contents = sources.get(path);
        if (contents === undefined) throw new Error("ENOENT: no such file");
        return contents;
      }, (message) => warnings.push(message)),
    ).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tests/db/gone.test.ts");
  });

  it("returns false when its only file is unreadable, and warns once", () => {
    const warnings: string[] = [];
    expect(
      runNeedsSharedPostgres(["tests/db/gone.test.ts"], () => {
        throw new Error("ENOENT: no such file");
      }, (message) => warnings.push(message)),
    ).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tests/db/gone.test.ts");
  });

  it("does not throw on the default stderr warning path", () => {
    expect(runNeedsSharedPostgres(["tests/db/gone.test.ts"], () => {
      throw new Error("ENOENT: no such file");
    })).toBe(false);
  });

  it("matches the marker as a substring of any content, including a comment", () => {
    // A mention without the import is a false positive on the safe side: it
    // starts a container a run does not need, never skips one it does (the
    // guard file scanning call sites is such a file).
    const sources = new Map([
      ["tests/db/call-site-guard.test.ts", `// startPostgresContainer takes no name option.\n`],
    ]);
    expect(runNeedsSharedPostgres([...sources.keys()], (path) => sources.get(path)!)).toBe(true);
  });

  it("returns false for an empty file list: no files, no suite, no need", () => {
    // Pinned semantics: vitest's start() resolves the specifications BEFORE
    // global setup runs and throws FilesNotFoundError on zero, so setup() never
    // sees an empty list in practice; an empty list means no test file runs at
    // all, so there is nothing to serve. The false-negative side (a missed
    // need) fails a DB suite loudly, while an unneeded start is the defect
    // class this scan exists to prevent.
    expect(runNeedsSharedPostgres([], () => {
      throw new Error("no file should be read");
    })).toBe(false);
  });

  it("short-circuits on the first match", () => {
    let reads = 0;
    const result = runNeedsSharedPostgres(["a.test.ts", "b.test.ts"], (path) => {
      reads += 1;
      return path === "a.test.ts" ? "startPostgresContainer" : "nothing";
    });
    expect(result).toBe(true);
    expect(reads).toBe(1);
  });
});
