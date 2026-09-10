import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every reference shape a reader of the public repository cannot resolve. The
 * fix standard for `docs/`: a reference must land on something an outside
 * reader can reach — this repository, its issues and pull requests, public
 * documentation sites, or paths inside the checkout. Private hostnames and
 * machine absolute paths resolve only on the machine that wrote the document,
 * so they are rejected at token level, with no judgement about the surrounding
 * prose.
 *
 * Each entry pairs the reported token with its matcher. `/tmp` is matched with
 * a word boundary so the bare form — `under /tmp`, no trailing slash — fires
 * exactly like `/tmp/`, while a longer word such as `/temporary` still does
 * not.
 */
const FORBIDDEN_PATTERNS: readonly { token: string; pattern: RegExp }[] = [
  { token: "nitjsefni.eu", pattern: /nitjsefni\.eu/ }, // private hostnames
  { token: "/etc/", pattern: /\/etc\// }, // machine config paths
  { token: "/root/", pattern: /\/root\// }, // machine home paths
  { token: "/tmp", pattern: /\/tmp\b/ }, // machine scratch paths, bare or trailing-slash form
];

describe("private references in committed docs", () => {
  it("rejects private hosts and machine paths in every tracked file under docs/", async () => {
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const files = execFileSync("git", ["ls-files", "-z", "docs/"], {
      cwd: repoRoot,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean);

    const violations: string[] = [];
    for (const file of files) {
      const text = await readFile(resolve(repoRoot, file), "utf8");
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        for (const { token, pattern } of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${file}:${index + 1}: ${token}`);
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
