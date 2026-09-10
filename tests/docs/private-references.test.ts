import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every substring a reader of the public repository cannot resolve. The fix
 * standard for `docs/`: a reference must land on something an outside reader
 * can reach — this repository, its issues and pull requests, public
 * documentation sites, or paths inside the checkout. Private hostnames and
 * machine absolute paths resolve only on the machine that wrote the document,
 * so they are rejected at token level, with no judgement about the surrounding
 * prose.
 */
const FORBIDDEN_PATTERNS: readonly string[] = [
  "nitjsefni.eu", // private hostnames
  "/etc/", // machine config paths
  "/root/", // machine home paths
  "/tmp/", // machine scratch paths
];

describe("private references in committed docs", () => {
  it("rejects private hosts and machine paths in every tracked file under docs/", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const files = execFileSync("git", ["ls-files", "docs/"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(resolve(repoRoot, file), "utf8");
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (line.includes(pattern)) {
            violations.push(`${file}:${index + 1}: ${pattern}`);
          }
        }
      }
    }

    expect(
      violations,
      `\n${violations.join("\n")}`,
    ).toStrictEqual([]);
  });
});
