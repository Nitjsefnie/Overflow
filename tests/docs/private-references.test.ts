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
 * `nitjsefni.eu` is banned as one domain token, with a single exemption: the
 * product's public instance `overflow.nitjsefni.eu` — the host `README.md`
 * and `CONTRIBUTING.md` present as where the product runs, serving the public
 * API surface including `/api/mcp`. The exemption is a negative lookbehind on
 * the `overflow.` prefix, so the token stays one domain and an internal
 * hostname added later is still caught by default; the `\b` inside the
 * lookbehind stops a longer prefix such as `xoverflow.` from being exempted.
 *
 * Each entry pairs the reported token with its matcher. The machine paths are
 * matched with a word boundary so the bare form — `under /root`, no trailing
 * slash — fires exactly like `/root/`, while a longer word such as `/rooted`
 * still does not.
 */
const FORBIDDEN_PATTERNS: readonly { token: string; pattern: RegExp }[] = [
  { token: "nitjsefni.eu", pattern: /(?<!\boverflow\.)nitjsefni\.eu/ }, // private hostnames, `overflow.` exempt
  { token: "/etc", pattern: /\/etc\b/ }, // machine config paths, bare or trailing-slash form
  { token: "/root", pattern: /\/root\b/ }, // machine home paths, bare or trailing-slash form
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
