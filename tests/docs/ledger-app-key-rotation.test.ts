import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relativeLinks, unresolvedLinks } from "../support/markdown-links";

/**
 * Issue 1032: the repository recorded its Ledger App private key as
 * unreplaceable in practice — `deploy/incident-response.md` step 9 deferred
 * the rotation to a "separate maintainer-held item" no runbook carried, and
 * pointed at deploy/README.md section 11 while stating it must not be applied
 * to this key. Section 14 of the deploy guide now carries the procedure.
 *
 * These assertions hold the structure the reader depends on, never the prose:
 * the placeholder must be gone from the incident runbook, step 9 must link
 * the new section, the section must exist after section 13 (so no existing
 * section was renumbered), it must name both copies the rotation has to
 * replace, it must carry a rollback subsection and copy-pasteable commands in
 * `bash` fences, every link in it must resolve, and — because the procedure
 * is about key material — it must not itself carry any. A faithful paraphrase
 * that keeps those properties leaves this file green, which is the point.
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
 * The phrases that made up the step-9 placeholder. Each was a sentence the
 * runbook used to record the key as unreplaceable; the fix removes them, and
 * any of them coming back is the defect this pin exists to catch.
 */
const placeholderPhrases = [
  "separate maintainer-held item",
  "Until the App-key rotation is written",
  "unreplaceable",
];

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

  it.each(placeholderPhrases)(
    "no longer carries the placeholder phrase %s",
    (phrase) => {
      expect(runbookSource, `the step-9 placeholder phrase "${phrase}" is back in ${runbook}`).not.toContain(phrase);
    },
  );

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
  it("exists after section 13, so no existing section was renumbered", () => {
    const heading = guideLines.indexOf(sectionHeading);
    expect(heading, `${sectionHeading} is missing from ${guide}`).toBeGreaterThan(-1);
    const section13 = guideLines.indexOf("## 13. Verifying the privileged-action journal's client addresses");
    expect(section13, "section 13's heading is missing from deploy/README.md").toBeGreaterThan(-1);
    expect(heading, `${sectionHeading} must sit after section 13 in ${guide}`).toBeGreaterThan(section13);
  });

  it("has a body", () => {
    expect(sectionLines().join("\n").trim(), `${sectionHeading} has no body`).not.toEqual(sectionHeading);
  });

  it("names both copies the rotation replaces — the host PEM and the environment secret", () => {
    const body = sectionLines().join("\n");
    expect(body, "the section never names the host copy under /etc/overflow/github-app").toContain(
      "/etc/overflow/github-app",
    );
    expect(body, "the section never names the LEDGER_APP_KEY secret").toContain("LEDGER_APP_KEY");
    expect(body, "the section never names the overflow-ledger environment").toContain("overflow-ledger");
  });

  it("links section 4 for the host file's path, ownership and readability discipline", () => {
    const links = relativeLinks(sectionLines().join("\n"))
      .map((link) => link.target)
      .filter((target) => target === "README.md#4-create-the-environment-file");
    expect(links, `the section does not link README.md#4-create-the-environment-file`).toHaveLength(1);
  });

  it("carries a Rolling back subsection with a body", () => {
    const lines = sectionLines();
    const start = lines.indexOf("### Rolling back");
    expect(start, `${sectionHeading} has no "### Rolling back" subsection`).toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#{2,6}\s/.test(line));
    expect(
      (end === -1 ? rest : rest.slice(0, end)).join("\n").trim(),
      `"### Rolling back" in ${guide} has no body`,
    ).not.toHaveLength(0);
  });

  it("carries copy-pasteable commands in bash fences", () => {
    const bash = fencedBlocks(sectionLines().join("\n")).filter((block) => block.tag === "bash");
    expect(
      bash.length,
      `${sectionHeading} carries fewer than three bash-fenced command blocks`,
    ).toBeGreaterThanOrEqual(3);
  });

  it("reads the new secret from a file and never an inline body, so no value can be typed into the command", () => {
    const setLines = sectionLines()
      .join("\n")
      .split("\n")
      .filter((line) => line.includes("gh secret set LEDGER_APP_KEY"));
    expect(setLines, "the section never shows the gh secret set LEDGER_APP_KEY command").not.toHaveLength(0);
    for (const line of setLines) {
      expect(line, `the gh secret set line passes the value inline: ${line}`).not.toMatch(/-b\b|--body\b/);
      expect(line, `the gh secret set line does not read the value from a file: ${line}`).toContain("< ");
    }
  });

  it("carries no key material — no PEM block, no quoted literal, in prose or in a fence", () => {
    const body = sectionLines().join("\n");
    expect(body, "the section carries PEM-shaped text").not.toContain("-----BEGIN");
    expect(body, "the section carries PEM-shaped text").not.toContain("PRIVATE KEY");
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
