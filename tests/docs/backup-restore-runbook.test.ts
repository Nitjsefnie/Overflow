import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { relativeLinks, unresolvedLinks } from "../support/markdown-links";

/**
 * `deploy/backup-restore.md` is the database runbook. Nothing else in the
 * repository notices when it loses a section: the root documents link into it
 * by anchor, and an anchor that stops naming a heading breaks only for the
 * reader who follows it. The off-host copy (issue 1093) added section (i) and
 * subsection (e.4), and these assertions hold the runbook's structure and its
 * resolution, never what it says — a faithful paraphrase that keeps the
 * headings, the commands and the contract identifiers leaves this file green,
 * which is the point.
 */

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const document = "deploy/backup-restore.md";
const runbookPath = resolve(repositoryRoot, document);

/** Read eagerly, but through a guard, so a missing file is a clean failure. */
const runbookExists = existsSync(runbookPath);
const source = runbookExists ? readFileSync(runbookPath, "utf8") : "";
const runbookLines = source.split("\n");

/**
 * The document title and the lettered sections, literally and in order. The
 * letters are anchors other documents link by (OPERATING.md and
 * decommission.md link (d) and (e)), so the letters are load-bearing: a
 * renumbering breaks links this file's own resolution check cannot see, and a
 * rewording changes an anchor under a link that was never re-read. A new
 * section takes the next letter; this list moves with it in the same change.
 */
const title = "# Backing up and restoring the Overflow database";
const sectionHeadings = [
  "## (a) What is backed up",
  "## (b) The least-privilege backup role",
  "## (c) Scheduled backups",
  "## (d) Backup location and retention",
  "## (e) Restoring",
  "## (f) RPO and RTO",
  "## (g) Restore-testing cadence",
  "## (h) Failure alerts",
  "## (i) The encrypted off-host copy",
];

/** The (e) subsections, literally and in order — (e.4) is the off-host path. */
const restoreSubsections = [
  "### (e.1) Drill: restore into a scratch database and compare",
  "### (e.2) Replacing the live database",
  "### (e.3) Ownership fixups",
  "### (e.4) Restoring the encrypted off-host copy",
];

/**
 * The contract identifiers section (i) has to name. A row here is the job's
 * surface landing on the section that documents it: the units and the script
 * it drives, the seven tables whose data the reduced set excludes (the
 * reduced set's whole point — a copy that silently grew to include one of
 * these tables' data would be a different copy than the privacy notice
 * describes), the env entries the operator configures, and the custody and
 * retention facts the notice makes promises about.
 */
const sectionILiterals = [
  "overflow-offhost-backup.timer",
  "overflow-offhost-backup.service",
  "scripts/db-offhost-backup.sh",
  "repository_reconciliation_evidence_facts",
  "repository_reconciliation_evidence",
  "webhook_deliveries",
  "repository_policy_violations",
  "repository_reconciliation_dirty_subjects",
  "repository_reconciliation_jobs",
  "repository_reconciliation_usage",
  "xz -9e",
  "age",
  "overflow-reduced-*.sql.xz.age",
  "OVERFLOW_BACKUP_AGE_RECIPIENT",
  "OVERFLOW_BACKUP_DISCORD_CHANNEL",
  "OVERFLOW_BACKUP_MAX_BYTES",
  "DISCORD_TOKEN",
  "/etc/overflow/backup.env",
  "osc",
  "#credentials",
  "14 days",
  "9.5 MiB",
];

/** The restore-order facts subsection (e.4) has to name. */
const sectionE4Literals = [
  "overflow-reduced-",
  "age -d",
  "xz -d",
  "createdb",
  "ON_ERROR_STOP",
  "POST /api/moderation/rederivation",
];

/** The lines outside fenced code blocks. */
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

/** One fenced code block: its tag (`bash`, `sql`, …) and its body lines. */
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

/** The `bash`-tagged fenced blocks in `text`, body lines only. */
function bashBlocks(text: string): string[][] {
  return fencedBlocks(text)
    .filter((block) => block.tag === "bash")
    .map((block) => block.body);
}

/**
 * The body of one section: its lines after the heading, up to the next `## `
 * outside a fenced block — a `## ` in shell text is a shell comment, not the
 * next section's heading.
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

/**
 * The columns the schema carries on `registered_repositories`, read from
 * `db/migrations/*.sql`: the `create table` block's column lines, plus every
 * `add column` any later `alter table registered_repositories` statement
 * makes. The alter scan reads only the FIRST `add column` per statement, so a
 * statement adding several columns contributes one — enough for what this
 * pins (a select naming a column the schema never had), not a complete
 * schema mirror.
 */
function registeredRepositoryColumns(): Set<string> {
  const columns = new Set<string>();
  const migrationsDir = resolve(repositoryRoot, "db/migrations");
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    const create = sql.match(/create table registered_repositories\s*\(([\s\S]*?)\n\);/);
    if (create !== null) {
      for (const line of create[1]!.split("\n")) {
        const column = line.match(/^\s*(\w+)\s/);
        if (column !== null) columns.add(column[1]!);
      }
    }
    for (const alter of sql.matchAll(
      /alter table registered_repositories[^;]*?add column if not exists (\w+)|alter table registered_repositories[^;]*?add column (\w+)/gi,
    )) {
      columns.add(alter[1] ?? alter[2]!);
    }
  }
  return columns;
}

describe("backup-restore runbook", () => {
  it("exists", () => {
    expect(runbookExists, `${document} does not exist`).toBe(true);
  });

  it("opens with its title and carries the lettered sections, literally and in order", () => {
    const titles = proseLines().filter((line) => /^#\s/.test(line));
    expect(titles, `${document} does not open with the pinned title`).toStrictEqual([title]);
    const headings = proseLines().filter((line) => /^##\s/.test(line));
    expect(headings, `${document} does not carry the pinned section structure`).toStrictEqual([
      ...sectionHeadings,
    ]);
  });

  it("carries the four (e) subsections, literally and in order", () => {
    const subHeadings = proseLines().filter((line) => /^###\s/.test(line));
    expect(subHeadings, `${document} does not carry the pinned (e) subsections`).toStrictEqual([
      ...restoreSubsections,
    ]);
  });

  it("writes every fenced block as bash or sql, the tags the checks below read", () => {
    const tags = fencedBlocks(source).map((block) => block.tag);
    const unexpected = tags.filter((tag) => tag !== "bash" && tag !== "sql");
    expect(unexpected, `${document} fences code in a tag other than bash or sql`).toStrictEqual([]);
    expect(tags, `${document} carries no fenced block to check`).not.toHaveLength(0);
  });

  it("parses every bash fenced block as bash", () => {
    const blocks = bashBlocks(source);
    const failures: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "backup-restore-runbook-"));
    try {
      for (const [index, block] of blocks.entries()) {
        const file = join(dir, `block-${index + 1}.sh`);
        writeFileSync(file, `${block.join("\n")}\n`);
        try {
          execFileSync("bash", ["-n", file], { stdio: "pipe" });
        } catch (error) {
          const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
          failures.push(`bash block ${index + 1} fails bash -n:\n\n${block.join("\n")}\n\n${stderr}`);
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

  describe("section (i), the encrypted off-host copy", () => {
    it("has a body with commands", () => {
      const body = sectionBody("## (i) The encrypted off-host copy");
      expect(body.trim(), `section (i) in ${document} has no body`).not.toHaveLength(0);
      expect(
        bashBlocks(body).length,
        `section (i) in ${document} carries no bash fenced block`,
      ).toBeGreaterThan(0);
    });

    for (const literal of sectionILiterals) {
      it(`names ${literal}`, () => {
        const body = sectionBody("## (i) The encrypted off-host copy");
        expect(body.length, `section (i) in ${document} has no body`).not.toBe(0);
        expect(body, `section (i) in ${document} does not name ${literal}`).toContain(literal);
      });
    }

    it("takes the osc token from the canonical file, not from backup.env", () => {
      const body = sectionBody("## (i) The encrypted off-host copy");
      // The index is captured and asserted before the slice: slice(-1) on a
      // missing marker yields the body's last character, so a nonempty
      // assertion on the slice passes vacuously and the guard cannot fail.
      const marker = body.indexOf("**Operator setup.**");
      expect(marker, `section (i) in ${document} carries no operator-setup marker`).not.toBe(-1);
      const setup = body.slice(marker);

      expect(
        setup,
        `section (i)'s operator setup does not name the canonical token file`,
      ).toContain("~/.agent-bundle/discord/osc.token");

      const envBlock = bashBlocks(setup).find((block) =>
        block.some((line) => line.startsWith("OVERFLOW_BACKUP_AGE_RECIPIENT=")),
      );
      expect(envBlock, "the operator setup shows the backup.env entries").toBeDefined();
      expect(
        envBlock!.join("\n"),
        "the backup.env block must not configure a token",
      ).not.toContain("DISCORD_TOKEN");
    });
  });

  describe("subsection (e.4), restoring the encrypted off-host copy", () => {
    it("has a body with commands", () => {
      const body = sectionBody("### (e.4) Restoring the encrypted off-host copy");
      expect(body.trim(), `subsection (e.4) in ${document} has no body`).not.toHaveLength(0);
      expect(
        bashBlocks(body).at(-1),
        `subsection (e.4) in ${document} carries no bash fenced block`,
      ).toBeDefined();
    });

    for (const literal of sectionE4Literals) {
      it(`names ${literal}`, () => {
        const body = sectionBody("### (e.4) Restoring the encrypted off-host copy");
        expect(body.length, `subsection (e.4) in ${document} has no body`).not.toBe(0);
        expect(body, `subsection (e.4) in ${document} does not name ${literal}`).toContain(literal);
      });
    }

    it("selects only columns the schema carries on registered_repositories", () => {
      const columns = registeredRepositoryColumns();
      expect(
        columns.size,
        "the migrations carry no registered_repositories columns; the pin below would pin nothing",
      ).toBeGreaterThan(0);
      expect(columns.has("id"), "registered_repositories carries no id column").toBe(true);
      expect(
        columns.has("owner_name"),
        "registered_repositories carries no owner_name column",
      ).toBe(true);
      expect(columns.has("owner"), "the column set wrongly contains owner").toBe(false);
      expect(columns.has("name"), "the column set wrongly contains name").toBe(false);

      const body = sectionBody("### (e.4) Restoring the encrypted off-host copy");
      const selects = [...body.matchAll(/select\s+([^"]*?)\s+from\s+registered_repositories/g)];
      expect(
        selects.length,
        `subsection (e.4) in ${document} carries no select against registered_repositories`,
      ).toBeGreaterThan(0);

      const unknown: string[] = [];
      for (const match of selects) {
        for (const piece of match[1]!.split(",")) {
          const column = piece.trim();
          if (column !== "" && !columns.has(column)) unknown.push(column);
        }
      }
      for (const order of body.matchAll(/order by\s+(\w+)/g)) {
        if (!columns.has(order[1]!)) unknown.push(`order by ${order[1]}`);
      }
      expect(
        unknown,
        `subsection (e.4) in ${document} names columns the schema does not carry: ${unknown.join(", ")}`,
      ).toStrictEqual([]);
    });
  });
});
