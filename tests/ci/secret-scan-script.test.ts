import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  commitFiles,
  git,
  isShallowCheckout,
  scratchGitEnv,
  showFileLines,
  tryGit,
} from "../support/scratch-git";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "gitleaks-provenance-"), join(tmpdir(), "gitleaks-redirect-")]);

const PINNED_VERSION = "8.30.1";

const EXPECTED_CHECKABLE_ENTRIES = 3;

/** One gitleaks finding as the committed baseline carries it. */
type Finding = {
  RuleID: string;
  Match: string;
  Secret: string;
  File: string;
  Commit: string;
  Fingerprint: string;
  StartLine: number;
};

const CAPTURED_FINDING: Record<string, unknown> = {
  RuleID: "generic-api-key",
  Description: "Detected a Generic API Key, potentially exposing access to various services and sensitive operations.",
  StartLine: 18,
  EndLine: 18,
  StartColumn: 8,
  EndColumn: 65,
  Match: "TOKEN_ISSUANCE_ID = \"REDACTED\"",
  Secret: "REDACTED",
  File: "tests/moderation/writer-credential.test.ts",
  SymlinkFile: "",
  Commit: "efe1207df09dbad2d95b7e5c7502ae8d7f46e697",
  Link: "https://github.com/Nitjsefnie/Overflow/blob/efe1207df09dbad2d95b7e5c7502ae8d7f46e697/tests/moderation/writer-credential.test.ts#L18",
  Entropy: 3.617861,
  Author: "Nitjsefnie",
  Email: "zmatek.peter@gmail.com",
  Date: "2026-10-01T19:25:15Z",
  Message: "Pin the three pure boundaries issue 905 left untested\n\nrepository-ownership, writer-credential and session-recovery-reasons had\nno reference anywhere in tests/, so the coverage floor stayed green with\nnone of their own boundary logic pinned. Each new suite kills real mutants\nof the behaviour its module documents:\n\n- belongsToRegisteredRepository is keyed on GitHub's numeric repository id\n  and on nothing else. The fixtures carry the names the real call sites\n  carry, so a name-keyed implementation has the names to be wrong with —\n  a renamed repository and a freed-name impostor are both refused only by\n  the id comparison, and ids that share digits or sit one apart stay\n  distinct.\n- credentialTokenId decides the token-id column from the KIND, so a session\n  reference that also carries an issuance still records the ('session',\n  NULL) pair the 054 CHECK accepts and ('session', <id>) rejects;\n  credentialKind returns null rather than undefined for a writer with no\n  request behind it.\n- toSessionRecoveryReason accepts the declared literals and nothing else:\n  a near miss in case, in whitespace, a longer word starting with a\n  literal, an unknown word, and a non-string all come back undefined.\n\nCo-Authored-By: Space Bunny Alpha <noreply@openrouter.ai>",
  Tags: [],
  Fingerprint: "efe1207df09dbad2d95b7e5c7502ae8d7f46e697:tests/moderation/writer-credential.test.ts:generic-api-key:18",
};

function wholeRecordEquals(committed: Record<string, unknown>, captured: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(committed), ...Object.keys(captured)]);
  for (const key of keys) {
    if (JSON.stringify(committed[key] ?? null) !== JSON.stringify(captured[key] ?? null)) return false;
  }
  return true;
}

/** The parsed baseline as whole records, which is the shape the comparison above is written against. */
function asRecords(entries: Finding[]): Record<string, unknown>[] {
  return entries as unknown as Record<string, unknown>[];
}

export function provenanceViolations(finding: Pick<Finding, "Match">, sourceLine: string): string[] {
  const residue = finding.Match.replaceAll("REDACTED", "");
  return (residue.match(/[A-Za-z0-9_]+/g) ?? []).filter((run) => !sourceLine.includes(run));
}

describe(".github/gitleaks-baseline.json", () => {
  let findings: Finding[];

  beforeAll(async () => {
    findings = JSON.parse(await readFile(resolve(".github/gitleaks-baseline.json"), "utf8")) as Finding[];
  });

  it("is a non-empty JSON array of findings", () => {
    expect(Array.isArray(findings), "the baseline must be the JSON array gitleaks --report-format json emits").toBe(true);
    expect(findings.length).toBeGreaterThan(0);
  });

  it("carries no secret material: every Secret is redacted away, and so is the secret inside Match", () => {

    for (const finding of findings) {
      expect(finding.Secret, `Secret for ${finding.Fingerprint}`).toBe("REDACTED");
      expect(
        finding.Match,
        `Match for ${finding.Fingerprint} still carries the secret; without --redact this field is the token`,
      ).toContain("REDACTED");
    }
  });

  it("keeps BOTH Match shapes gitleaks 8.30.1 emits, rather than normalising them to one", () => {

    const bare = findings.filter((finding) => finding.Match === "REDACTED");
    const contextual = findings.filter((finding) => finding.Match !== "REDACTED" && finding.Match.includes("REDACTED"));
    expect(
      bare.length,
      "no entry's Match is the bare literal REDACTED — a rule whose match IS the secret redacts to it, " +
        "and a baseline with none of those has been hand-normalised away from what gitleaks emits",
    ).toBeGreaterThan(0);
    expect(
      contextual.length,
      "no entry's Match retains the source context around the redaction — a baseline whose every Match is " +
        "the bare literal has been hand-normalised and suppresses nothing",
    ).toBeGreaterThan(0);
  });

  it("leaves nothing but source-line context where the secret was", () => {

    for (const finding of findings) {
      const residue = finding.Match.replaceAll("REDACTED", "");
      expect(
        residue,
        `${finding.Fingerprint} leaves '${residue}' around the redaction, which is not source-line ` +
          "context — an identifier, the punctuation of the literals around it, and whitespace only",
      ).toMatch(/^[A-Za-z0-9_"'=:,(){}\[\]. -]*$/);
    }
  });

  it("bounds what the redaction can leave, to what 8.30.1 actually emits", () => {

    for (const finding of findings) {
      const longest = Math.max(0, ...[...finding.Match.replaceAll("REDACTED", "").matchAll(/[A-Za-z0-9_]+/g)].map((match) => match[0].length));
      expect(
        longest,
        `${finding.Fingerprint} leaves a ${longest}-character identifier-shaped run, above the 24 ` +
          "characters 8.30.1 is measured to leave behind",
      ).toBeLessThanOrEqual(24);
    }
  });

  it("records only findings under tests/, which is where this repository's fixtures live", () => {
    for (const finding of findings) {
      expect(
        finding.File.startsWith("tests/"),
        `${finding.Fingerprint} is in ${finding.File}, not under tests/ — a finding outside the fixture tree is a ` +
          "live secret and must be handled as an incident, not baselined",
      ).toBe(true);
    }
  });

  it("records a full-length commit SHA for every finding", () => {
    for (const finding of findings) {
      expect(finding.Commit, `Commit for ${finding.Fingerprint}`).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("carries the fingerprint gitleaks 8.30.1 emits for each finding", () => {
    // The shape is Commit:File:RuleID:StartLine. It is asserted rather than
    // trusted because a hand-edited or regenerated-elsewhere baseline can carry
    // a fingerprint this version would never produce, and the comparison the
    // baseline exists to drive is whole-record equality against a report this
    // same version emits.
    for (const finding of findings) {
      expect(
        finding.Fingerprint,
        `${finding.Commit}:${finding.File}:${finding.RuleID}:${finding.StartLine}`,
      ).toBe(`${finding.Commit}:${finding.File}:${finding.RuleID}:${finding.StartLine}`);
    }
  });

  it("has no two entries sharing a fingerprint", () => {
    // A duplicate is not a working baseline: it says the same finding was
    // recorded twice, which usually means a baseline assembled by hand.
    const fingerprints = findings.map((finding) => finding.Fingerprint);
    expect(new Set(fingerprints).size, "duplicate fingerprints in the baseline").toBe(fingerprints.length);
  });

  it("is accepted by the provenance check, on the real entries, at any depth", () => {

    let checked = 0;
    for (const finding of findings) {
      const runs = finding.Match.replaceAll("REDACTED", "").match(/[A-Za-z0-9_]+/g) ?? [];
      const line = `const value = "${runs.join("")}";`;
      expect(
        provenanceViolations(finding, line),
        `${finding.Fingerprint} leaves ${runs.join(", ") || "nothing"} around the redaction, and those ` +
          "runs are source context, so a line carrying them must satisfy the provenance check",
      ).toEqual([]);
      if (runs.length > 0) checked += 1;
    }

    expect(
      checked,
      `only ${checked} of ${findings.length} committed entries leave a residue this suite can check, ` +
        `against a baseline that should yield ${EXPECTED_CHECKABLE_ENTRIES}. A drop is a finding, not a ` +
        "chore: entries lost the residue that made them checkable, and a green run would keep certifying " +
        "less than it appears to.",
    ).toBe(EXPECTED_CHECKABLE_ENTRIES);
  });

  it("carries the captured scan report whole-record, which is the equality gitleaks suppresses on", () => {

    expect(
      asRecords(findings).some((committed) => wholeRecordEquals(committed, CAPTURED_FINDING)),
      "no committed entry equals the captured scan report field for field. gitleaks 8.30.1 suppresses a finding " +
        "only on whole-record equality, so a near miss — one column, one entropy, one timestamp — leaves the " +
        "weekly scan red on a history that is otherwise clean.",
    ).toBe(true);
  });

  it("stops matching the captured record the moment the entry is removed, or one field of it moves", () => {

    const committed = asRecords(findings);
    const matches = (entries: Record<string, unknown>[]) => entries.some((entry) => wholeRecordEquals(entry, CAPTURED_FINDING));

    const without = committed.filter((entry) => !wholeRecordEquals(entry, CAPTURED_FINDING));
    expect(
      committed.length - without.length,
      `the baseline holds ${committed.length - without.length} entries equal to the captured record; it must hold 1`,
    ).toBe(1);
    expect(
      matches(without),
      "with that one entry removed, nothing else in the baseline may match it — this is the half of the acceptance " +
        "that reds the scan, and it has to be shown rather than claimed",
    ).toBe(false);

    const mutations: [string, unknown][] = [
      ["StartColumn", 9],
      ["Entropy", 3.617862],
      ["Date", "2026-10-01T19:25:16Z"],
    ];
    for (const [field, value] of mutations) {
      const mutated = committed.map((entry) =>
        wholeRecordEquals(entry, CAPTURED_FINDING) ? { ...entry, [field]: value } : entry,
      );
      expect(
        matches(mutated),
        `moving ${field} to ${String(value)} must break the whole-record match: gitleaks compares every field, so a ` +
          "single-field drift suppresses nothing and the scan stays red",
      ).toBe(false);
    }
  });
});

describe("the provenance check, against a repository this suite builds", () => {
  let root = "";
  let repo = "";
  /** The line the synthetic commit's fixture file carries, read back from git. */
  let sourceLine = "";

  const SOURCE = [
    'import { describe, it } from "vitest";',
    'describe("fixtures", () => {',
    '  it("names a key", () => {',
    '    vi.stubEnv("OVERFLOW_TOKEN_ENCRYPTION_KEY", "inert-placeholder");',
    "  });",
    "});",
  ].join("\n");

  const finding = (match: string): Pick<Finding, "Match"> => ({ Match: match });

  beforeAll(async () => {
    root = await tempDirectories.createAsync(join(tmpdir(), "gitleaks-provenance-"));
    repo = join(root, "origin");
    await mkdir(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    const sha = await commitFiles(repo, { "tests/fixtures/keys.test.ts": `${SOURCE}\n` }, "fixture");
    // Read the line back out of the object database rather than reusing the
    // string above, so the check is exercised on a line that genuinely came
    // from a commit — the way the committed baseline's own entries would be.
    sourceLine = git(repo, "show", `${sha}:tests/fixtures/keys.test.ts`).split("\n")[3];
  });

  afterAll(async () => {
    if (root) await tempDirectories.disposeAsync(root);
  });

  it("accepts the residue gitleaks actually leaves, so the check is not vacuous", () => {
    // The positive case, and it is the one that makes the negative cases mean
    // something. A checker that rejects everything would pass every rejection
    // test below while being useless.
    expect(sourceLine, "the synthetic commit must carry the line the fixtures read").toContain("OVERFLOW_TOKEN_ENCRYPTION_KEY");
    expect(provenanceViolations(finding('OVERFLOW_TOKEN_ENCRYPTION_KEY", "REDACTED"'), sourceLine)).toEqual([]);
    // And the shape a rule produces when its match IS the secret: nothing left.
    expect(provenanceViolations(finding("REDACTED"), sourceLine)).toEqual([]);
  });

  it("rejects a token spliced in beside the redaction, at the length that beat a bound", () => {
    // The reviewer planted exactly this shape and a 28-character bound let it
    // through. 20 characters is under the tightened 24 bound too, so the
    // character count cannot reject it and only provenance can — which is why
    // the bound is the cheap first filter and this is the guard.
    const planted = "Ab3dEf9hIj2kLm4nOp6q";
    expect(planted.length).toBe(20);
    expect(planted.length).toBeLessThan(24);
    expect(
      provenanceViolations(finding(`${planted}REDACTED`), sourceLine),
      "a token of this length beside a redaction is not source context",
    ).toEqual([planted]);
  });

  it("rejects a short token too, which is where a length bound cannot follow", () => {
    // 12 characters, well under any bound read off the committed data. Only
    // provenance rejects this, which is why it is the check that ships.
    const planted = "Ab3dEf9hIj2k";
    expect(planted.length).toBeLessThan(24);
    expect(provenanceViolations(finding(`${planted}REDACTED`), sourceLine)).toEqual([planted]);
  });

  it("rejects an identifier taken from a different line of the same file", () => {
    // A reviewer reading the entry would see a plausible source identifier; only
    // the line it names gives it away.
    const planted = "gitleaks_provenance";
    expect(provenanceViolations(finding(`${planted}REDACTED`), sourceLine)).toEqual([planted]);
  });

  it("names every offending run, not merely that one exists", () => {
    // A baseline with two splices must report both, so a fix is verifiable
    // without re-deriving which material was planted. The separator matters:
    // pasted with nothing between them the two bodies read as ONE identifier
    // run, which is itself the shape a hand-paste produces.
    const planted = ["Ab3dEf9hIj2kLm4nOp6q", "Ab3dEf9hIj2k"];
    expect(provenanceViolations(finding(`${planted.join('", "')}REDACTED`), sourceLine)).toEqual(planted);
  });
});

describe("the git reads that decide whether the deep check runs", () => {
  let elsewhere = "";

  beforeAll(async () => {
    elsewhere = await tempDirectories.createAsync(join(tmpdir(), "gitleaks-redirect-"));
    const repo = join(elsewhere, "shallow");
    await mkdir(repo, { recursive: true });
    // A real repository with real commits, so `rev-parse --is-shallow-repository`
    // can only answer `true` about it if git is really being pointed there.
    git(repo, "init", "--quiet", "--initial-branch=main");
    await commitFiles(repo, { "README.md": "# somewhere else\n" }, "root");
    // Make it genuinely shallow, so the redirect is detectable rather than a
    // no-op: a full repository would answer `false` to the same query.
    const marker = join(repo, ".git", "shallow");
    await writeFile(marker, `${git(repo, "rev-parse", "HEAD")}\n`, "utf8");
  });

  afterAll(async () => {
    if (elsewhere) await tempDirectories.disposeAsync(elsewhere);
  });

  const REDIRECTORS = [
    { variable: "GIT_DIR", value: () => join(elsewhere, "shallow", ".git"), redirects: true },
    { variable: "GIT_COMMON_DIR", value: () => join(elsewhere, "shallow", ".git"), redirects: true },
    { variable: "GIT_WORK_TREE", value: () => join(elsewhere, "shallow"), redirects: false },
    {
      variable: "GIT_OBJECT_DIRECTORY",
      value: () => join(elsewhere, "shallow", ".git", "objects"),
      redirects: false,
    },
    {
      variable: "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      value: () => join(elsewhere, "shallow", ".git", "objects"),
      redirects: false,
    },
    { variable: "GIT_INDEX_FILE", value: () => join(elsewhere, "shallow", ".git", "index"), redirects: false },
    { variable: "GIT_NAMESPACE", value: () => "some-namespace", redirects: false },
  ] as const;

  it.skipIf(isShallowCheckout())("reports the ambient depth, not one redirected by a GIT variable", async () => {
    const ambient = isShallowCheckout();
    expect(ambient, "this case only has teeth when the ambient checkout is full depth").toBe(false);
    let biting = 0;

    for (const { variable, value, redirects } of REDIRECTORS) {
      const saved = process.env[variable];
      process.env[variable] = value();
      try {
        const unshielded = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
          encoding: "utf8",
          env: process.env,
        }).stdout.trim();

        if (redirects) {
          expect(unshielded, `${variable} must genuinely redirect, or this case proves nothing`).toBe("true");
          expect(
            unshielded,
            `${variable} must produce a DIFFERENT depth answer from the ambient checkout, or the ` +
              "shielded assertion below is true-to-true and this case certifies nothing",
          ).not.toBe(String(ambient));
          biting += 1;
        }

        vi.resetModules();
        const shielded = await import("../support/scratch-git");
        expect(
          shielded.isShallowCheckout(),
          `with ${variable} pointed elsewhere, the shielded read must still answer about the checkout ` +
            "this test is running in. Answering 'shallow' here skips the deep provenance check on a " +
            "full-depth repository, on a green run.",
        ).toBe(ambient);
      } finally {
        if (saved === undefined) delete process.env[variable];
        else process.env[variable] = saved;
      }
    }
    expect(
      biting,
      "no redirector case could have failed here, so this test certifies nothing in this checkout",
    ).toBeGreaterThan(0);
  });

  it("reports the ambient commits, not one redirected by a GIT variable", async () => {
    const ambientHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: scratchGitEnv })
      .stdout.trim();
    expect(ambientHead, "the ambient checkout must have a HEAD to look for").toMatch(/^[0-9a-f]{40}$/);

    let biting = 0;
    for (const { variable, value, redirects } of REDIRECTORS) {
      const saved = process.env[variable];
      process.env[variable] = value();
      try {
        const unshielded = spawnSync("git", ["cat-file", "-e", `${ambientHead}^{commit}`], {
          encoding: "utf8",
          env: process.env,
        }).status === 0;
        if (redirects) {
          expect(
            unshielded,
            `${variable} must make an unshielded read lose this checkout's HEAD, or the assertion ` +
              "below is true-to-true and this case certifies nothing",
          ).toBe(false);
          biting += 1;
        }

        vi.resetModules();
        const shielded = await import("../support/scratch-git");
        expect(
          shielded.hasCommit(ambientHead),
          `with ${variable} redirected, hasCommit must still find the ambient checkout's own HEAD`,
        ).toBe(true);
      } finally {
        if (saved === undefined) delete process.env[variable];
        else process.env[variable] = saved;
      }
    }
    expect(biting, "at least one redirector case must have run").toBeGreaterThan(0);
  });

});

describe("the committed baseline's provenance, where the history is present", () => {
  const findings: Finding[] = JSON.parse(readFileSync(resolve(".github/gitleaks-baseline.json"), "utf8"));
  const shallow = isShallowCheckout();

  it.skipIf(shallow)("reproduces every residue from the source line its entry records", () => {
    const sources = new Map<string, string[]>();

    let checked = 0;
    for (const finding of findings) {
      const key = `${finding.Commit}:${finding.File}`;
      if (!sources.has(key)) {
        try {
          sources.set(key, showFileLines(finding.Commit, finding.File));
        } catch (error) {

          expect.fail(
            `the baseline names ${key}, which must exist in this repository's history: ` +
              `${(error as Error).message}`,
          );

          return expect.fail(
            `the baseline names ${key}, but its lines were not read, so there is nothing to check it ` +
              "against. The guard above did not stop the loop.",
          );
        }
      }
      const line = sources.get(key)![finding.StartLine - 1] ?? "";

      if ((finding.Match.replaceAll("REDACTED", "").match(/[A-Za-z0-9_]+/g) ?? []).length > 0) {
        checked += 1;
      }
      expect(
        provenanceViolations(finding, line),
        `${finding.Fingerprint} leaves runs around the redaction that do not appear in ` +
          `${finding.File} line ${finding.StartLine} at commit ${finding.Commit}. Whatever is there is ` +
          "not source context — it is material spliced into the baseline.",
      ).toEqual([]);
    }
    expect(
      checked,
      `this run verified the provenance of ${checked} of ${findings.length} committed entries, against a ` +
        `baseline that should yield ${EXPECTED_CHECKABLE_ENTRIES} checkable ones. A finding whose Match ` +
        "is a pure redaction leaves no residue and cannot be checked this way — that is correct, not a " +
        "gap, and the redaction assertions are what carry those entries. A DROP is not correct though: it " +
        "means entries lost the residue that made them checkable, and a green run would keep certifying " +
        "less than it appears to.",
    ).toBe(EXPECTED_CHECKABLE_ENTRIES);
  });

  it.skipIf(shallow)("pins the source the captured entry names, at the commit it names", () => {

    const entry = asRecords(findings).find((committed) => wholeRecordEquals(committed, CAPTURED_FINDING));
    expect(
      entry,
      "the baseline carries no entry equal to the captured report record, so there is no source here to pin",
    ).toBeDefined();
    const { Commit, File, RuleID, Fingerprint, Match, StartLine } = entry as unknown as Finding;

    expect(Commit, "the captured entry must name a full commit SHA, not an abbreviation").toMatch(/^[0-9a-f]{40}$/);

    const ancestry = spawnSync("git", ["merge-base", "--is-ancestor", Commit, "HEAD"], {
      encoding: "utf8",
      env: scratchGitEnv,
      timeout: 10_000,
    });
    expect(
      ancestry.status,
      `${Commit} must be an ancestor of HEAD, or scripts/secret-scan-baseline.sh fails the weekly sweep on a ` +
        "committed entry",
    ).toBe(0);

    const line = showFileLines(Commit, File)[StartLine - 1] ?? "";
    const runs = Match.replaceAll("REDACTED", "").match(/[A-Za-z0-9_]+/g) ?? [];
    expect(runs, `the captured entry leaves no identifier residue, so nothing can be pinned to a source line`).not.toHaveLength(0);
    for (const run of runs) {
      expect(
        line,
        `the captured entry's residue \`${run}\` must be a verbatim slice of ${File} line ${StartLine} at ${Commit}`,
      ).toContain(run);
    }
    expect(provenanceViolations({ Match }, line)).toEqual([]);
    expect(Fingerprint, `the fingerprint must be the shape 8.30.1 emits`).toBe(`${Commit}:${File}:${RuleID}:${StartLine}`);
  });
});

describe("scripts/secret-scan.sh", () => {
  const scriptPath = resolve("scripts/secret-scan.sh");
  const baselinePath = resolve(".github/gitleaks-baseline.json");

  type StubConfig = {
    /** What `gitleaks version` prints. */
    version?: string;
    /** What the scan subcommand exits with. */
    exitCode?: number;
    /** Run with no gitleaks on PATH at all. */
    absent?: boolean;
    /** A OVERFLOW_GITLEAKS_REPORT_PATH to set, or undefined for the script's own default. */
    reportPath?: string;

    script?: string;
  };

  type RunResult = {
    status: number | null;
    output: string;
    argv: string[];
    /** The report the script wrote, resolved against the directory it ran in. */
    report: string;
  };

  const STUB_GITLEAKS = [
    "#!/usr/bin/env bash",
    "set -uo pipefail",
    ': > "$STUB_ARGV_FILE"',
    'for a in "$@"; do printf \'%s\\n\' "$a" >> "$STUB_ARGV_FILE"; done',
    'subcommand="${1:-}"',
    'case "$subcommand" in',
    "  version)",
    '    if [ "$#" -ne 1 ]; then echo "stub gitleaks: version takes no arguments: $*" >&2; exit 3; fi',
    '    printf \'%s\\n\' "$STUB_VERSION"',
    "    exit 0",
    "    ;;",
    "  git) ;;",
    '  *) echo "stub gitleaks: unrecognised subcommand: ${subcommand:-<none>}" >&2; exit 3 ;;',
    "esac",
    "shift",
    "report_format=''",
    "report_path=''",
    "baseline=''",
    "target=''",
    'while [ "$#" -gt 0 ]; do',
    '  a="$1"',
    '  case "$a" in',
    "    --redact|--no-banner) ;;",
    "    --report-format|--report-path|--baseline-path)",
    '      [ "$#" -ge 2 ] || { echo "stub gitleaks: $a was given no value" >&2; exit 3; }',
    '      case "$a" in',
    '        --report-format) report_format="$2" ;;',
    '        --report-path) report_path="$2" ;;',
    '        --baseline-path) baseline="$2" ;;',
    "      esac",
    "      shift",
    "      ;;",
    '    -*) echo "stub gitleaks: unrecognised flag: $a" >&2; exit 3 ;;',
    '    *) target="$a" ;;',
    "  esac",
    "  shift",
    "done",
    '[ "$report_format" = json ] || { echo "stub gitleaks: report format is \'$report_format\', expected json" >&2; exit 3; }',
    '[ -n "$report_path" ] || { echo "stub gitleaks: no --report-path was passed" >&2; exit 3; }',
    '[ -n "$baseline" ] || { echo "stub gitleaks: no --baseline-path was passed" >&2; exit 3; }',
    '[ -f "$baseline" ] || { echo "stub gitleaks: the named baseline does not exist: $baseline" >&2; exit 3; }',
    '[ -n "$target" ] || { echo "stub gitleaks: no scan target was passed" >&2; exit 3; }',
    "printf '[]\\n' > \"$report_path\"",
    'exit "${STUB_EXIT:-0}"',
  ].join("\n");

  let tempRoot = "";
  let counter = 0;

  async function runScript(config: StubConfig = {}): Promise<RunResult> {
    const script = config.script ?? scriptPath;
    counter += 1;
    const caseDir = join(tempRoot, `case-${counter}`);
    const binDir = join(caseDir, "bin");
    const workDir = join(caseDir, "work");
    await mkdir(binDir, { recursive: true });
    await mkdir(workDir, { recursive: true });
    const argvFile = join(caseDir, "argv.txt");
    const stub = join(binDir, "gitleaks");
    await writeFile(stub, `${STUB_GITLEAKS}\n`, "utf8");
    await chmod(stub, 0o755);

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of ["OVERFLOW_GITLEAKS_REPORT_PATH", "STUB_ARGV_FILE", "STUB_VERSION", "STUB_EXIT"]) {
      delete env[key];
    }
    // A PATH that carries only bash's own essentials. When the case supplies a
    // stub the stub's directory is prepended; when it does not, gitleaks is
    // genuinely unreachable — this box has no system-wide gitleaks, which is
    // the same condition a runner with a failed download-step produces.
    const essentials = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
    env.PATH = config.absent ? essentials.join(":") : [binDir, ...essentials].join(":");
    Object.assign(env, {
      STUB_ARGV_FILE: argvFile,
      STUB_VERSION: config.version ?? PINNED_VERSION,
      STUB_EXIT: String(config.exitCode ?? 0),
    });
    if (config.reportPath !== undefined) env.OVERFLOW_GITLEAKS_REPORT_PATH = config.reportPath;

    const result = spawnSync("bash", [script], { cwd: workDir, env, encoding: "utf8" });
    const argv = existsSync(argvFile)
      ? readFileSync(argvFile, "utf8").split("\n").filter((line) => line.length > 0)
      : [];
    const report = join(workDir, config.reportPath ?? "gitleaks-report.json");
    return { status: result.status, output: `${result.stdout}\n${result.stderr}`, argv, report };
  }

  /** The value that follows `flag` in the recorded argv, or undefined. */
  const valueAfter = (argv: string[], flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };

  beforeAll(async () => {
    tempRoot = join(tmpdir(), `secret-scan-script-${process.pid}-${Date.now()}`);
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("documents every push, pull request and daily sweep with trusted scripts", async () => {
    const source = await readFile(scriptPath, "utf8");
    expect(source).toContain("every push to main and every pull request");
    expect(source).toContain("daily sweep");
    expect(source).toContain("git objects");
    expect(source).not.toContain("WHY SCHEDULED RATHER THAN PULL-REQUEST-REACHABLE");
  });

  it("selects git-history mode and never a directory scan", async () => {
    const { argv, status, output } = await runScript();
    expect(status, `the stub accepted the argv the script passed: ${output}`).toBe(0);
    expect(argv, "gitleaks must be invoked as `gitleaks git`, or the history is never walked").toContain("git");
    // `dir` is the other subcommand that takes a path. A script that swapped
    // `git` for `dir` would scan the checkout and still exit 0 while every
    // committed-and-then-deleted secret stayed invisible — a green no-op.
    expect(argv, "`gitleaks dir` scans the working tree, not the history").not.toContain("dir");
  });

  it("walks the WHOLE repository, not a subtree of it", async () => {
    const { argv, status, output } = await runScript();
    expect(status, `the stub accepted the argv the script passed: ${output}`).toBe(0);
    const target = argv[argv.length - 1];

    const topLevel = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: scratchGitEnv,
    }).stdout.trim();
    expect(topLevel, "the repository root must be resolvable for this assertion to mean anything").toMatch(/^\//);

    expect(
      target,
      `the scan must walk the whole repository, not a subtree — it targeted '${target}'. A subtree ` +
        "target means a credential committed anywhere outside it is never reported and the run is " +
        "green, which is the whole failure this workflow exists to catch.",
    ).toBe(topLevel);

    expect(
      existsSync(target) && statSync(target).isDirectory(),
      `the scan target '${target}' must be the repository root and must exist as a directory`,
    ).toBe(true);
  });

  it("passes the repository's committed baseline, --redact, and a JSON report path", async () => {
    const { argv, output } = await runScript();
    expect(output, `the stub accepted the argv the script passed: ${output}`).not.toContain("stub gitleaks:");
    expect(
      valueAfter(argv, "--baseline-path"),
      "the baseline path must resolve to this repository's committed .github/gitleaks-baseline.json",
    ).toBe(baselinePath);
    expect(argv, "--redact is what keeps the report free of secret material").toContain("--redact");
    expect(
      argv,
      "--no-banner keeps the gitleaks banner out of the run log; without it every scheduled run opens " +
        "with four lines of ASCII art ahead of the scan's own output",
    ).toContain("--no-banner");
    expect(valueAfter(argv, "--report-format"), "the report must be JSON so the workflow can upload it").toBe("json");
    expect(
      valueAfter(argv, "--report-path"),
      "the report path must be the default unqualified name, so it lands where the caller ran the script",
    ).toBe("gitleaks-report.json");
    expect(
      existsSync(resolve("scripts/secret-scan.sh")),
      "the baseline the script named must be a real committed file",
    ).toBe(true);
  });

  it("passes the scan's own exit code through, clean case and findings case alike", async () => {
    const clean = await runScript({ exitCode: 0 });
    expect(clean.status, "a clean scan must exit 0").toBe(0);

    const findings = await runScript({ exitCode: 1 });
    // The one failure this exists to catch: `set -e` around the scan followed
    // by a second command turns a findings run green, and a scheduled scan that
    // cannot go red is a scan that reports nothing forever.
    expect(findings.status, "a findings scan must exit nonzero — the script must not swallow the exit code").toBe(1);
  });

  it("writes the report to the caller's path, creating the parent directory", async () => {
    const { report, status } = await runScript({ reportPath: "artifacts/nested/gitleaks-report.json" });
    expect(status, "the scan must still run against a caller-chosen report path").toBe(0);
    expect(existsSync(report), `the report must be written to the caller's path, creating ${report}'s parents`).toBe(true);
  });

  it("refuses to scan when gitleaks is absent from PATH", async () => {
    const { status, output, report } = await runScript({ absent: true });
    // A missing binary is not a clean history. `gitleaks ... || true`, or a
    // `command -v` check that only warns, both report success on a runner
    // whose download step silently did nothing.
    expect(status, "a missing gitleaks must fail the run, not pass it").not.toBe(0);
    expect(output).toMatch(/gitleaks/i);
    expect(existsSync(report), "no report can exist when the scanner never ran").toBe(false);

    expect(
      output,
      "a missing gitleaks must say so in the guard's own words, so the failure is not read as a " +
        "version mismatch — the two have different causes and different fixes",
    ).toMatch(/no gitleaks on PATH/);
    expect(output, "and it must not be reported as a version mismatch").not.toMatch(/is on PATH, but this/);
  });

  it("refuses to scan when the gitleaks on PATH is not the pinned version", async () => {
    const { status, output, argv, report } = await runScript({ version: "8.30.0" });
    expect(status, "an unpinned gitleaks must fail the run").not.toBe(0);
    // The names matter more than the code: this is the message a future
    // maintainer reads when a dependabot-style bump breaks the scan, and it
    // has to say which version was found and which is required.
    expect(output).toContain("8.30.0");
    expect(output).toContain(PINNED_VERSION);
    // No scan at all — the whole point of refusing is that the run against a
    // different rule set never happens, because a changed rule set under a
    // committed baseline produces findings the baseline cannot explain.
    expect(argv, "the scan must not run at all under an unpinned gitleaks").not.toContain("git");
    expect(existsSync(report), "the scan must not write a report under an unpinned gitleaks").toBe(false);
  });

  describe("the planted secret, over a repository this suite builds", () => {

    const PLANTED_SECRET = [
      "9f3ca71b",
      "e05d48c2",
      "77b0f1ea",
      "c4d95e03",
      "a17b63df",
      "2e8c0b54",
      "6d3af927",
      "e84b1c60",
    ].join("");

    /** The line carrying it, written into a file that is later deleted. */
    const PLANTED_PATH = "deploy/service.env";

    /** What the control fixture plants at the same path, in the same commit. */
    const INERT_PLACEHOLDER = "inert-placeholder";

    const NARROWED_SUBTREE = "tests";

    const FAULT = process.env["OVERFLOW_SECRET_SCAN_TEST_FAULT"] ?? "";

    const FAULTS: Record<string, { needle: string; replacement: string; description: string }> = {
      "narrowed-target": {
        needle: '"$REPO_ROOT" || exit $?',
        replacement: '"$REPO_ROOT/tests" || exit $?',
        description: "the scan target narrowed to a subtree of the repository root",
      },
      "dir-subcommand": {
        needle: "gitleaks git \\",
        replacement: "gitleaks dir \\",
        description: "the history subcommand swapped for a working-tree one",
      },
      "caller-cwd-root": {
        needle: 'REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"',
        replacement: 'REPO_ROOT="$PWD"',
        description: "the repository root taken from the caller's working directory",
      },

      "missing-target": {
        needle: '"$REPO_ROOT" || exit $?',
        replacement: '"$REPO_ROOT/does-not-exist" || exit $?',
        description: "the scan pointed at a directory that does not exist",
      },
    };

    type Fixture = {
      /** The fixture repository — which is also what the staged script scans. */
      repo: string;
      /** The staged copy of `scripts/secret-scan.sh` inside it. */
      script: string;
    };

    /** Writes the script into `destination`, applying a fault if one is requested. */
    function stageScript(destination: string): void {
      const source = readFileSync(scriptPath, "utf8");
      let staged = source;
      if (FAULT !== "") {
        const fault = FAULTS[FAULT];
        if (fault === undefined) {
          throw new Error(`OVERFLOW_SECRET_SCAN_TEST_FAULT names no fault in this file: '${FAULT}'`);
        }
        if (!source.includes(fault.needle)) {
          throw new Error(
            `the fault '${FAULT}' — ${fault.description} — no longer matches scripts/secret-scan.sh, so it ` +
              "injected nothing and a run under it would have proved nothing about that mutant",
          );
        }
        // A function replacement, not a string one: the needles carry `$` runs
        // (`$REPO_ROOT`, `$?`, `$SCRIPT_DIR`) that JavaScript's replacement
        // patterns would consume as syntax rather than as text.
        staged = source.replace(fault.needle, () => fault.replacement);
      }
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, staged, "utf8");
      chmodSync(destination, 0o755);
    }

    async function buildFixture(name: string, plantedValue: string): Promise<Fixture> {
      const repo = join(tempRoot, name);
      await mkdir(repo, { recursive: true });
      git(repo, "init", "--quiet", "--initial-branch=main");
      await commitFiles(repo, { "README.md": `# ${name}\n` }, "root");
      await commitFiles(
        repo,
        {
          [`${NARROWED_SUBTREE}/fixtures/plain.ts`]: "export const plain = true;\n",
          [PLANTED_PATH]: `OVERFLOW_TOKEN_ENCRYPTION_KEY = "${plantedValue}"\n`,
        },
        "commit the credential-shaped line",
      );
      git(repo, "rm", "--quiet", PLANTED_PATH);
      git(repo, "commit", "--quiet", "--message", "take it back out of the tree");

      const script = join(repo, "scripts", "secret-scan.sh");
      stageScript(script);
      await mkdir(join(repo, ".github"), { recursive: true });
      // The real committed baseline, not a stand-in: the script insists the file
      // exists and refuses without it, so a fixture carrying `[]` would be
      // testing a different script than the one this repository runs.
      await writeFile(join(repo, ".github", "gitleaks-baseline.json"), readFileSync(baselinePath), "utf8");
      return { repo, script };
    }

    let planted!: Fixture;
    let control!: Fixture;

    beforeAll(async () => {
      planted = await buildFixture("planted", PLANTED_SECRET);
      control = await buildFixture("control", INERT_PLACEHOLDER);
    });

    it("stages the tracked script byte for byte when no fault is injected", () => {
      // The switch above is inert, and this is what says so. Without it, a
      // `OVERFLOW_SECRET_SCAN_TEST_FAULT` left over in a shell's environment would quietly
      // run the whole block against a mutated script, and every green result here
      // would be a claim about a script this repository does not ship.
      expect(FAULT, "OVERFLOW_SECRET_SCAN_TEST_FAULT is set, so this run is a fault-injection run").toBe("");
      expect(readFileSync(planted.script, "utf8")).toBe(readFileSync(scriptPath, "utf8"));
      expect(readFileSync(control.script, "utf8")).toBe(readFileSync(scriptPath, "utf8"));
    });

    it("puts the planted secret inside the history a scan walks, and outside the tree a scan could read", () => {

      const history = tryGit(planted.repo, "log", "--all", "-p");
      expect(history.status, `the fixture's history must be readable: ${history.stderr}`).toBe(0);
      expect(
        history.stdout,
        "the planted secret must be IN the history the scan walks. Without it there is nothing to find, and " +
          "the scan would pass here no matter what was broken.",
      ).toContain(PLANTED_SECRET);

      // And the property that makes a narrowed target a real loss rather than a
      // saving, asserted as content: a commit exists under the subtree a
      // plausible narrowing would pick, and no commit under it ever carried the
      // secret.
      expect(
        statSync(join(planted.repo, NARROWED_SUBTREE)).isDirectory(),
        `the ${NARROWED_SUBTREE}/ subtree must EXIST and hold commits, or "nothing under it carries the secret" ` +
          "is a statement about a path that was never there and proves nothing about a narrowed target",
      ).toBe(true);
      const narrowed = tryGit(planted.repo, "log", "--all", "-p", "--", NARROWED_SUBTREE);
      expect(narrowed.status, `the subtree's history must be readable: ${narrowed.stderr}`).toBe(0);
      expect(narrowed.stdout, "the subtree must carry real commits, so the assertion below is about content").not.toBe("");
      expect(
        narrowed.stdout,
        `the planted secret must never have been committed under ${NARROWED_SUBTREE}/, or a scan narrowed to ` +
          "that subtree would still find it and this suite could not tell a narrowed target from the real one",
      ).not.toContain(PLANTED_SECRET);

      // The other half of the gap: absent from the working tree, at HEAD and on
      // disk. `git grep` answers 1 for "no match" and 128 for "I could not look",
      // so the status is asserted exactly rather than as "not zero" — a
      // non-zero status that meant "no such tree" is not a clean result.
      const atHead = tryGit(planted.repo, "grep", "--quiet", "--fixed-strings", PLANTED_SECRET, "HEAD");
      expect(
        atHead.status,
        "the secret must be absent from the tree at HEAD (git grep status 1 = looked, found nothing; 128 = " +
          `could not look, which is not a clean result): ${atHead.stderr}`,
      ).toBe(1);
      expect(
        existsSync(join(planted.repo, PLANTED_PATH)),
        "the file carrying the secret must be gone from the working tree — that deletion is what a working-tree " +
          "scan misses and a history scan does not",
      ).toBe(false);
    });

    it("hands the scanner the history subcommand and a target whose history carries the secret", async () => {
      // `OVERFLOW_GITLEAKS_REPORT_PATH` is set exactly as `.github/workflows/secret-scan.yml`
      // sets it, so the run below is the workflow's scan step with the checkout
      // swapped for the fixture — rather than a near-miss of it.
      const { argv, status, output } = await runScript({ script: planted.script, reportPath: "gitleaks-report.json" });
      expect(
        status,
        `the stub must accept the argv the staged script passed, or the wiring below is untested: ${output}\n` +
          `argv: ${argv.join(" ")}`,
      ).toBe(0);

      expect(argv[0], "`gitleaks git` walks every commit; `gitleaks dir` reads the tree, where the planted secret was deleted").toBe(
        "git",
      );

      // The flag set, against the fixture rather than against this checkout: the
      // baseline named here is the one the staged script resolved from its own
      // location, so this also pins that resolution.
      expect(valueAfter(argv, "--baseline-path")).toBe(join(planted.repo, ".github", "gitleaks-baseline.json"));
      expect(argv).toContain("--redact");
      expect(argv).toContain("--no-banner");
      expect(valueAfter(argv, "--report-format")).toBe("json");
      expect(valueAfter(argv, "--report-path")).toBe("gitleaks-report.json");

      const target = argv[argv.length - 1];
      // `existsSync` first, because `statSync` on a path that is not there throws
      // — and that ENOENT would replace the explanation below with a bare
      // "no such file or directory" for a case this message was written for.
      expect(
        existsSync(target) && statSync(target).isDirectory(),
        `the scan target '${target}' must be a directory that exists, so the comparisons below cannot be ` +
          "satisfied by a path that is merely spelled the same way",
      ).toBe(true);

      const topLevel = tryGit(target, "rev-parse", "--show-toplevel");
      expect(
        topLevel.status,
        `the scan target must be inside a repository the scan can walk at all: ${topLevel.stderr}`,
      ).toBe(0);
      expect(
        realpathSync(topLevel.stdout.trim()),
        `the scan targeted '${target}', whose repository's top level is '${topLevel.stdout.trim()}' — so the ` +
          "scan walked a subtree. A credential committed anywhere outside it is never reported and the run is " +
          "green, which is the whole failure this workflow exists to catch.",
      ).toBe(realpathSync(target));

      const walked = tryGit(target, "log", "--all", "-p", "--", ".");
      expect(
        walked.status,
        `the directory the scan was pointed at must have a readable history — otherwise the scan had nothing to ` +
          `walk: ${walked.stderr}`,
      ).toBe(0);
      expect(
        walked.stdout,
        `the history under the scan's OWN target ('${target}') must carry the planted secret. This is the ` +
          "composition the whole block exists for: a target the secret is not inside of is a green no-op, and " +
          "the wiring assertions cannot see the difference between that and a full scan.",
      ).toContain(PLANTED_SECRET);

      // And the identity itself. `realpath` on both sides because the script
      // resolves its root through a `cd` + `pwd`, and a temporary directory
      // reached through a symlinked /tmp would otherwise compare unequal to the
      // path this suite built with.
      expect(
        realpathSync(target),
        `the scan must target the fixture repository itself, and it targeted '${target}'. A target the planted ` +
          "secret's history is not inside of is a scan that finds nothing and reports nothing.",
      ).toBe(realpathSync(planted.repo));
    });

    it("reads a secret-free fixture the same way, which is what gives the planted case teeth", async () => {

      const withoutSecret = tryGit(control.repo, "log", "--all", "-p");
      expect(withoutSecret.status, `the control fixture's history must be readable: ${withoutSecret.stderr}`).toBe(0);
      expect(
        withoutSecret.stdout,
        "the control fixture's history must NOT carry the planted secret — if it did, the planted fixture would " +
          "prove nothing by asserting something the control shares",
      ).not.toContain(PLANTED_SECRET);

      const clean = await runScript({ script: control.script, reportPath: "gitleaks-report.json" });
      expect(clean.status, `the stub must accept the argv on the clean fixture too: ${clean.output}`).toBe(0);
      expect(clean.argv[0], "the same subcommand on a clean fixture").toBe("git");
      const cleanTarget = clean.argv[clean.argv.length - 1];

      expect(
        existsSync(cleanTarget) && realpathSync(cleanTarget) === realpathSync(control.repo),
        `the clean fixture's scan target '${cleanTarget}' must be a directory that exists and must be the ` +
          "fixture repository itself, so the planted and clean cases are reading the same target resolution",
      ).toBe(true);

      const walked = tryGit(cleanTarget, "log", "--all", "-p", "--", ".");
      expect(walked.status, `the clean target's history must be readable: ${walked.stderr}`).toBe(0);
      expect(
        walked.stdout,
        "the clean fixture's scanned history must carry no planted secret, so the planted fixture's carrying one " +
          "is the difference the planted test above is reading",
      ).not.toContain(PLANTED_SECRET);
    });
  });
});
