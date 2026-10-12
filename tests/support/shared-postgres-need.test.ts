import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

  it.each([
    ['import { write } from "../support/writes";', "tests/support/writes.ts"],
    ['export { write } from "../support/writes";', "tests/support/writes.ts"],
    ['const helper = import("../support/writes");', "tests/support/writes.ts"],
    ['const helper = require("../support/writes");', "tests/support/writes.ts"],
    ['import "../support/writes.ts";', "tests/support/writes.ts"],
    ['import "../support/writes.js";', "tests/support/writes.ts"],
    ['import "../support/writes";', "tests/support/writes/index.ts"],
    ['import "../support/writes.helper";', "tests/support/writes.helper.ts"],
    ['import "@/lib/writes";', resolve("src/lib/writes.ts")],
  ])("follows a database helper dependency: %s", (source, helperPath) => {
    const sources = new Map([
      ["tests/fold/solo.test.ts", source],
      [helperPath, 'import { write } from "./nested";'],
      [join(dirname(helperPath), "nested.ts"), "startPostgresContainer();"],
    ]);
    expect(runNeedsSharedPostgres(["tests/fold/solo.test.ts"], (path) => {
      const contents = sources.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    })).toBe(true);
  });

  it("finds a database dependency after an import cycle without reading a module twice", () => {
    const sources = new Map([
      ["tests/fold/solo.test.ts", 'import "../support/cycle";'],
      ["tests/support/cycle.ts", 'import "../fold/solo.test.ts";\nexport * from "./writes";'],
      ["tests/support/writes.ts", "startPostgresContainer();"],
    ]);
    const reads = new Map<string, number>();
    expect(runNeedsSharedPostgres(["tests/fold/solo.test.ts"], (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      if (reads.get(path)! > 1) throw new Error("module read twice");
      const contents = sources.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    })).toBe(true);
    expect(reads.get("tests/fold/solo.test.ts")).toBe(1);
    expect(reads.get("tests/support/cycle.ts")).toBe(1);
  });

  it("detects a helper calling the startup API through namespace bracket access", () => {
    const sources = new Map([
      ["tests/fold/solo.test.ts", 'import "../support/writes";'],
      ["tests/support/writes.ts", 'import * as db from "./postgres-container";\nawait db["startPostgresContainer"]();'],
    ]);
    expect(runNeedsSharedPostgres(["tests/fold/solo.test.ts"], (path) => {
      const contents = sources.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    })).toBe(true);
  });

  it.each(["tests/fold/reconcile.test.ts", "tests/webhooks/processor.test.ts"])(
    "detects the real indirect database consumer %s when run alone",
    (path) => {
      expect(runNeedsSharedPostgres([resolve(path)], (dependency) => readFileSync(dependency, "utf8"))).toBe(true);
    },
  );

  it("returns false when no file contains the marker", () => {
    const sources = new Map([
      ["tests/github/plain.test.ts", `import { expect } from "vitest";\n`],
      ["tests/lib/other.test.ts", `describe("unit", () => {});\n`],
    ]);
    expect(runNeedsSharedPostgres([...sources.keys()], (path) => sources.get(path)!)).toBe(false);
  });

  it.each([false, true])("scans deep valid syntax and its later dependency with database need=%s", (needsDatabase) => {
    const sources = new Map([
      ["tests/unit/solo.test.ts", 'import "./deep";'],
      ["tests/unit/deep.ts", `export const result = ${Array(6000).fill("1").join(" + ")};\nimport "./writes";`],
      ["tests/unit/writes.ts", needsDatabase ? "startPostgresContainer();" : "export const value = 1;"],
    ]);
    const warnings: string[] = [];
    expect(runNeedsSharedPostgres(["tests/unit/solo.test.ts"], (path) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error("ENOENT");
      return source;
    }, (message) => warnings.push(message))).toBe(needsDatabase);
    expect(warnings).toEqual([]);
  });

  it.each([false, true])("warns on parser failure and continues scanning other files with database need=%s", (needsDatabase) => {
    const sources = new Map([
      ["tests/unit/solo.test.ts", 'import "./unparsable";'],
      ["tests/unit/unparsable.ts", `export const result = ${"(".repeat(6000)}1${")".repeat(6000)};`],
      ["tests/unit/other.test.ts", needsDatabase ? "startPostgresContainer();" : "export const value = 1;"],
    ]);
    const warnings: string[] = [];
    expect(runNeedsSharedPostgres(["tests/unit/solo.test.ts", "tests/unit/other.test.ts"], (path) => {
      const source = sources.get(path);
      if (source === undefined) throw new Error("ENOENT");
      return source;
    }, (message) => warnings.push(message))).toBe(needsDatabase);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tests/unit/unparsable.ts");
    expect(warnings[0]).toContain("Maximum call stack size exceeded");
  });

  it("keeps a database-free helper graph database-free, including cycles and type-only edges", () => {
    const sources = new Map([
      ["tests/fold/solo.test.ts", 'import "../support/plain";\nimport type { Write } from "../support/writes";'],
      ["tests/support/plain.ts", 'import "../fold/solo.test.ts";\nexport { type Write } from "./writes";'],
      ["tests/support/writes.ts", "startPostgresContainer();"],
    ]);
    expect(runNeedsSharedPostgres(["tests/fold/solo.test.ts"], (path) => {
      const contents = sources.get(path);
      if (contents === undefined) throw new Error("ENOENT");
      return contents;
    })).toBe(false);
  });

  it.each(["tests/support/postgres-endpoint.test.ts", "tests/deploy/compose-file.test.ts", "tests/config/vitest-max-workers.test.ts"])(
    "does not mistake the shared helper's utility exports for a database request in %s",
    (path) => {
      expect(runNeedsSharedPostgres([resolve(path)], (dependency) => readFileSync(dependency, "utf8"))).toBe(false);
    },
  );

  it("does not scan packages imported through a relative node_modules path", () => {
    const reads: string[] = [];
    const warnings: string[] = [];
    expect(runNeedsSharedPostgres(["tests/unit/solo.test.ts"], (path) => {
      reads.push(path);
      if (path !== "tests/unit/solo.test.ts") throw new Error("package must not be scanned");
      return 'import "../../node_modules/package";';
    }, (message) => warnings.push(message))).toBe(false);
    expect(reads).toEqual(["tests/unit/solo.test.ts"]);
    expect(warnings).toEqual([]);
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

  it("does not throw when reporting an unreadable file to the warning sink", () => {
    const warnings: string[] = [];
    expect(runNeedsSharedPostgres(["tests/db/gone.test.ts"], () => {
      throw new Error("ENOENT: no such file");
    }, (message) => warnings.push(message))).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("tests/db/gone.test.ts");
    expect(warnings[0]).toContain("ENOENT: no such file");
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
