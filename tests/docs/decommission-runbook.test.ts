import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relativeLinks, unresolvedLinks } from "../support/markdown-links";

/**
 * `deploy/decommission.md` is the deployment's whole-product decommissioning
 * runbook, added because the deployment docs covered install, deploy, rotate
 * and restore and defined no end-of-life path. Nothing else in the repository
 * notices when the runbook loses a phase, loses the commands that make a phase
 * more than prose, or loses the store names that make the difference between
 * "every store has a disposal step" and a document that merely says so — the
 * other procedures keep linking to their own concerns, and a reader who
 * follows the runbook during a real decommission is the one who finds the gap.
 * These assertions hold the runbook's structure and its resolution, not what
 * it says.
 *
 * The assertions are about structure and resolution, never prose. The nine
 * phases have to exist under their literal headings in order, each has to
 * carry its commands in a `sh` fenced block, and each has to name the stores
 * its phase disposes of. A faithful paraphrase, a rewording or a rewrite that
 * keeps those properties leaves this file green, which is the point.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const document = "deploy/decommission.md";
const runbookPath = resolve(repositoryRoot, document);

/** Read eagerly, but through a guard, so a missing file is a clean failure. */
const runbookExists = existsSync(runbookPath);
const source = runbookExists ? readFileSync(runbookPath, "utf8") : "";
const runbookLines = source.split("\n");

/**
 * The document title and the nine phase headings, literally and in order. The
 * order is load-bearing, not presentational: the App and webhook enumeration
 * (phase 4) has to precede the database drop (phase 5) because the
 * enumeration reads `registered_repositories`, and the preflight record
 * (phase 2) has to precede every destructive step because it is the only
 * record of what is being destroyed.
 */
const title = "# Decommissioning";
const phaseHeadings = [
  "## 1. Scope and preconditions",
  "## 2. The preflight record",
  "## 3. Stop and remove the units and timers",
  "## 4. GitHub App deletion and webhook sweep",
  "## 5. Database disposal",
  "## 6. Backup disposal",
  "## 7. Secrets and configuration disposal",
  "## 8. Remaining stores",
  "## 9. Post-decommission verification",
];

/**
 * The store names each phase has to carry. A row here is the audit's store
 * inventory landing on the phase that disposes of it: a phase whose section
 * stops naming a store is the phase that would be run against a store nobody
 * remembered.
 */
const phases: { heading: string; literals: string[] }[] = [
  { heading: "## 1. Scope and preconditions", literals: [] },
  {
    heading: "## 2. The preflight record",
    literals: ["/var/backups/overflow", "/etc/overflow", "/srv/overflow"],
  },
  {
    heading: "## 3. Stop and remove the units and timers",
    literals: [
      "overflow.service",
      "overflow-backup.timer",
      "overflow-bounce.timer",
      "overflow-canary.timer",
      "overflow-alert@.service",
    ],
  },
  {
    heading: "## 4. GitHub App deletion and webhook sweep",
    literals: ["webhook", "registered_repositories"],
  },
  {
    heading: "## 5. Database disposal",
    literals: ["DROP DATABASE", "DROP ROLE"],
  },
  { heading: "## 6. Backup disposal", literals: ["/var/backups/overflow"] },
  {
    heading: "## 7. Secrets and configuration disposal",
    literals: ["/etc/overflow", "alert-recipient", "github-app"],
  },
  {
    heading: "## 8. Remaining stores",
    literals: [
      "/srv/overflow",
      "/var/log/overflow",
      "/var/lib/overflow-bounce",
      "/run/overflow-alert",
      "/run/overflow-canary",
      "journalctl",
    ],
  },
  {
    heading: "## 9. Post-decommission verification",
    literals: ["list-units", "list-timers"],
  },
];

/** The unit files phase 3 names; each must exist as `deploy/<name>`. */
const phase3UnitFiles = [
  "overflow.service",
  "overflow-backup.timer",
  "overflow-bounce.timer",
  "overflow-canary.timer",
  "overflow-alert@.service",
];

/**
 * The lines outside fenced code blocks. Fenced text is not document
 * structure: a `##` inside a shell block is a shell comment, not a heading.
 */
function proseLines(): string[] {
  const kept: string[] = [];
  let fenced = false;
  for (const line of runbookLines) {
    if (/^```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) kept.push(line);
  }
  return kept;
}

/** One fenced code block: its tag (`sh`, `text`, …) and its body lines. */
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

/** The `sh`-tagged fenced blocks in `text`, body lines only. */
function shBlocks(text: string): string[][] {
  return fencedBlocks(text)
    .filter((block) => block.tag === "sh")
    .map((block) => block.body);
}

/**
 * The body of one phase: its lines after the heading, up to the next `## `.
 * The next `## ` ends the section only OUTSIDE a fenced block — a `## ` in
 * shell text is a shell comment, not the next phase's heading — so the scan
 * toggles through fences exactly as `proseLines` and `fencedBlocks` do. The
 * fenced lines stay in the returned body: the per-phase literal assertions
 * read commands that live inside `sh` blocks.
 */
function sectionBody(heading: string, lines: string[] = runbookLines): string {
  const start = lines.findIndex((line) => line === heading);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  let end = -1;
  let fenced = false;
  for (const [offset, line] of rest.entries()) {
    if (/^```/.test(line)) fenced = !fenced;
    else if (!fenced && /^##\s/.test(line)) {
      end = offset;
      break;
    }
  }
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("decommissioning runbook", () => {
  it("exists", () => {
    expect(runbookExists, `${document} does not exist`).toBe(true);
  });

  it("opens with its title and carries the nine phase headings, literally and in order", () => {
    const headings = proseLines().filter((line) => /^#{1,6}\s/.test(line));
    expect(headings, `${document} does not carry the pinned heading structure`).toStrictEqual([
      title,
      ...phaseHeadings,
    ]);
  });

  it("stays flat: no sub-heading anywhere, so the per-phase checks below see whole sections", () => {
    const subHeadings = proseLines().filter((line) => /^#{3,6}\s/.test(line));
    expect(
      subHeadings,
      `${document} carries a sub-heading. Sections are extracted per phase below, so anything under one stops being checked`,
    ).toStrictEqual([]);
  });

  it("does not let a `## ` inside a later fence truncate a phase's checked body", () => {
    const planted = [
      "## 5. Database disposal",
      "prose before the block",
      "```sh",
      "sudo -u postgres psql <<'SQL'",
      "## not a heading, just shell text",
      "SQL",
      "```",
      "prose after the block",
      "## 6. Backup disposal",
      "phase 6 body",
    ];
    const body = sectionBody("## 5. Database disposal", planted);
    expect(
      body,
      "a `## ` line inside a sh fence truncated the phase's checked body, so everything after it in this phase went unchecked",
    ).toContain("prose after the block");
  });

  it("gives the runbook an introduction before the first phase", () => {
    const intro = sectionBody(title).replace(/^##[\s\S]*/, "").trim();
    expect(intro, `${document} has no introduction under "${title}"`).not.toHaveLength(0);
  });

  it("writes every fenced block as sh or text, the tags the per-phase checks below read", () => {
    const tags = fencedBlocks(source).map((block) => block.tag);
    const unexpected = tags.filter((tag) => tag !== "sh" && tag !== "text");
    expect(
      unexpected,
      `${document} fences code in a tag other than sh or text`,
    ).toStrictEqual([]);
    expect(tags, `${document} carries no fenced block to check`).not.toHaveLength(0);
  });

  it("carries at least one sh fenced block, so the bash -n check below reads a real set", () => {
    expect(shBlocks(source).length, `${document} carries no sh fenced block`).toBeGreaterThan(0);
  });

  it("parses every sh fenced block as bash", () => {
    const blocks = shBlocks(source);
    const failures: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "decommission-runbook-"));
    try {
      for (const [index, block] of blocks.entries()) {
        const file = join(dir, `block-${index + 1}.sh`);
        writeFileSync(file, `${block.join("\n")}\n`);
        try {
          execFileSync("bash", ["-n", file], { stdio: "pipe" });
        } catch (error) {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          failures.push(`sh block ${index + 1} fails bash -n:\n\n${block.join("\n")}\n\n${stderr}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });

  it("carries relative links for the resolution check below to read", () => {
    expect(
      relativeLinks(source).length,
      `${document} carries no relative link, so the resolution check below passes on an empty set and pins nothing`,
    ).toBeGreaterThan(0);
  });

  it("resolves every relative link to a file and, with an anchor, to a heading", () => {
    const failures = unresolvedLinks(source, document, repositoryRoot);
    expect(failures, `\n${failures.join("\n")}`).toStrictEqual([]);
  });

  it("names unit files in phase 3 that exist under deploy/", () => {
    const missing = phase3UnitFiles.filter((unit) => !existsSync(resolve(repositoryRoot, "deploy", unit)));
    expect(
      missing,
      `phase 3 names unit files that are not in deploy/: ${missing.join(", ")}`,
    ).toStrictEqual([]);
  });

  describe("each phase", () => {
    for (const phase of phases) {
      describe(phase.heading, () => {
        it("has a body", () => {
          expect(
            sectionBody(phase.heading).trim(),
            `${phase.heading} in ${document} has no body`,
          ).not.toHaveLength(0);
        });

        it("carries its commands in at least one sh fenced block", () => {
          expect(
            shBlocks(sectionBody(phase.heading)).length,
            `${phase.heading} in ${document} carries no sh fenced block`,
          ).toBeGreaterThan(0);
        });

        for (const literal of phase.literals) {
          it(`names ${literal}`, () => {
            const body = sectionBody(phase.heading);
            expect(body.length, `${phase.heading} in ${document} has no body`).not.toBe(0);
            expect(body, `${phase.heading} in ${document} does not name ${literal}`).toContain(
              literal,
            );
          });
        }
      });
    }
  });
});
