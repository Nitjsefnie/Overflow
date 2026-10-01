import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relativeLinks, unresolvedLinks } from "../support/markdown-links";

/**
 * `deploy/incident-response.md` states that replacing `AUTH_SECRET` does not
 * resolve compromised GitHub access, and points the reader at the
 * account-loss and account-compromise procedure for the rest of that answer.
 * Nothing else in the repository notices when that procedure disappears: the
 * runbook still reads correctly, still runs, and leaves the acknowledgement as
 * a dead end. These assertions hold the section itself, not what it says.
 *
 * The assertions are about structure and resolution, never prose. The section
 * has to exist under `## Recover`, it has to have a body, and everything it
 * links has to be there — a faithful paraphrase, a rewording or a rewrite that
 * keeps those three properties leaves this file green, which is the point.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const document = "deploy/incident-response.md";
const source = readFileSync(new URL("../../deploy/incident-response.md", import.meta.url), "utf8");

/** The heading that identifies the section, so it can be found and deleted. */
const recoveryHeading = "### Account loss and account compromise";

/** `## Recover` and everything under it, up to the next `## `. */
function recoverSection(): string {
  return source.split(/^## Recover\r?$/m)[1]?.split(/^## /m)[0] ?? "";
}

/** The recovery section's body: every line after its heading, before the next heading. */
function recoverySection(): string {
  const lines = recoverSection().split("\n");
  const start = lines.findIndex((line) => line === recoveryHeading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("incident response account-loss recovery", () => {
  it("places the recovery section under ## Recover", () => {
    expect(recoverSection(), `No "## Recover" section found in ${document}`).not.toHaveLength(0);
    expect(
      recoverSection().split("\n"),
      `No "${recoveryHeading}" section under "## Recover" in ${document}`,
    ).toContain(recoveryHeading);
  });

  it("gives the recovery section a body, so an emptied section fails", () => {
    expect(recoverySection().trim(), `"${recoveryHeading}" in ${document} has no body`).not.toHaveLength(0);
  });

  it("carries relative links for the resolution check below to read", () => {
    expect(relativeLinks(recoverySection()).length).toBeGreaterThan(0);
  });

  it("resolves every relative link in the recovery section to a file and, with an anchor, to a heading", () => {
    const failures = unresolvedLinks(recoverySection(), document, repositoryRoot);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });
});