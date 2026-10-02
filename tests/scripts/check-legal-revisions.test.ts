import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  legalTextUnchangedJustification,
  reviewCommits,
} from "../../scripts/check-legal-revisions";
import * as legalRevisions from "../../src/lib/legal-revisions";

const TERMS = "src/app/terms/page.tsx";
const RULES = "src/app/rules/page.tsx";
const ACCOUNT_DATA = "src/app/account-data/page.tsx";
const DISPUTES = "src/lib/disputes.ts";
const GUARD = "src/lib/legal-revisions.ts";
const GATE_SCRIPT = "scripts/check-legal-revisions.ts";

/** A commit message that makes no legal-text claim at all. */
const NO_CLAIM = "Subject line only\n\nA paragraph with no claim about the text.\n";

/** Builds a commit record with the default (marker-free) message. */
const commit = (sha: string, files: readonly string[], message: string = NO_CLAIM) => ({
  sha,
  files,
  message,
});

/** A body carrying the well-formed exemption marker with its justification. */
const markerBody = (justification: string): string =>
  `Subject line\n\nA paragraph about the change.\n\nLegal-Text: unchanged; ${justification}\n`;

/**
 * Reads LEGAL_PAGES out of the gate script's source. The array is
 * module-private — the script exports only the review entry points — and this
 * pin must not widen the script's export surface just to be readable, so the
 * test parses the literal instead. A parse that comes back empty fails the
 * length guard in the test loudly rather than passing vacuously.
 */
async function gateLegalPages(): Promise<string[]> {
  const source = await readFile(resolve(GATE_SCRIPT), "utf8");
  const block = source.match(/const LEGAL_PAGES[^=]*=\s*\[([\s\S]*?)\]/);
  if (block === null) {
    throw new Error(`could not read LEGAL_PAGES out of ${GATE_SCRIPT}`);
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Reads SHARED_TEXT_MODULES from the gate source and fails loudly if it cannot parse the list. */
async function gateSharedTextModules(source?: string): Promise<string[]> {
  const gateSource = source ?? (await readFile(resolve(GATE_SCRIPT), "utf8"));
  const block = gateSource.match(/const SHARED_TEXT_MODULES[^=]*=\s*\[([\s\S]*?)\]/);
  if (block === null) {
    throw new Error(`could not read SHARED_TEXT_MODULES out of ${GATE_SCRIPT}`);
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

describe("legal revision gate", () => {
  it("names a commit that changes a legal page without the guard file", () => {
    const violations = reviewCommits([commit("sha-page-only", [TERMS, "src/lib/unrelated.ts"])])
      .violations;

    expect(violations).toHaveLength(1);
    expect(violations[0]?.sha).toBe("sha-page-only");
    expect(violations[0]?.page).toBe(TERMS);
  });

  it("names a commit that rewrites DISPUTE_RULES without the guard file", () => {
    // Rewriting DISPUTE_RULES[0] changes this shared module, whose exported
    // wording is rendered by the terms and rules pages.
    const violations = reviewCommits([commit("sha-dispute-rule-only", [DISPUTES])]).violations;

    expect(violations).toEqual([{ sha: "sha-dispute-rule-only", page: DISPUTES }]);
  });

  it("reports both legal-text sources changed in one commit", () => {
    const sha = "sha-page-and-shared-text";
    const violations = reviewCommits([commit(sha, [TERMS, DISPUTES])]).violations;

    expect(violations).toHaveLength(2);
    expect(violations).toContainEqual({ sha, page: TERMS });
    expect(violations).toContainEqual({ sha, page: DISPUTES });
  });

  it("accepts a commit that changes a legal page and the guard file together", () => {
    expect(reviewCommits([commit("sha-both", [TERMS, GUARD])]).violations).toEqual([]);
  });

  it("accepts a commit that touches only the guard file", () => {
    expect(reviewCommits([commit("sha-guard", [GUARD])]).violations).toEqual([]);
  });

  it("accepts a commit that touches neither a legal page nor the guard file", () => {
    expect(reviewCommits([commit("sha-neither", ["src/lib/unrelated.ts"])]).violations).toEqual(
      [],
    );
  });

  it("names only the offending commits in a mixed range", () => {
    const { violations } = reviewCommits([
      commit("sha-clean", ["src/lib/unrelated.ts"]),
      commit("sha-offending", [RULES]),
      commit("sha-also-clean", [GUARD, "src/lib/unrelated.ts"]),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.sha).toBe("sha-offending");
    expect(violations.map((violation) => violation.sha)).not.toContain("sha-clean");
    expect(violations.map((violation) => violation.sha)).not.toContain("sha-also-clean");
  });

  it("accepts an empty range", () => {
    expect(reviewCommits([]).violations).toEqual([]);
  });

  it("does not let a neighbouring commit's guard bump excuse the page commit", () => {
    const { violations } = reviewCommits([
      commit("sha-page-first", [ACCOUNT_DATA]),
      commit("sha-guard-after", [GUARD]),
    ]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.sha).toBe("sha-page-first");
  });

  it("reports one violation per legal page touched by an offending commit", () => {
    const { violations } = reviewCommits([commit("sha-two-pages", [TERMS, RULES])]);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.page)).toContain(TERMS);
    expect(violations.map((violation) => violation.page)).toContain(RULES);
  });

  it("counts a rename as touching the legal page", () => {
    const renamedTo = "src/app/legal/terms/page.tsx";
    const { violations } = reviewCommits([commit("sha-rename", [TERMS, renamedTo])]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.page).toBe(TERMS);
  });
});

/**
 * The marker's grammar is the whole exemption: whatever shape is accepted here
 * is what a legal-text change can buy its way past, so every loosening is
 * pinned as tightly as every acceptance. The shape is a trailer-style line in
 * the commit message BODY:
 *
 *   Legal-Text: unchanged; <justification>
 *
 * anchored at the start of a whole line (never a substring, never mid-sentence,
 * never an indented or quoted line, never the subject), with a non-empty
 * justification after the delimiter.
 */
describe("the Legal-Text: unchanged marker's grammar", () => {
  const inBody = (line: string): string => `Subject line\n\n${line}\n`;

  it("honours a well-formed marker and returns its justification", () => {
    expect(
      legalTextUnchangedJustification(
        inBody("Legal-Text: unchanged; moved an import into the render function"),
      ),
    ).toBe("moved an import into the render function");
  });

  it("trims whitespace around the justification", () => {
    expect(
      legalTextUnchangedJustification(inBody("Legal-Text: unchanged;   moved an import   ")),
    ).toBe("moved an import");
  });

  it("honours a marker that sits in the last paragraph of the body", () => {
    expect(
      legalTextUnchangedJustification(
        "Subject line\n\nFirst paragraph.\n\nSecond paragraph.\n\nLegal-Text: unchanged; no text moved\n",
      ),
    ).toBe("no text moved");
  });

  it("returns the first justification when a message carries several markers", () => {
    expect(
      legalTextUnchangedJustification(
        inBody("Legal-Text: unchanged; first claim\nLegal-Text: unchanged; second claim"),
      ),
    ).toBe("first claim");
  });

  it("does not honour a bare marker with no delimiter or justification", () => {
    expect(legalTextUnchangedJustification(inBody("Legal-Text: unchanged"))).toBeNull();
  });

  it("does not honour a marker whose justification is missing after the delimiter", () => {
    expect(legalTextUnchangedJustification(inBody("Legal-Text: unchanged;"))).toBeNull();
  });

  it("does not honour a marker whose justification is only whitespace", () => {
    expect(legalTextUnchangedJustification(inBody("Legal-Text: unchanged;    "))).toBeNull();
  });

  it("does not honour a marker buried mid-sentence", () => {
    expect(
      legalTextUnchangedJustification(
        inBody("We agreed the page is fine, so Legal-Text: unchanged; no real change"),
      ),
    ).toBeNull();
  });

  it("does not honour a marker that starts part-way through a line", () => {
    expect(
      legalTextUnchangedJustification(inBody("See-Legal-Text: unchanged; quoted key")),
    ).toBeNull();
  });

  it("does not honour an indented or quoted marker line", () => {
    expect(
      legalTextUnchangedJustification(inBody("  Legal-Text: unchanged; pasted from elsewhere")),
    ).toBeNull();
  });

  it("does not honour a marker carrying only the subject line", () => {
    expect(
      legalTextUnchangedJustification("Legal-Text: unchanged; moved an import\n\nBody text.\n"),
    ).toBeNull();
  });

  it("does not honour a message that is nothing but the marker", () => {
    expect(legalTextUnchangedJustification("Legal-Text: unchanged; moved an import")).toBeNull();
  });

  it("does not honour a differently cased key", () => {
    expect(legalTextUnchangedJustification(inBody("legal-text: unchanged; moved"))).toBeNull();
  });

  it("does not honour a marker claiming anything other than unchanged text", () => {
    expect(legalTextUnchangedJustification(inBody("Legal-Text: changed; rewrote a clause")))
      .toBeNull();
  });

  it("does not honour the marker on a message that never mentions it", () => {
    expect(legalTextUnchangedJustification(NO_CLAIM)).toBeNull();
  });

  // Pasting a code block into a commit message is ordinary, and this repo's own
  // header now spells the marker out — so a fenced example is exactly how a
  // message can carry the string without anyone having written it as a claim
  // about this commit. A marker line inside a fence is documentation, not a
  // claim, and the gate must not read it as one.
  it("does not honour a marker that sits inside a fenced code block", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "The gate honors a marker like this:",
          "",
          "```",
          "Legal-Text: unchanged; this is a documentation example",
          "```",
          "",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not honour a marker inside a tilde-fenced block", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "~~~markdown",
          "Legal-Text: unchanged; tildes fence it too",
          "~~~",
          "",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("does not close a backtick fence with a tilde run", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "```",
          "Legal-Text: unchanged; the tilde below does not close this fence",
          "~~~",
          "Legal-Text: unchanged; still inside the fence",
          "",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("honours the marker outside the fence when the message also shows one inside", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "The gate honors a marker like this:",
          "",
          "```",
          "Legal-Text: unchanged; this is a documentation example",
          "```",
          "",
          "Legal-Text: unchanged; the page's rendered text did not change",
          "",
        ].join("\n"),
      ),
    ).toBe("the page's rendered text did not change");
  });

  // A closing fence carries no info string, so "```ts" does not close a fence
  // the way "```" does. Getting this wrong closes the block early and honours a
  // marker that is still inside it, which is the green direction.
  it("does not close a fence on a run that carries an info string", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "```",
          "```ts",
          "Legal-Text: unchanged; still inside the fence, since ```ts is not a closer",
          "```",
          "",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("honours a marker after a fence that closed on a bare run", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "```",
          "an example block",
          "```",
          "",
          "Legal-Text: unchanged; the real claim, after the block",
          "",
        ].join("\n"),
      ),
    ).toBe("the real claim, after the block");
  });

  // A backtick run whose info string itself holds a backtick is inline code,
  // not a fence delimiter, so it must not swallow the marker on the next line.
  it("does not open a fence on a backtick run whose info string holds a backtick", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Document the exemption grammar",
          "",
          "```const template = `x`",
          "Legal-Text: unchanged; no fence opened, so this is a claim",
          "",
        ].join("\n"),
      ),
    ).toBe("no fence opened, so this is a claim");
  });

  // The subject/body split is `indexOf("\n\n")`, not `indexOf("\n")`. The
  // discriminating shape is a subject of THREE OR MORE lines, and a two-line
  // subject is not: under the `\n` mutant the body slice still starts two
  // characters past the first newline, which for a two-line subject eats the
  // marker's own first character — `Legal-Text:` becomes `egal-Text:` and stops
  // matching for a reason that has nothing to do with the split. Move the marker
  // down one line and it survives the offset intact, so these subjects wrap onto
  // at least three lines and the marker sits on the third.
  it("does not honour a marker on a wrapped subject line when the body claims nothing", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Load the current role at call time",
          "and resolve it inside the component",
          "Legal-Text: unchanged; a claim written into a wrapped subject",
          "",
          "The role is read inside the function instead of at module scope.",
          "",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  it("reads the body marker, not the one a wrapped subject carries", () => {
    expect(
      legalTextUnchangedJustification(
        [
          "Load the current role at call time",
          "and resolve it inside the component",
          "Legal-Text: unchanged; written into a wrapped subject",
          "",
          "The role is read inside the function.",
          "",
          "Legal-Text: unchanged; the real claim, in the body",
          "",
        ].join("\n"),
      ),
    ).toBe("the real claim, in the body");
  });
});

describe("the exemption's scope", () => {
  it("exempts a legal-page change whose message carries a well-formed marker", () => {
    const { violations, exemptions } = reviewCommits([
      commit("sha-exempt", [TERMS], markerBody("moved an import into the render function")),
    ]);

    expect(violations).toEqual([]);
    expect(exemptions).toEqual([
      {
        sha: "sha-exempt",
        justification: "moved an import into the render function",
      },
    ]);
  });

  it("exempts every legal page a marked commit touches", () => {
    const { violations } = reviewCommits([
      commit("sha-two-pages", [TERMS, RULES], markerBody("no rendered text moved")),
    ]);

    expect(violations).toEqual([]);
  });

  it("exempts a shared-text-module change whose message carries a well-formed marker", () => {
    const { violations, exemptions } = reviewCommits([
      commit(
        "sha-disputes-exempt",
        [DISPUTES],
        markerBody("reflowed the list without changing wording"),
      ),
    ]);

    expect(violations).toEqual([]);
    expect(exemptions).toEqual([
      {
        sha: "sha-disputes-exempt",
        justification: "reflowed the list without changing wording",
      },
    ]);
  });

  it("does not let a page exemption excuse an unmarked shared-module change", () => {
    const { violations, exemptions } = reviewCommits([
      commit("sha-page-exempt", [TERMS], markerBody("moved an import without changing wording")),
      commit("sha-module-unmarked", [DISPUTES]),
    ]);

    expect(violations).toEqual([{ sha: "sha-module-unmarked", page: DISPUTES }]);
    expect(exemptions).toEqual([
      {
        sha: "sha-page-exempt",
        justification: "moved an import without changing wording",
      },
    ]);
  });

  it("still reports a violation when the marker carries no justification", () => {
    const { violations, exemptions } = reviewCommits([
      commit("sha-bare", [TERMS], "Subject line\n\nLegal-Text: unchanged\n"),
    ]);

    expect(violations).toHaveLength(1);
    expect(exemptions).toEqual([]);
  });

  it("never exempts a commit that also touches the revision record, marker or not", () => {
    const withMarker = reviewCommits([
      commit("sha-guard-marked", [TERMS, GUARD], markerBody("also bumped the record")),
    ]);
    const withoutMarker = reviewCommits([commit("sha-guard-plain", [TERMS, GUARD])]);

    // The guard makes both commits green, but only the guard does that: a
    // commit that is already green for the record change claims no exemption,
    // so nothing is reported for a reviewer to audit.
    expect(withMarker.violations).toEqual([]);
    expect(withoutMarker.violations).toEqual([]);
    expect(withMarker.exemptions).toEqual([]);
  });

  it("reports no exemption for a commit that touches no legal page", () => {
    const { violations, exemptions } = reviewCommits([
      commit("sha-unrelated", ["src/lib/unrelated.ts"], markerBody("this commit is not a page")),
    ]);

    expect(violations).toEqual([]);
    expect(exemptions).toEqual([]);
  });

  it("keeps marking the unmarked commits of a mixed range", () => {
    const { violations, exemptions } = reviewCommits([
      commit("sha-exempt", [TERMS], markerBody("no rendered text moved")),
      commit("sha-real-text-change", [RULES]),
      commit("sha-clean", ["src/lib/unrelated.ts"]),
    ]);

    expect(violations.map((violation) => violation.sha)).toEqual(["sha-real-text-change"]);
    expect(exemptions.map((exemption) => exemption.sha)).toEqual(["sha-exempt"]);
  });
});

/**
 * The gate resolves the repository it walks from its own location, so every
 * CLI-level leg runs the real binary against a throwaway git repository
 * carrying a byte-identical copy of the script. That fixture is the only way
 * to have real commit MESSAGES, which is where the exemption lives. The
 * fixture is removed again in dispose().
 */
async function createGateFixture(
  options: { failMessageReads?: boolean } = {},
): Promise<{
  git: (...args: string[]) => string;
  commit: (message: string, files: Readonly<Record<string, string>>) => Promise<string>;
  runGate: (base: string, head: string) => {
    status: number | null;
    stdout: string;
    stderr: string;
  };
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "legal-revisions-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(
    resolve(GATE_SCRIPT),
    join(root, "scripts/check-legal-revisions.ts"),
  );

  const git = (...args: string[]): string => {
    const run = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (run.error !== undefined || run.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${run.stderr.trim()}`);
    }
    return run.stdout;
  };

  git("init", "--quiet");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Legal Revision Fixture");
  git("config", "commit.gpgsign", "false");

  let env: NodeJS.ProcessEnv | undefined;
  if (options.failMessageReads === true) {
    // A `git` that answers every subcommand truthfully EXCEPT the
    // commit-message read, so the gate's own fail-closed branch is what the
    // assertion lands on rather than an unrelated git error earlier in the
    // walk. `git log --no-walk --format=%B <sha>` is the only read whose
    // arguments carry --no-walk.
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    if (realGit === "" || realGit.includes('"')) {
      throw new Error("could not resolve the real git binary for the shim");
    }
    const bin = join(root, "shim-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "git"),
      [
        "#!/bin/sh",
        'for arg in "$@"; do',
        '  if [ "$arg" = "--no-walk" ]; then',
        '    echo "synthetic commit-message read failure" >&2',
        "    exit 128",
        "  fi",
        "done",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    env = { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}` };
  }

  const commit = async (
    message: string,
    files: Readonly<Record<string, string>>,
  ): Promise<string> => {
    for (const [path, contents] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents);
    }
    git("add", "--all");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };

  const runGate = (base: string, head: string) => {
    const run = spawnSync(
      process.execPath,
      [join(root, "scripts/check-legal-revisions.ts"), base, head],
      { cwd: process.cwd(), encoding: "utf8", env },
    );
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };

  return {
    git,
    commit,
    runGate,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

describe("the gate's command line", () => {
  it("fails closed when the CLI cannot resolve the base revision", () => {
    const missingRevision = "__task1_missing_base_revision__";
    const result = spawnSync(
      process.execPath,
      [resolve("scripts/check-legal-revisions.ts"), missingRevision, "HEAD"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Could not list commits in ${missingRevision}..HEAD`);
  });

  it("exits 1 over a violating range, naming the sha and the revision-record line", async () => {
    // The false positive this issue was filed for: the page's rendered text is
    // untouched, but nothing but a `Legal-Text: unchanged` claim can say so,
    // and without that claim the commit is a violation.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const headSha = await fixture.commit(
        "page without the revision record\n\nThe page changed and says nothing about its text.\n",
        { [TERMS]: "export default () => null;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(headSha);
      expect(result.stdout).toContain(GUARD);
    } finally {
      await fixture.dispose();
    }
  });

  it("exits 0 over a one-commit range and names the count and range correctly", async () => {
    // The success path through the real binary — a legal page and its revision
    // record landing in the SAME commit — and the success message's count and
    // range wording for the one-commit case.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const headSha = await fixture.commit(
        "terms page with its revision record\n\nThe record moves with the page.\n",
        { [TERMS]: "export default () => null;\n", [GUARD]: "export const LEGAL_REVISIONS = 1;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("1 commit in");
      expect(result.stdout, "the count must not be pluralized for one commit").not.toContain(
        "1 commits",
      );
      expect(result.stdout).toContain(`${baseSha}..${headSha}`);
      expect(result.stdout).toContain("0 commits exempted");
      expect(result.stdout).toContain(
        "changes no legal page or shared-text module without a matching revision-record " +
          "change or a text-unchanged claim (0 commits exempted with a Legal-Text: unchanged claim)",
      );
      // Nothing was exempted, so the stderr audit block is absent outright —
      // not an empty one, and not one stating a zero count. The header says so,
      // and this is the pin that keeps it true on the green path; the two red
      // path legs below assert the same absence.
      expect(result.stderr).not.toContain("exempted");
    } finally {
      await fixture.dispose();
    }
  });

  it("exits 0 over an empty range and says so", async () => {
    // base == head: rev-list over the range lists nothing, so this leg pins
    // the success path's zero-commit shape — exit 0, the pluralized "0
    // commits" count, and the range echoed exactly as passed.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const result = fixture.runGate(baseSha, baseSha);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`0 commits in ${baseSha}..${baseSha}`);
    } finally {
      await fixture.dispose();
    }
  });

  it("exits 0 over a legal-page change carrying a well-formed exemption marker", async () => {
    // LEG 1 — the false positive this gate shipped with. A behaviour-preserving
    // edit to a legal page (the import relocated, the text identical) carrying
    // a justified marker must pass, and the pass must SAY it was exempted, with
    // the sha and the justification, on a stream a reader cannot mistake for
    // the success line.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const justification = "moved a module-scope import into the render function";
      const headSha = await fixture.commit(
        [
          "Load the current role at call time",
          "",
          "The role is read inside the function instead of at module scope.",
          "",
          `Legal-Text: unchanged; ${justification}`,
          "",
        ].join("\n"),
        { [TERMS]: "export default () => <p>Terms</p>;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("1 commit in");
      expect(result.stdout).toContain("1 commit exempted");
      // The audit line's exact shape, not just its two halves: a line that
      // named the sha and the justification but dropped the marker label would
      // read as a gate message rather than as a quoted claim.
      expect(result.stderr).toContain(
        `exempted ${headSha} (Legal-Text: unchanged): ${justification}`,
      );
      expect(result.stderr).toContain("1 commit exempted with a Legal-Text: unchanged claim:");
      expect(
        result.stdout,
        "the per-commit exemption line is the audit trail and belongs on stderr only",
      ).not.toContain(`exempted ${headSha}`);
      expect(
        result.stdout,
        "the justification is the audit trail and belongs on stderr only",
      ).not.toContain(justification);
    } finally {
      await fixture.dispose();
    }
  });

  it("still exits 1 over a real legal-text change that carries no marker", async () => {
    // LEG 2 — the true positive. No exemption anywhere in this commit, so the
    // gate must keep failing it exactly as it did before the exemption existed.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const headSha = await fixture.commit(
        [
          "Rewrite the governing-law paragraph",
          "",
          "The clause now names Delaware instead of the State of New York.",
          "",
        ].join("\n"),
        { [TERMS]: "export default () => <p>Governed by the laws of Delaware.</p>;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(headSha);
      expect(result.stdout).toContain(GUARD);
      expect(result.stdout).toContain("legal page or shared-text module");
      expect(result.stdout).toContain("Legal-Text: unchanged; <justification>");
      expect(result.stderr).not.toContain("exempted");
    } finally {
      await fixture.dispose();
    }
  });

  it("reports the exempted count on the success line of a multi-commit range", async () => {
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const exemptSha = await fixture.commit(
        "Move the role lookup\n\nLegal-Text: unchanged; relocated an import\n",
        { [RULES]: "export default () => <p>Rules</p>;\n" },
      );

      await fixture.commit("Bump the revision record\n\nThe terms record moves.\n", {
        [GUARD]: "export const LEGAL_REVISIONS = 2;\n",
      });

      const headSha = fixture.git("rev-parse", "HEAD").trim();
      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("2 commits in");
      expect(result.stdout).toContain("1 commit exempted");
      expect(result.stderr).toContain(exemptSha);
      expect(result.stderr).toContain("relocated an import");
    } finally {
      await fixture.dispose();
    }
  });

  it("reports the exempted commits even when the range also has a violation", async () => {
    // A red run is exactly when an audit trail matters: the reader is already
    // asking what the gate let through. The exemptions must be printed BEFORE
    // the exit status is decided, or a build that fails for an unrelated commit
    // reports nothing about the commits the gate chose to exempt.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const exemptSha = await fixture.commit(
        "Move the role lookup\n\nLegal-Text: unchanged; relocated an import\n",
        { [RULES]: "export default () => <p>Rules</p>;\n" },
      );

      const violatingSha = await fixture.commit(
        "Rewrite the governing-law paragraph\n\nThe clause names Delaware.\n",
        { [TERMS]: "export default () => <p>Governed by the laws of Delaware.</p>;\n" },
      );

      const result = fixture.runGate(baseSha, violatingSha);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(violatingSha);
      expect(result.stderr).toContain(
        `exempted ${exemptSha} (Legal-Text: unchanged): relocated an import`,
      );
      expect(result.stderr).toContain("1 commit exempted with a Legal-Text: unchanged claim:");
    } finally {
      await fixture.dispose();
    }
  });

  it("exits 1 over a governing-law rewrite whose only marker is inside a fence", async () => {
    // The end-to-end shape the fenced-block gap was demonstrated with: a commit
    // that DOCUMENTS the marker and rewrites the governing law at the same time.
    // The documentation example must not exempt the rewrite.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const headSha = await fixture.commit(
        [
          "Document the exemption grammar and rewrite the governing law",
          "",
          "The gate honors a marker like this:",
          "",
          "```",
          "Legal-Text: unchanged; this is a documentation example",
          "```",
          "",
        ].join("\n"),
        { [TERMS]: "export default () => <p>Governed by the laws of Delaware.</p>;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(headSha);
      expect(result.stdout).toContain(GUARD);
      expect(result.stderr).not.toContain("exempted");
    } finally {
      await fixture.dispose();
    }
  });

  it("exits 1 when the claim is wrapped into the subject instead of the body", async () => {
    // The end-to-end shape the `indexOf("\n")` mutant was demonstrated with: a
    // real effective-date change whose claim sits on the third line of a wrapped
    // subject. The subject wraps onto three lines on purpose — see the grammar
    // tests above for why a two-line subject cannot tell the two apart. Splitting
    // the subject from the body on the first newline instead of the first blank
    // line would read that line as body and exempt the change.
    const fixture = await createGateFixture();
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const headSha = await fixture.commit(
        [
          "Change the effective date",
          "in the terms page",
          "Legal-Text: unchanged; a claim written into a wrapped subject",
          "",
          "The effective date now reads 1 January 2026.",
          "",
        ].join("\n"),
        { [TERMS]: "export default () => <p>Effective 2026-01-01</p>;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain(headSha);
      expect(result.stdout).toContain(GUARD);
      expect(result.stderr).not.toContain("exempted");
    } finally {
      await fixture.dispose();
    }
  });

  it("fails closed when git cannot read a commit's message", async () => {
    // Requirement 6: a message that cannot be read is an error, never a
    // silent pass. The shim breaks only the message read, so the assertion
    // lands on that branch rather than on rev-list or diff-tree.
    const fixture = await createGateFixture({ failMessageReads: true });
    try {
      const baseSha = await fixture.commit("base\n\nFixture base.\n", {
        "README.md": "fixture base\n",
      });

      const headSha = await fixture.commit(
        "page without the revision record\n\nNothing here claims the text is unchanged.\n",
        { [TERMS]: "export default () => <p>Terms</p>;\n" },
      );

      const result = fixture.runGate(baseSha, headSha);

      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("Could not read the message of");
      expect(result.stderr).toContain("synthetic commit-message read failure");
    } finally {
      await fixture.dispose();
    }
  });
});

/**
 * The gate is only as complete as the span between its page list and the
 * record module's exports: a fourth legal document added as a new page plus a
 * new *_REVISION export, without a LEGAL_PAGES entry, would ship silently
 * ungated — the gate would walk three pages and never look at the fourth.
 * This pin closes that direction: every record the module exports must name a
 * document whose page exists and is one the gate walks.
 *
 * The module side is imported, not parsed: the exports are typed values, so
 * the language enumerates them and a rename or reformat cannot rot the pin.
 * The script side is parsed from source because LEGAL_PAGES is module-private
 * and widening the script's export surface just to be readable is a
 * production change this pin does not get to make; an unparsable or empty
 * list fails the length guard below loudly instead of passing vacuously.
 */
describe("the gate's coverage of the revision record module", () => {
  it("walks a page for every document the record module stamps", async () => {
    const legalPages = await gateLegalPages();
    expect(
      legalPages.length,
      "LEGAL_PAGES must parse out of scripts/check-legal-revisions.ts — an unparsable " +
        "or empty list would make this pin vacuous",
    ).toBeGreaterThan(0);

    const records = Object.entries(legalRevisions).filter(([name]) =>
      name.endsWith("_REVISION"),
    );
    expect(
      records.length,
      "the record module must export at least one *_REVISION record — an empty module " +
        "would make this pin vacuous",
    ).toBeGreaterThan(0);

    for (const [name, record] of records) {
      const page = `src/app/${record.document}/page.tsx`;

      await expect(
        access(resolve(page)),
        `${name} stamps document "${record.document}", but no page renders at ` +
          `${page} — the record cites a document the site does not serve`,
      ).resolves.toBeUndefined();

      expect(
        legalPages,
        `${page} renders a document the record module stamps, but it is missing from ` +
          `LEGAL_PAGES — edits to its text would ship without a revision-record bump`,
      ).toContain(page);
    }
  });
});

describe("the gate's coverage of shared legal-text modules", () => {
  it("pins every reader-facing shared module so an omitted module cannot ship silently", async () => {
    const sharedTextModules = await gateSharedTextModules();
    expect(
      sharedTextModules.length,
      "SHARED_TEXT_MODULES must parse out of scripts/check-legal-revisions.ts — an " +
        "unparsable or empty list would let shared legal-text edits ship silently",
    ).toBeGreaterThan(0);

    expect(
      sharedTextModules,
      "the first-class inventory must match every shared module supplying legal-page wording",
    ).toEqual([DISPUTES]);
  });

  it("throws its explicit parse error for malformed shared-text inventory source", async () => {
    const source = await readFile(resolve(GATE_SCRIPT), "utf8");
    const malformedSource = source.replace(
      /const SHARED_TEXT_MODULES[^=]*=\s*\[[\s\S]*?\];/,
      "",
    );
    expect(malformedSource).not.toBe(source);

    await expect(gateSharedTextModules(malformedSource)).rejects.toThrow(
      `could not read SHARED_TEXT_MODULES out of ${GATE_SCRIPT}`,
    );
  });
});
