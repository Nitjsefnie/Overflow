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
 * the `overflow.` prefix, so exactly an `overflow.` preceded by a non-word
 * character or the line start is exempt — an internal hostname added later is
 * still caught by default, and a longer prefix such as `xoverflow.` is not
 * exempted.
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

  it("pins the exemption lookbehind and the machine-path word boundaries", () => {
    const patternFor = (token: string): RegExp => {
      const entry = FORBIDDEN_PATTERNS.find(({ token: t }) => t === token);
      if (!entry) throw new Error(`no FORBIDDEN_PATTERNS entry for ${token}`);
      return entry.pattern;
    };
    const domain = patternFor("nitjsefni.eu");

    // "foo-overflow.nitjsefni.eu" is exempt too (non-word char before the
    // prefix defeats the lookbehind's `\b`) — pinned as accepted, not
    // desirable: a property of the maintainer-mandated fail-safe shape, and
    // no such host exists.
    expect(domain.test("overflow.nitjsefni.eu")).toBe(false);
    expect(domain.test("https://overflow.nitjsefni.eu")).toBe(false);
    expect(domain.test("foo-overflow.nitjsefni.eu")).toBe(false);
    expect(domain.test("nitjsefni.eu")).toBe(true);
    expect(domain.test("docs.nitjsefni.eu")).toBe(true);
    expect(domain.test("xoverflow.nitjsefni.eu")).toBe(true);

    expect(patternFor("/root").test("under /root")).toBe(true);
    expect(patternFor("/etc").test("in /etc")).toBe(true);
    expect(patternFor("/tmp").test("under /tmp")).toBe(true);
    expect(patternFor("/root").test("/rooted")).toBe(false);
    expect(patternFor("/etc").test("/etcetera")).toBe(false);
    expect(patternFor("/tmp").test("/temporary")).toBe(false);
  });
});
