import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isDocsOnly, isDocsPath, parseNulList } from "../../scripts/docs-only.ts";

const script = fileURLToPath(
  new URL("../../scripts/docs-only.ts", import.meta.url),
);

describe("docs-only paths", () => {
  it("classifies documentation extensions and LICENSE as docs", () => {
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("docs/architecture.md")).toBe(true);
    expect(isDocsPath("notes.txt")).toBe(true);
    expect(isDocsPath("design.rst")).toBe(true);
    expect(isDocsPath("manual.adoc")).toBe(true);
    expect(isDocsPath("LICENSE")).toBe(true);
  });

  it("classifies by the final path segment only", () => {
    expect(isDocsPath("src/lib/LICENSE")).toBe(true);
    expect(isDocsPath("docs/LICENSE.ts")).toBe(false);
  });

  it("classifies code paths as non-docs", () => {
    expect(isDocsPath("src/lib/fold/repository-fold.ts")).toBe(false);
    expect(isDocsPath("package.json")).toBe(false);
    expect(isDocsPath("Makefile")).toBe(false);
    expect(isDocsPath(".gitignore")).toBe(false);
    expect(isDocsPath("LICENSES")).toBe(false);
    expect(isDocsPath(".md")).toBe(false);
  });

  it("matches extensions case-insensitively", () => {
    expect(isDocsPath("README.MD")).toBe(true);
    expect(isDocsPath("Readme.Txt")).toBe(true);
  });
});

describe("docs-only change sets", () => {
  it("counts an empty diff as code, not docs", () => {
    expect(isDocsOnly([])).toBe(false);
  });

  it("accepts a change set made only of docs paths", () => {
    expect(isDocsOnly(["README.md"])).toBe(true);
    expect(isDocsOnly(["README.md", "CONTRIBUTING.md", "LICENSE"])).toBe(true);
  });

  it("rejects when any path is a code path", () => {
    expect(isDocsOnly(["README.md", "src/lib/fold/repository-fold.ts"])).toBe(false);
    expect(isDocsOnly(["src/a.ts"])).toBe(false);
  });
});

describe("NUL-delimited lists", () => {
  it("splits on NUL and drops empty segments", () => {
    expect(parseNulList("README.md\0CONTRIBUTING.md\0")).toEqual([
      "README.md",
      "CONTRIBUTING.md",
    ]);
    expect(parseNulList("a.md")).toEqual(["a.md"]);
    expect(parseNulList("\0\0")).toEqual([]);
    expect(parseNulList("")).toEqual([]);
  });
});

describe("docs-only CLI", () => {
  const run = (stdin: string) =>
    spawnSync(process.execPath, [script], {
      encoding: "utf8",
      input: stdin,
    });

  it("prints true for a docs-only diff and exits 0", () => {
    const result = run("README.md\0LICENSE\0");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
    expect(result.stderr).toBe("");
  });

  it("prints false when a code path is present", () => {
    const result = run("README.md\0src/index.ts\0");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
  });

  it("prints false for an empty diff", () => {
    const result = run("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
  });
});
