import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relativeLinks, unresolvedLinks } from "../support/markdown-links";

/**
 * Section 14 of the deploy guide carries the Overflow Ledger App's
 * CI-secret-only key rotation; the reconciliation App that once shared the
 * section is retired, so the host-only procedure and incident-response's
 * rotation pointer are gone. These assertions pin reader-dependent
 * structure: the section has a body, its links resolve, and the CI
 * procedure's command blocks stay exact.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const guide = "deploy/README.md";
const guideSource = readFileSync(new URL("../../deploy/README.md", import.meta.url), "utf8");
const guideLines = guideSource.split("\n");

/** The section the procedure lives in, by its literal heading. */
const sectionHeading = "## 14. Rotating GitHub App private keys";
const sectionAnchor = "#14-rotating-github-app-private-keys";
const ciHeading = "### Check-publishing App: CI-secret-only";

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

function procedureText(heading: string): string {
  const lines = sectionLines();
  const start = lines.indexOf(heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  let fenced = false;
  for (const [offset, line] of rest.entries()) {
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced && /^###\s/.test(line)) return rest.slice(0, offset).join("\n");
  }
  return rest.join("\n");
}

describe("deploy guide section 14 — the App-key rotation procedure", () => {
  it("has a body", () => {
    expect(sectionLines().join("\n").trim(), `${sectionHeading} has no body`).not.toEqual(sectionHeading);
  });

  it("carries the check-publishing procedure and no other", () => {
    const procedures = sectionLines().filter((line) => /^###\s/.test(line));
    expect(procedures).toStrictEqual([ciHeading]);
  });

  it("restores CI secret replacement, relay verification and rollback command logic", () => {
    const bash = fencedBlocks(procedureText(ciHeading)).filter((block) => block.tag === "bash");
    expect(bash.map((block) => block.body.join("\n"))).toEqual([
      [
        "(", "set -e",
        "gh secret set LEDGER_APP_KEY --repo Nitjsefnie/Overflow --env overflow-ledger < /local/path/to/the-downloaded.pem",
        "gh secret list --repo Nitjsefnie/Overflow --env overflow-ledger", ")",
      ].join("\n"),
      [
        "gh workflow run ledger-relay.yml --repo Nitjsefnie/Overflow",
        "run_id=$(gh run list --repo Nitjsefnie/Overflow --workflow ledger-relay.yml --limit 1 --json databaseId --jq '.[0].databaseId')",
        "printf 'relay probe run: %s\\n' \"$run_id\"",
        "gh run watch \"$run_id\" --repo Nitjsefnie/Overflow --exit-status",
      ].join("\n"),
      [
        "gh api 'repos/Nitjsefnie/Overflow/commits/MERGE-COMMIT-SHA/check-runs?filter=all&per_page=100' --paginate \\",
        "  --jq '.check_runs[] | select(.app.id == 5118623) | {name: .name, status: .status, conclusion: .conclusion}'",
      ].join("\n"),
      "gh secret set LEDGER_APP_KEY --repo Nitjsefnie/Overflow --env overflow-ledger < /local/path/to/the-previous.pem",
    ]);
  });

  it("resolves every relative link in the section", () => {
    const heading = guideLines.indexOf(sectionHeading);
    const failures = unresolvedLinks(sectionLines().join("\n"), guide, repositoryRoot, heading + 1);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });

  it("is cross-linked from section 11, the encryption-key procedure it must not be confused with", () => {
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
