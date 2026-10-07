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
 * keeps those properties leaves this file green, which is the point.
 *
 * A second describe holds the privileged-action journal section the same way:
 * the section must exist with a body, must link the deploy guide's host
 * procedure, every link in it must resolve, and its action table must name
 * every action the code's union declares. The journal line's shape itself is
 * pinned where it belongs — in the code's own tests.
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

/**
 * The recovery section's body: every line after its heading, up to the next
 * heading of any level. `firstLine` is that body's line in `document`, so a
 * failed link resolution names a line in the file a reader opens.
 */
function recoverySection(): { body: string; firstLine: number } {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === recoveryHeading);
  if (start === -1) return { body: "", firstLine: 1 };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return {
    body: (end === -1 ? rest : rest.slice(0, end)).join("\n"),
    firstLine: start + 2,
  };
}

/**
 * The section's whole extent, from its heading to the next `## ` — not the
 * truncated body. A sub-heading is invisible from inside the body, because the
 * body stops at exactly the heading a flatness check would be looking for.
 */
function recoverySectionExtent(): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === recoveryHeading);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The heading that identifies the privileged-action journal section. */
const journalHeading = "### Journal and request correlation";

/**
 * The journal section's body: every line after its heading, up to the next
 * heading of any level, with `firstLine` naming the body's line in the file.
 */
function journalSection(): { body: string; firstLine: number } {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === journalHeading);
  if (start === -1) return { body: "", firstLine: 1 };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6}\s/.test(line));
  return {
    body: (end === -1 ? rest : rest.slice(0, end)).join("\n"),
    firstLine: start + 2,
  };
}

describe("incident response account-loss recovery", () => {
  it("places the recovery section under ## Recover", () => {
    const recover = recoverSection();
    expect(recover, `No "## Recover" section found in ${document}`).not.toHaveLength(0);
    expect(
      recover.split("\n"),
      `No "${recoveryHeading}" section under "## Recover" in ${document}`,
    ).toContain(recoveryHeading);
  });

  it("gives the recovery section a body, so an emptied section fails", () => {
    expect(recoverySection().body.trim(), `"${recoveryHeading}" in ${document} has no body`).not.toHaveLength(0);
  });

  it("carries relative links for the resolution check below to read", () => {
    expect(
      relativeLinks(recoverySection().body).length,
      `"${recoveryHeading}" in ${document} carries no relative link, so the resolution check below passes on an empty set and pins nothing`,
    ).toBeGreaterThan(0);
  });

  it("resolves every relative link in the recovery section to a file and, with an anchor, to a heading", () => {
    const { body, firstLine } = recoverySection();
    const failures = unresolvedLinks(body, document, repositoryRoot, firstLine);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });

  it("keeps the recovery section flat, so the link check above covers all of it", () => {
    const subHeadings = recoverySectionExtent().filter((line) => /^#{1,6}\s/.test(line));
    expect(
      subHeadings,
      `"${recoveryHeading}" in ${document} has a sub-heading. The body above stops at the first one, so every line after it goes unchecked`,
    ).toStrictEqual([]);
  });
});

describe("incident response privileged-action journal section", () => {
  it("exists with a body", () => {
    expect(
      journalSection().body.trim(),
      `"${journalHeading}" in ${document} is missing or has no body`,
    ).not.toHaveLength(0);
  });

  it("links the deploy guide's host procedure and resolves every link in the section", () => {
    const { body, firstLine } = journalSection();
    // From inside deploy/, the guide is linked as `README.md#…` (the doc's
    // own convention), so the section-13 anchor names the target directly.
    const links = relativeLinks(body).filter((link) => link.target.startsWith("README.md#13-"));
    expect(
      links,
      `"${journalHeading}" in ${document} does not link deploy/README.md section 13 for the proxy-secret host procedure`,
    ).toHaveLength(1);
    const failures = unresolvedLinks(body, document, repositoryRoot, firstLine);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });

  it("lists every implemented action name in the subject-keys table", () => {
    // Extracted from the source union, so a new action fails here until the
    // runbook's table names it — the table claims to be exhaustive.
    const logSource = readFileSync(
      new URL("../../src/lib/security/privileged-action-log.ts", import.meta.url),
      "utf8",
    );
    const union = logSource.match(/export type PrivilegedAction =([\s\S]*?);/)?.[1] ?? "";
    const actions = [...union.matchAll(/"([a-z.-]+)"/g)].map((match) => match[1]!);
    expect(actions.length, "no action names extracted from the PrivilegedAction union").toBeGreaterThan(0);
    const table = journalSection().body;
    for (const action of actions) {
      expect(table, `the journal table in ${document} omits the action name ${action}`).toContain(`\`${action}\``);
    }
  });
});
