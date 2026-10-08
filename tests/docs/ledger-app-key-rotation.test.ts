import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relativeLinks, unresolvedLinks } from "../support/markdown-links";

/**
 * Issue 1032: the Ledger App private-key rotation lacked a runbook.
 * `deploy/incident-response.md` step 9 pointed at deploy/README.md section 11,
 * which does not apply to this key. Section 14 of the deploy guide now carries
 * the procedure.
 *
 * These assertions pin reader-dependent structure: step 9 points to the
 * rotation section, its links and the section's links resolve, section 14
 * links sections 4 and 11, and the procedure has a body with bash fences.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const runbook = "deploy/incident-response.md";
const runbookSource = readFileSync(new URL("../../deploy/incident-response.md", import.meta.url), "utf8");

const guide = "deploy/README.md";
const guideSource = readFileSync(new URL("../../deploy/README.md", import.meta.url), "utf8");
const guideLines = guideSource.split("\n");

/** The section the procedure lives in, by its literal heading. */
const sectionHeading = "## 14. Rotating the Ledger App private key";
const sectionAnchor = "#14-rotating-the-ledger-app-private-key";

/**
 * Step 9's body: the `9. ` list item and every indented line under it, up to
 * the next ordered-list item, a heading, or the end of the `## Recover`
 * section — whichever comes first.
 */
function stepNine(): string {
  const lines = runbookSource.split("\n");
  const recover = lines.findIndex((line) => line === "## Recover");
  if (recover === -1) return "";
  const start = lines.findIndex((line, index) => index > recover && line.startsWith("9. "));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^(#{1,6}\s|\d+\.\s|\S)/.test(line));
  return [lines[start]!, ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

/** One fenced block: its tag (`bash`, `text`, …) and its body lines. */
type Fence = { tag: string; body: string[] };

/** Every fenced block in `text`, in document order, two-state parsed. */
function fencedBlocks(text: string): Fence[] {
  const blocks: Fence[] = [];
  let current: Fence | null = null;
  for (const line of text.split("\n")) {
    if (current === null) {
      const open = line.match(/^```\s*(\S*)\s*$/);
      if (open !== null) current = { tag: open[1] ?? "", body: [] };
    } else if (/^```\s*$/.test(line)) {
      blocks.push(current);
      current = null;
    } else {
      current.body.push(line);
    }
  }
  return blocks;
}

/** The section's lines, from its heading to the next `## `, fences toggled. */
function sectionLines(): string[] {
  const start = guideLines.indexOf(sectionHeading);
  if (start === -1) return [];
  const rest = guideLines.slice(start + 1);
  let fenced = false;
  for (const [offset, line] of rest.entries()) {
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced && /^##\s/.test(line)) return guideLines.slice(start, start + 1 + offset);
  }
  return guideLines.slice(start);
}

describe("incident response step 9 — the App-key rotation pointer", () => {
  it("has a step 9 under ## Recover to pin", () => {
    expect(stepNine(), `no "9. " list item found under "## Recover" in ${runbook}`).not.toHaveLength(0);
  });

  it("points step 9 at the rotation section", () => {
    const links = relativeLinks(stepNine())
      .map((link) => link.target)
      .filter((target) => target.startsWith(`README.md${sectionAnchor}`));
    expect(
      links,
      `step 9 in ${runbook} does not link deploy/README.md ${sectionAnchor}`,
    ).toHaveLength(1);
  });

  it("resolves every relative link in step 9", () => {
    const lines = runbookSource.split("\n");
    const start = lines.findIndex((line) => line.startsWith("9. "));
    const failures = unresolvedLinks(stepNine(), runbook, repositoryRoot, start + 1);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });
});

describe("deploy guide section 14 — the App-key rotation procedure", () => {
  it("has a body", () => {
    expect(sectionLines().join("\n").trim(), `${sectionHeading} has no body`).not.toEqual(sectionHeading);
  });

  it("links section 4 for the host file's path, ownership and readability discipline", () => {
    const links = relativeLinks(sectionLines().join("\n"))
      .map((link) => link.target)
      .filter((target) => target === "README.md#4-create-the-environment-file");
    expect(links, `the section does not link README.md#4-create-the-environment-file`).toHaveLength(1);
  });

  it("carries copy-pasteable commands in bash fences", () => {
    const bash = fencedBlocks(sectionLines().join("\n")).filter((block) => block.tag === "bash");
    expect(
      bash.length,
      `${sectionHeading} carries fewer than three bash-fenced command blocks`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("resolves every relative link in the section", () => {
    const heading = guideLines.indexOf(sectionHeading);
    const failures = unresolvedLinks(sectionLines().join("\n"), guide, repositoryRoot, heading + 1);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });

  it("is cross-linked from section 11, the rotation procedure it must not be confused with", () => {
    const start = guideLines.indexOf("## 11. Rotating the credential encryption key");
    const rest = guideLines.slice(start + 1);
    const end = rest.findIndex((line) => /^##\s/.test(line));
    const section11 = (end === -1 ? rest : rest.slice(0, end)).join("\n");
    const links = relativeLinks(section11)
      .map((link) => link.target)
      .filter((target) => target === sectionAnchor);
    expect(links, `section 11 does not link ${sectionAnchor}`).toHaveLength(1);
  });
});
