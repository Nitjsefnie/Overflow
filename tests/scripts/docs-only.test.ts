import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDocsOnly, isDocsPath, parseNulList } from "../../scripts/docs-only.ts";
import { commitFiles, git, scratchGitEnv } from "../support/scratch-git";

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

/**
 * The CLI takes the base revision and runs the diff itself, so these cases run
 * it inside real scratch repositories: a rename's source path, a multi-commit
 * range and an undecidable base are all decided by what git actually reports.
 */
describe("docs-only CLI against a git repository", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "docs-only-cli-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A repository whose root commit holds one code file and one doc. */
  async function scratchRepo(): Promise<string> {
    const repo = await mkdtemp(join(root, "repo-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    await commitFiles(
      repo,
      {
        "src/lib/format-signed.ts": "export const formatSigned = (n: number) => `${n}`;\n",
        "README.md": "# scratch\n",
      },
      "root",
    );
    return repo;
  }

  const classify = (repo: string, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8", env: scratchGitEnv });

  it("classifies a code file renamed to a doc by its source path", async () => {
    const repo = await scratchRepo();
    git(repo, "mv", "src/lib/format-signed.ts", "src/lib/format-signed.md");
    git(repo, "commit", "--quiet", "--message", "rename");

    const result = classify(repo, "HEAD^1");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
  });

  it("prints true for a change that only edits a doc", async () => {
    const repo = await scratchRepo();
    await commitFiles(repo, { "README.md": "# scratch, edited\n" }, "docs");

    const result = classify(repo, "HEAD^1");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("true\n");
    expect(result.stderr).toBe("");
  });

  it("covers every commit between the base and HEAD", async () => {
    const repo = await scratchRepo();
    const before = git(repo, "rev-parse", "HEAD");
    await commitFiles(repo, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code");
    await commitFiles(repo, { "README.md": "# scratch, edited\n" }, "docs");

    const result = classify(repo, before);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
  });

  it("prints false for an undecidable base and still exits 0", async () => {
    const repo = await scratchRepo();
    await commitFiles(repo, { "README.md": "# scratch, edited\n" }, "docs");
    const outputPath = join(repo, "option-output");

    for (const base of [
      [],
      [""],
      ["0000000000000000000000000000000000000000"],
      ["1234567890abcdef1234567890abcdef12345678"],
      ["no-such-branch"],
      ["HEAD"],
      [`--output=${outputPath}`],
    ]) {
      const result = classify(repo, ...base);
      expect(result.status, `base ${JSON.stringify(base)}`).toBe(0);
      expect(result.stdout, `base ${JSON.stringify(base)}`).toBe("false\n");
    }
    expect(existsSync(outputPath)).toBe(false);
  });

  it("prints false outside a git repository", async () => {
    const outside = await mkdtemp(join(root, "not-a-repo-"));
    const result = classify(outside, "HEAD^1");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("false\n");
  });
});
