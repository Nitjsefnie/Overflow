import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Two contracts for issue 900's history scan, and one honest statement of what
 * this suite does NOT cover.
 *
 * **Covered here:** the committed baseline's integrity (it is the full redacted
 * report gitleaks 8.30.1 requires, and it carries no secret material), and the
 * wiring of `scripts/secret-scan.sh` — the version pin, the git-history mode,
 * `--redact`, the baseline path, the report path, and the pass-through of the
 * scanner's exit code.
 *
 * **Not covered here:** gitleaks' own detection. A test that stubbed out the
 * scanner and then asserted the scanner finds a secret would prove that the
 * test wrote the expected string into its own fixture, so this suite never does
 * that. Detection is evidenced by the committed baseline itself — 11 findings,
 * every one a test-fixture literal, which is the real scanner's output over the
 * real history — and by the end-to-end demonstration recorded in the pull
 * request body: a high-entropy token planted in a past commit makes the same
 * script exit nonzero, and a clean history makes it exit 0.
 */

const PINNED_VERSION = "8.30.1";

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
    // The assertion that catches a baseline regenerated without --redact. That
    // regeneration is otherwise a plausible, quiet mistake: the scan still
    // passes, the file still parses, and the fixture literals that tripped the
    // rules are now readable in a tracked file.
    //
    // `Secret` is redacted wholesale, so it is exactly the literal REDACTED.
    //
    // `Match` is NOT, and this is measured rather than assumed. gitleaks 8.30.1
    // substitutes the redaction into the secret's place inside the match and
    // keeps the surrounding source-line context. A `gitlab-pat` finding's match
    // IS the token, so it comes out as the bare literal REDACTED; a
    // `generic-api-key` finding's match is the assignment around it, so the
    // four such entries read `TOKEN_ENCRYPTION_KEY", "REDACTED"` and
    // `encrypted_webhook_secret","REDACTED"`. So the two fields are asserted
    // differently, and the second one is the one that would otherwise have
    // looked untidy and been "corrected" by a hand-edit — which would break the
    // whole-record comparison the baseline exists to drive, because gitleaks
    // would then never produce a record equal to the one on file.
    for (const finding of findings) {
      expect(finding.Secret, `Secret for ${finding.Fingerprint}`).toBe("REDACTED");
      expect(
        finding.Match,
        `Match for ${finding.Fingerprint} still carries the secret; without --redact this field is the token`,
      ).toContain("REDACTED");
    }
  });

  it("keeps BOTH Match shapes gitleaks 8.30.1 emits, rather than normalising them to one", () => {
    // The guard against the specific trim the script's header warns about. A
    // hand-editor who reads "the baseline is redacted" and tidies every Match
    // down to the bare literal produces a file that still parses, still has
    // every Secret redacted, and still passes every assertion above — and
    // suppresses NOTHING, because gitleaks compares the baseline by whole-record
    // equality and would emit `TOKEN_ENCRYPTION_KEY", "REDACTED"` for a
    // generic-api-key finding, not `REDACTED`. The scan then exits 1 on a
    // history that is clean, and the failure reads as a leaked secret.
    //
    // Both shapes are required: a rule whose match IS the secret redacts to the
    // bare literal, and a rule whose match is an assignment around the secret
    // keeps the assignment. Present in the current baseline, both are.
    //
    // This is coupled to the rule set the pinned version ships, and that is the
    // point rather than a flaw: the version pin exists precisely so the baseline
    // and the rules that produced it move together, and a scanner bump that
    // changes these shapes should fail here at the same moment the baseline is
    // regenerated — not silently afterwards.
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
    // Belt and braces for the assertion above. A character-count bound alone is
    // not enough here and this suite shipped one that was not: the longest
    // identifier-shaped run 8.30.1 actually leaves behind is
    // `encrypted_webhook_secret` (24 characters), and a real 20-character
    // GitLab PAT sits comfortably under that, so a bound read off the data
    // cannot separate them. Splicing a 24-character `glpat-` token beside a
    // redaction passed a 28-character bound.
    //
    // The token itself is NOT written out here, and that is not squeamishness:
    // it would be a credential-shaped literal in a tracked file, which is
    // exactly what .github/workflows/secret-scan.yml exists to report. Writing
    // it into this comment is how the demonstration below found one in this
    // file on its first run. The rule needs the high-entropy body, so a
    // placeholder that is merely described is both safe and sufficient to make
    // the point.
    //
    // What does separate them is PROVENANCE, and it is checkable: every
    // identifier-shaped run the redaction leaves behind is a verbatim slice of
    // the source line at the commit, file and line this entry records. Source
    // context came from there. Spliced-in credential material did not, and
    // wherever it was pasted it will not be found at the coordinates this entry
    // claims.
    //
    // Note the run is not the whole residue. gitleaks also redacts the string
    // literal ADJACENT to the matched one, so the residue of a `generic-api-key`
    // finding reads `TOKEN_ENCRYPTION_KEY", ""` — the identifier, then the
    // punctuation of the two literals with the inner value gone. Only the
    // identifier runs are contiguous in the source line, and only they are
    // checked; the punctuation between them cannot be a credential.
    const sources = new Map<string, string[]>();
    for (const finding of findings) {
      const key = `${finding.Commit}:${finding.File}`;
      if (!sources.has(key)) {
        const blob = spawnSync("git", ["show", `${key}`], { encoding: "utf8" });
        expect(blob.status, `the baseline names ${key}, which must exist in this repository's history`).toBe(0);
        sources.set(key, blob.stdout.split("\n"));
      }
      const line = sources.get(key)![finding.StartLine - 1] ?? "";
      for (const run of finding.Match.replaceAll("REDACTED", "").match(/[A-Za-z0-9_]+/g) ?? []) {
        expect(
          line,
          `${finding.Fingerprint} leaves '${run}' around the redaction, and it does not appear in ` +
            `${finding.File} line ${finding.StartLine} at commit ${finding.Commit}. Whatever is there is ` +
            "not source context — it is material spliced into the baseline, and a length bound cannot " +
            "tell that apart from an identifier.",
        ).toContain(run);
      }
    }
  });

  it("bounds what the redaction can leave, to what 8.30.1 actually emits", () => {
    // The character-count bound the provenance check above replaces, kept with
    // its bound TIGHTENED to the measured maximum rather than given headroom:
    // the longest identifier-shaped run in the current baseline is
    // `encrypted_webhook_secret` at 24 characters, so 24 is the whole of the
    // allowance. This is deliberately not the load-bearing assertion — it is the
    // cheap first filter, and the fact that it cannot by itself tell a
    // 20-character token from a 20-character identifier is why the provenance
    // check exists beside it.
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
    /** A GITLEAKS_REPORT_PATH to set, or undefined for the script's own default. */
    reportPath?: string;
  };

  type RunResult = {
    status: number | null;
    output: string;
    argv: string[];
    /** The report the script wrote, resolved against the directory it ran in. */
    report: string;
  };

  /**
   * The stub gitleaks. It records its own argv, answers `version`, and accepts
   * the `git` subcommand ONLY in the shape the script is supposed to use — the
   * report format must be json, a report path and a baseline path must both be
   * present, the named baseline must exist, and a scan target must be given.
   * Any other argv exits 3 with a message naming the discrepancy, so a script
   * that mis-wires the command produces a nonzero exit and a failed assertion
   * rather than plausible-looking data.
   */
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

  /**
   * Run the real script with a stub gitleaks first on PATH, from a throwaway
   * working directory. The script resolves the repository root from its own
   * location, so the working directory it runs in only decides where an
   * unqualified report path lands — which is what makes the default-report
   * assertion below possible without writing into the repository.
   */
  async function runScript(config: StubConfig = {}): Promise<RunResult> {
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
    for (const key of ["GITLEAKS_REPORT_PATH", "STUB_ARGV_FILE", "STUB_VERSION", "STUB_EXIT"]) {
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
    if (config.reportPath !== undefined) env.GITLEAKS_REPORT_PATH = config.reportPath;

    const result = spawnSync("bash", [scriptPath], { cwd: workDir, env, encoding: "utf8" });
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

  it("selects git-history mode and never a directory scan", async () => {
    const { argv, status, output } = await runScript();
    expect(status, `the stub accepted the argv the script passed: ${output}`).toBe(0);
    expect(argv, "gitleaks must be invoked as `gitleaks git`, or the history is never walked").toContain("git");
    // `dir` is the other subcommand that takes a path. A script that swapped
    // `git` for `dir` would scan the checkout and still exit 0 while every
    // committed-and-then-deleted secret stayed invisible — a green no-op.
    expect(argv, "`gitleaks dir` scans the working tree, not the history").not.toContain("dir");
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
    // Pinned to THIS diagnostic, not to a nonzero exit, because that is the
    // whole reason the `command -v` guard exists next to the version check: the
    // two are different faults with different fixes. "no gitleaks on PATH" is a
    // build or wiring problem — the install step did not put a binary where a
    // later step can resolve one, which is what a job that extracted into the
    // workspace and exported nothing looks like. "X is on PATH, but this script
    // is pinned to Y" is a dependency problem, and the fix is a deliberate
    // version bump plus a baseline regeneration. Deleting the guard collapses
    // both into the second message, so the wiring fault gets diagnosed as a
    // scanner upgrade.
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
});
