import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { diffFingerprint } from "@/lib/fold/diff-fingerprint";

/**
 * A pull request's diff fingerprint depends on the change, not on how long the
 * forge abbreviates blob ids: GitHub has served the same change at 8 and at 9
 * hex characters. The base diff below has the section shapes git 2.47 prints
 * (a text edit, a rename with a mode change, a binary edit, a new and a deleted
 * file); its ids are built here so every abbreviation is a prefix of one id.
 * The admitted subset: only a whole line `index <hex>..<hex>` or
 * `index <hex>..<hex> <octal mode>` in lowercase hex has its ids cut to four
 * characters (git's floor, so any served length shares the prefix); a
 * combined-diff header, uppercase hex, a trailing \r or extra text is hashed
 * as served, and so is index-shaped text inside a content line.
 */

const id = (seed: string) => seed.repeat(5).slice(0, 40);
const ZERO = "0".repeat(40);
// One [old, new] pair per section; the README pair starts like octocat/Hello-World's pull request 1.
const IDS = [["c57eff55e", "719be62e9"], ["95fa285b7", "a740bd8ac"], ["a20aca49a", "a98f84bab"], [ZERO, "e69de29bb"], ["286c5f577", ZERO]]
  .map(([before, after]) => [before === ZERO ? ZERO : id(before!), after === ZERO ? ZERO : id(after!)] as const);

function served(lengths: readonly number[] = [9, 9, 9, 9, 9]): string {
  const [readme, script, logo, created, deleted] = IDS.map(([before, after], section) =>
    `${before.slice(0, lengths[section])}..${after.slice(0, lengths[section])}`);
  return [
    "diff --git a/README b/README", `index ${readme} 100644`, "--- a/README", "+++ b/README", "@@ -1,2 +1,2 @@",
    " Hello", "-World", "+World!", "\\ No newline at end of file",
    "diff --git a/a.sh b/b.sh", "old mode 100644", "new mode 100755", "similarity index 66%", "rename from a.sh", "rename to b.sh",
    `index ${script}`, "--- a/a.sh", "+++ b/b.sh", "@@ -1,3 +1,3 @@", "-echo a", "+echo b", " exit 0", " exit 1",
    "diff --git a/logo.png b/logo.png", `index ${logo} 100644`, "Binary files a/logo.png and b/logo.png differ",
    "diff --git a/new.txt b/new.txt", "new file mode 100644", `index ${created}`,
    "diff --git a/old.txt b/old.txt", "deleted file mode 100644", `index ${deleted}`, "--- a/old.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-gone", "",
  ].join("\n");
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const nine = (value: string) => value.slice(0, 9);
const flip = (value: string, at: number) => `${value.slice(0, at)}${value[at] === "0" ? "1" : "0"}${value.slice(at + 1)}`;
const [README, , LOGO, CREATED] = IDS.map(([before, after]) => [nine(before), nine(after)] as const);
const BASE = served();

describe("diff fingerprint", () => {
  it.each([
    ["8-character ids", [8, 8, 8, 8, 8]], ["40-character ids", [40, 40, 40, 40, 40]], ["4-character ids", [4, 4, 4, 4, 4]],
    ["a different id length on each section", [8, 40, 4, 9, 12]],
  ])("gives the 9-character diff's fingerprint to the same change at %s", (_label, lengths) => {
    expect(diffFingerprint(served(lengths))).toBe(diffFingerprint(BASE));
  });

  it("hashes the diff with each blob id cut to four characters and the rest byte for byte", () => {
    const canonical = "diff --git a/README b/README\nindex c57e..719b 100644\n--- a/README\n+++ b/README\n@@ -1,2 +1,2 @@\n"
      + " Hello\n-World\n+World!\n\\ No newline at end of file\ndiff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000..e69d\n";
    const nineCharacters = canonical.replace("index c57e..719b", `index ${README[0]}..${README[1]}`)
      .replace("index 0000..e69d", `index ${CREATED[0]}..${CREATED[1]}`);
    expect(nineCharacters).toContain("index c57eff55e..719be62e9 100644\n");
    expect(nineCharacters).toContain("\nindex 000000000..e69de29bb\n");
    expect(diffFingerprint(nineCharacters)).toBe(sha256(canonical));
    expect(diffFingerprint(canonical)).toBe(sha256(canonical));
  });

  it("gives the empty diff the SHA-256 of the empty string", () => {
    expect(diffFingerprint("")).toBe(sha256(""));
  });

  it.each([
    ["the file path", "README", "README.md"], ["the new file mode", "new file mode 100644", "new file mode 100755"],
    ["the deleted file mode", "deleted file mode 100644", "deleted file mode 100755"],
    ["the old and new modes", "old mode 100644\nnew mode 100755", "old mode 100755\nnew mode 100644"],
    ["the mode on the index line", `${README[1]} 100644`, `${README[1]} 100755`], ["the rename", "b.sh", "c.sh"],
    ["the similarity line", "similarity index 66%", "similarity index 67%"], ["a hunk header", "@@ -1,3 +1,3 @@", "@@ -2,3 +2,3 @@"],
    ["an added line", "+World!", "+World?"], ["a removed line", "-echo a", "-echo c"], ["a context line", " exit 0", " exit 2"],
    ["the no-newline marker", "\n\\ No newline at end of file", ""], ["the binary line", "Binary files a/logo.png and b/logo.png differ\n", ""],
    ["the first four characters of the old id", `index ${LOGO[0]}..`, `index ${flip(LOGO[0], 3)}..`],
    ["the first four characters of the new id", `..${LOGO[1]} 100644`, `..${flip(LOGO[1], 3)} 100644`],
    ["one more file section", "diff --git a/new.txt", "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000..e69d\ndiff --git a/new.txt"],
  ])("changes the fingerprint for a change to %s", (_property, from, to) => {
    const changed = BASE.replaceAll(from, to);
    expect(changed).not.toBe(BASE);
    expect(diffFingerprint(changed)).not.toBe(diffFingerprint(BASE));
  });

  it.each([
    ["the old id alone", `index ${README[0]}..`, `index ${flip(README[0], 4)}..`],
    ["the new id alone", `..${README[1]} 100644`, `..${flip(README[1], 8)} 100644`],
    ["an all-zero id", `index ${CREATED[0]}..`, `index ${ZERO}..`],
  ])("keeps the fingerprint when characters past the fourth change in %s", (_label, from, to) => {
    const changed = BASE.replace(from, to);
    expect(changed).not.toBe(BASE);
    expect(diffFingerprint(changed)).toBe(diffFingerprint(BASE));
  });

  // Each text is index-shaped but outside the admitted header form, so it is hashed as served.
  it.each([
    ["an added line", (ids: string) => `+index ${ids} 100644`], ["a removed line", (ids: string) => `-index ${ids} 100644`],
    ["a context line", (ids: string) => ` index ${ids} 100644`], ["text after a carriage return", (ids: string) => `+x\rindex ${ids}`],
    ["text after a line separator", (ids: string) => `+x\u2028index ${ids}`], ["text after a paragraph separator", (ids: string) => `+x\u2029index ${ids}`],
    ["a header with a trailing carriage return", (ids: string) => `index ${ids} 100644\r`], ["a header with extra text", (ids: string) => `index ${ids} 100644 x`],
    ["a combined-diff header", (ids: string) => `index ${LOGO[0]},${ids}`],
    ["an uppercase header", (ids: string) => `index ${ids.toUpperCase()} 100644`],
  ])("hashes %s as served", (_shape, line) => {
    const text = (ids: string) => BASE.replace(`index ${README[0]}..${README[1]} 100644`, line(ids));
    const longer = text(`${README[0]}..${README[1]}`);
    expect(longer).not.toBe(BASE);
    expect(diffFingerprint(longer)).not.toBe(diffFingerprint(text(`${flip(README[0], 6)}..${flip(README[1], 6)}`)));
  });
});
