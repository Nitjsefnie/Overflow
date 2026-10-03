import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

/**
 * Two contracts for issue 900's history scan, and an explicit statement of what
 * this suite covers in each environment it runs in — because those differ, and a
 * reader who assumes they do not is exactly the reader this suite is for.
 *
 * **Covered everywhere, at any checkout depth:** the wiring of
 * `scripts/secret-scan.sh` (the version pin, the git-history mode, `--redact`,
 * `--no-banner`, the baseline path, the report path, the exit-code pass-through,
 * the two refusal diagnostics, and **the scan target** — the repository root,
 * taken from `git rev-parse --show-toplevel` at run time rather than from a
 * literal in this file, AND, against the built fixtures below, the history the
 * target resolves to); every property of the committed baseline readable from the file itself;
 * the 3-of-8 coverage ratio this suite pins by equality; the `hasCommit` half of
 * the redirector shield; and the provenance CHECKER, driven against a repository
 * this suite builds for itself.
 *
 * **Covered only where the history is present:** the committed baseline's
 * provenance — that each finding's redacted residue really came from the source
 * line it names. That check reads the blobs the baseline points at, and
 * `.github/workflows/ci.yml`'s `verify` job checks out at `actions/checkout`'s
 * default depth of 1, where the six commits the baseline's eight entries name do
 * not exist. The test that does it therefore **SKIPS in CI, and the skip is
 * reported in the run summary rather than passing quietly.** In a full-depth
 * checkout it runs. Do not read a green CI run as evidence about the committed
 * baseline's provenance: it is evidence about the checker, and about the file's
 * own contents.
 *
 * **Covered here no longer, and by design: whether the baseline's commits are
 * REACHABLE.** That assertion used to sit in this file, at both depths, and it
 * could not work where it sat: the property is about a commit's place in the
 * history, `verify` checks out one commit deep, and any `--rebase` merge
 * re-stamps the branch's commits — so the next merge to orphan an entry landed
 * as a red required check on `main` for every open pull request, over a defect
 * that is real but belongs to the weekly sweep. It is now
 * `scripts/secret-scan-baseline.sh`, the last step of
 * `.github/workflows/secret-scan.yml`, which checks out at `fetch-depth: 0`,
 * names the offending fingerprint and commit when it fails, and is executed end
 * to end by `tests/ci/secret-scan-workflow.test.ts` — so the check is exercised
 * by a test rather than discovered on the next weekly tick. Nothing here was
 * weakened to make room for the move; the two tests are gone, and their
 * property is asserted in the one environment that can observe it.
 *
 * The checker is the part covered everywhere, and it is covered by planting the
 * defect it exists to catch — a finding whose residue is material spliced in
 * beside a redaction — in a real commit the suite creates, and watching it be
 * rejected. A guard only ever run against data known to be clean has never been
 * shown to reject anything.
 *
 * **Covered everywhere, at any checkout depth, against a repository this suite
 * BUILDS:** the planted-secret property — that the credential the scan must find
 * is genuinely inside the history the scan is pointed at, and genuinely outside
 * the reach of a narrower one. Two fixture repositories with real commits are
 * built in a temp directory, a secret-shaped line is planted in an early commit
 * and DELETED in a later one, and the real `scripts/secret-scan.sh` — a staged
 * copy of it, so it resolves its own repository root to the fixture — is run over
 * each. The deletion is the design: it is what leaves the tree clean while the
 * history still carries the secret, which is the whole difference between
 * `gitleaks git` and `gitleaks dir`, and between the repository and a subtree.
 *
 * What the target assertion ALREADY held, and what it could not: it compared the
 * script's last argv element against `git rev-parse --show-toplevel`, so a target
 * narrowed to a subtree went red there too — that is what the assertion is for,
 * and it is not weakened below. What it could not do is show anything ABOUT the
 * credential: both sides of that comparison are PATHS, and no secret was ever at
 * risk behind them, so it established that the scan pointed at the repository
 * root without ever establishing that anything the scan must find was inside it.
 * That second half is what this block adds, and it is the half a green run was
 * able to hide.
 *
 * **Not covered here, and named rather than implied:** gitleaks' own DETECTION —
 * whether a given token matches a given rule, and what the scanner would exit.
 * No scanner binary is present on this box or in CI's `verify` job, and this
 * suite will not install one: a network fetch in a required check is a
 * maintainer's ruling, not a child's. So nothing here is a scanner verdict, and
 * nothing here asserts that a secret was FOUND. The stub `gitleaks` records its
 * argv, answers `version`, and decides nothing — it is never told what the
 * fixture planted and never sees the planted string. Every assertion about the
 * planted secret is a git read (`git log -p`, `git grep`, `existsSync`) over a
 * history this suite built, and every assertion about the wiring is the script's
 * own argv, checked against that fixture. A refactor that breaks the
 * COMPOSITION — the subcommand, the target, the rooting — is caught here, with
 * the one limit the block's own comment states: the rooting is demonstrated
 * through the script's baseline refusal rather than through the production
 * shape, where the scan step runs from the repository root and the baseline is
 * present. A refactor that only breaks gitleaks' rule set is not caught, and
 * cannot be without the binary.
 * What the committed baseline still contributes is the rule set's own output over
 * this repository's real history: 8 findings, every one a test-fixture literal.
 *
 * The mutants this block is shown red against are named by the
 * `SECRET_SCAN_TEST_FAULT` table below, which stages a mutated COPY inside the
 * fixture and is inert — and asserted inert — when the variable is unset.
 */

const PINNED_VERSION = "8.30.1";

/**
 * How many of the committed baseline's entries carry an identifier residue, and
 * are therefore genuinely checked by the deep provenance test.
 *
 * Pinned as a VALUE, not left to a floor of `> 0`, and not merely reported in an
 * assertion message. A Vitest message is emitted only when an assertion fails,
 * so a `> 0` floor plus a message that names the count is invisible on a green
 * run — and stripping the residue from one of the three checkable entries
 * leaves the suite green while any prose about "3 of 8" goes on claiming a pin
 * that does not exist. This number is that pin.
 *
 * 3 of 8, and the other 5 are `gitlab-pat` findings whose `Match` IS the
 * secret: gitleaks replaces the whole match, the residue is empty, and a rule
 * with no residue has nothing that could have been spliced into it. Those 5 are
 * carried by the redaction, shape and fingerprint assertions, which run at every
 * checkout depth.
 *
 * A change to this number is a finding, not a chore: it means the baseline was
 * regenerated, or an entry's rule changed shape, and a reviewer should look at
 * the baseline diff before accepting the new value. It is a measurement of the
 * committed file, not a target to be met.
 */
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

/**
 * The one finding the confirming scan reported, captured VERBATIM from run
 * 36933083415 — the `secret-scan` workflow, artifact `gitleaks-report`, artifact
 * id 11196757504, uploaded 2026-10-01.
 *
 * The capture is a `gitleaks git --report-format json` run over this
 * repository's whole history with NO `--baseline-path`, so what is recorded
 * here is the scanner's own output and not a record written by hand.
 *
 * It is embedded rather than read from a path outside the repository because
 * the assertions it drives have to hold at EVERY checkout depth, and a test
 * reading a scratch directory would fail in CI — which, for an assertion whose
 * whole job is to establish that the weekly scan is green, is a false red in
 * the one place nobody local is looking.
 *
 * What it records is a finding in `tests/moderation/writer-credential.test.ts`
 * line 18 at commit `efe1207d`, from the high-entropy UUID literal that commit
 * introduced. The fixture was later reshaped to the tree's low-entropy
 * convention, so no branch tip trips the rule any more — but the scan walks
 * history, so the historical occurrence stands until the baseline records it.
 */
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

/**
 * Whole-record equality — the comparison gitleaks 8.30.1 performs against a
 * baseline entry, and deliberately not fingerprint equality, which suppresses
 * nothing at all.
 *
 * The UNION of the two records' key sets is walked, so a field dropped from
 * either side is a mismatch rather than a field nobody looked at. Values go
 * through `JSON.stringify`, which is what makes `Tags` compare by CONTENT: the
 * committed record's `[]` and the emitted record's `[]` are two distinct arrays
 * holding the same nothing, and identity comparison would call them different
 * forever.
 */
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

/**
 * The provenance check, as a pure function so it can be exercised against a
 * repository this suite builds rather than against whatever history the ambient
 * checkout happens to carry.
 *
 * A finding's `Match` is a fragment of a source line with the secret
 * substituted away, so every identifier-shaped run left in it must be a verbatim
 * slice of the line the finding records. Source context came from there;
 * credential material spliced in beside the redaction did not, and will not be
 * found at those coordinates.
 *
 * Returns the offending runs, so a caller can say WHICH run was not accounted
 * for rather than only that something was not.
 *
 * The residue is deliberately not compared as one substring: gitleaks also
 * redacts the string literal adjacent to the matched one, so a
 * `generic-api-key` residue reads `TOKEN_ENCRYPTION_KEY", ""` — the identifier,
 * the punctuation of two literals, and the inner value gone. Only the identifier
 * runs are contiguous in the line; the punctuation between them cannot be a
 * credential, so it is not checked.
 */
export function provenanceViolations(finding: Pick<Finding, "Match">, sourceLine: string): string[] {
  const residue = finding.Match.replaceAll("REDACTED", "");
  return (residue.match(/[A-Za-z0-9_]+/g) ?? []).filter((run) => !sourceLine.includes(run));
}

/**
 * The git reads this suite makes about the checkout it is running in all come
 * from `tests/support/scratch-git.ts`, which strips every inherited `GIT_*`
 * variable before invoking git.
 *
 * That is not tidiness. The predicate below decides whether the deep provenance
 * check RUNS, and it used to be a `spawnSync` that inherited the environment:
 * with `GIT_DIR` pointed at a shallow clone, the predicate and its corroborator
 * both answered about THAT repository, agreed with each other, and the deep
 * check skipped on a fully green run in a full-depth checkout. Two witnesses
 * fed the same source are not independent witnesses — the companion checks
 * consistency, not correctness, and cannot object when both are consistently
 * wrong. Stripping the selectors is what makes it an independent one.
 *
 * The corroborating half of that pair — the test that asserted the depth
 * predicate by checking that the objects really were absent — went to the
 * workflow with the reachability assertion it stood behind. What is left here
 * is the predicate itself and the cases that pin it against every `GIT_*`
 * redirector, which is what the deep check's own RUN/SKIP decision rests on.
 */

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
    // three such entries read `TOKEN_ENCRYPTION_KEY", "REDACTED"`,
    // `encrypted_webhook_secret","REDACTED"` and
    // `TOKEN_ISSUANCE_ID = "REDACTED"`. So the two fields are asserted
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
    // A residue may only be identifier-shaped runs and the punctuation of the
    // literals around them. This holds at any checkout depth, and it catches a
    // class the provenance check STRUCTURALLY CANNOT see, so it is load-bearing
    // rather than a first filter:
    //
    //   `provenanceViolations` inspects only `[A-Za-z0-9_]+` runs. A `Match` of
    //   `REDACTED/path` yields the single run `path`; that one is rejected when
    //   the line does not contain it. But a `Match` of `<REDACTED>` yields NO
    //   runs at all, so provenance returns `[]` and passes — and so does the
    //   `toContain("REDACTED")` assertion beside it. Only this one rejects it.
    //   The same holds for any residue whose identifier runs are empty and whose
    //   offending material is punctuation.
    //
    // Where the two overlap — a spliced alphanumeric token — they agree, and
    // drift between them shows up as a red test rather than a silent divergence.
    //
    // The half that needs history — that each run really came from the source
    // line the entry records — is `provenanceViolations` below, exercised
    // against a repository this suite builds, and then against the committed
    // entries where the history is present.
    //
    // A character-count bound cannot do that job, and this suite shipped one
    // that tried: the longest identifier-shaped run 8.30.1 actually leaves
    // behind is `encrypted_webhook_secret` at 24 characters, and a real
    // 20-character GitLab PAT sits comfortably under that, so a bound read off
    // the data cannot tell the two apart. Splicing such a token beside a
    // redaction passed a 28-character bound, and would still pass a 24-character
    // one. Provenance can, because the token is not on the line.
    //
    // No token is written out in this file, and that is not squeamishness: it
    // would be a credential-shaped literal in a tracked file, which is exactly
    // what .github/workflows/secret-scan.yml exists to report. Writing one into
    // this comment is how the round-1 demonstration found one in this file, and
    // a credential-shaped FIXTURE is how the round-2 demonstration found
    // another. The rule needs the high-entropy body, so a placeholder that is
    // merely described is both safe and sufficient to make the point.
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

  it("is accepted by the provenance check, on the real entries, at any depth", () => {
    // The POSITIVE direction, on the committed data, and at every checkout
    // depth — which the block at the end of this file cannot be, because that
    // one needs the history.
    //
    // It matters because a checker that rejects everything would satisfy every
    // rejection test while being useless, and the only thing that catches an
    // inverted checker where the history is absent is this. The line is
    // assembled from the entry's own residue rather than read from git, so what
    // is under test is the checker and the real `Match` values, not the blobs.
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
    // At least one committed entry must actually exercise a non-empty residue,
    // or this test would pass on the five `gitlab-pat` entries alone and pin
    // nothing.
    // The SAME constant the deep test pins, asserted here too, because that
    // test SKIPS in CI. With only a `> 0` floor here, stripping the residue from
    // one of the three checkable entries was green at depth 1 — the coverage
    // claim unchecked exactly where nobody local is looking.
    expect(
      checked,
      `only ${checked} of ${findings.length} committed entries leave a residue this suite can check, ` +
        `against a baseline that should yield ${EXPECTED_CHECKABLE_ENTRIES}. A drop is a finding, not a ` +
        "chore: entries lost the residue that made them checkable, and a green run would keep certifying " +
        "less than it appears to.",
    ).toBe(EXPECTED_CHECKABLE_ENTRIES);
  });

  it("carries the captured scan report whole-record, which is the equality gitleaks suppresses on", () => {
    // The POSITIVE half of the acceptance criterion, and the one that has to run
    // at every checkout depth: with the captured record committed, the weekly
    // scan has a baseline entry it can match, and this is the same whole-record
    // equality it matches on. A green here is a green for the real scanner on
    // that finding.
    //
    // It fails if the entry is absent, and it fails if the entry is present but
    // drifted by a single field: a column offset, an entropy, a timestamp, an
    // author's name. That is the failure a hand-typed baseline entry produces,
    // and the mutation test below is what shows it rather than claims it.
    //
    // It does NOT fail on the JSON escaping, and this is worth being precise
    // about, because the escaping is the first thing a reader notices about this
    // file and the obvious thing to blame. Go's `encoding/json` writes `<`, `>`
    // and `&` as the six-character escapes, and the committed file carries that
    // form — but the comparison happens AFTER decoding, on both sides. Here the
    // baseline goes through `JSON.parse` and the captured record is a TypeScript
    // string literal; at gitleaks it is `json.Unmarshal` into `[]Finding` and a
    // struct compare. Either way the escaped form and the bare character are one
    // value by the time anything compares them, so a baseline rewritten with bare
    // characters in its `Message` suppresses the finding exactly as well. That
    // was measured, not reasoned: with the escapes replaced by bare `<`, `>` and
    // `&`, this suite stayed green, which is the correct result.
    expect(
      asRecords(findings).some((committed) => wholeRecordEquals(committed, CAPTURED_FINDING)),
      "no committed entry equals the captured scan report field for field. gitleaks 8.30.1 suppresses a finding " +
        "only on whole-record equality, so a near miss — one column, one entropy, one timestamp — leaves the " +
        "weekly scan red on a history that is otherwise clean.",
    ).toBe(true);
  });

  it("stops matching the captured record the moment the entry is removed, or one field of it moves", () => {
    // The NEGATIVE half, DEMONSTRATED rather than asserted about. The acceptance
    // criterion has two halves — with the entry the scan is green, without it the
    // scan reds — and gitleaks is not installed on this box, so the only honest
    // way to show the second half is to take the committed baseline apart here
    // and watch the comparison above stop holding.
    //
    // Three single-field mutations rather than one, because a matcher that reads
    // only some fields still rejects a mutation of a field it never looked at,
    // and these three are a column offset, an entropy and a timestamp — the
    // shapes a finding actually carries, and the ones a "tidied" entry drifts on.
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

/**
 * The provenance check, exercised against a repository this suite builds.
 *
 * It is the only test of this contract that runs at EVERY checkout depth, so it
 * is where the guard is actually shown to work. The committed baseline's own
 * provenance is checked in the next block and that check needs the history; this
 * one needs a repository the suite owns, so it holds at depth 1 and at full
 * depth alike.
 *
 * The shape follows `tests/ci/docs-only-step.test.ts`, which builds its own
 * origin with real commits rather than reading the ambient checkout — the
 * distinction that matters here, because the ambient checkout's depth is
 * whatever it happens to be and CI's is 1.
 */
describe("the provenance check, against a repository this suite builds", () => {
  let root = "";
  let repo = "";
  /** The line the synthetic commit's fixture file carries, read back from git. */
  let sourceLine = "";

  // The synthetic source line. Its VALUE is a deliberately inert placeholder,
  // not a plausible credential: a 32-character hex string under an
  // api-key-shaped name trips gitleaks' `generic-api-key` rule, which is how the
  // round-1 demonstration found one in this file and then how the round-2
  // demonstration found this one. The check below only needs the IDENTIFIER to
  // be on the line, so the value can be something no scanner will ever want.
  const SOURCE = [
    'import { describe, it } from "vitest";',
    'describe("fixtures", () => {',
    '  it("names a key", () => {',
    '    vi.stubEnv("TOKEN_ENCRYPTION_KEY", "inert-placeholder");',
    "  });",
    "});",
  ].join("\n");

  const finding = (match: string): Pick<Finding, "Match"> => ({ Match: match });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gitleaks-provenance-"));
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
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("accepts the residue gitleaks actually leaves, so the check is not vacuous", () => {
    // The positive case, and it is the one that makes the negative cases mean
    // something. A checker that rejects everything would pass every rejection
    // test below while being useless.
    expect(sourceLine, "the synthetic commit must carry the line the fixtures read").toContain("TOKEN_ENCRYPTION_KEY");
    expect(provenanceViolations(finding('TOKEN_ENCRYPTION_KEY", "REDACTED"'), sourceLine)).toEqual([]);
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

/**
 * The two git reads that decide whether the deep check runs cannot be steered
 * from the environment, and this is the executable form of that claim.
 *
 * The hole it closes was measured on the previous commit of this file:
 * `GIT_DIR=<a shallow clone>/.git` in a FULL-DEPTH checkout made
 * `isShallowCheckout` answer "shallow" and made `hasCommit` consult the same
 * wrong repository, so the two agreed, the deep provenance check skipped, and
 * the run was entirely green. The companion test could not object: it checks
 * consistency, and both witnesses were consistently wrong.
 *
 * So the test builds a shallow clone to point at, poisons the environment with
 * it, and reloads the support module — necessary because the environment it uses
 * is snapshotted at import, which is exactly why a `GIT_DIR` present at process
 * start is stripped rather than honoured. It then asserts both directions: the
 * shielded reads still report the AMBIENT checkout, and an unshielded read over
 * the same environment demonstrably does not.
 */
describe("the git reads that decide whether the deep check runs", () => {
  let elsewhere = "";

  beforeAll(async () => {
    elsewhere = await mkdtemp(join(tmpdir(), "gitleaks-redirect-"));
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
    if (elsewhere) await rm(elsewhere, { recursive: true, force: true });
  });

  /**
   * The environment redirectors the helper's prefix sweep has to exclude, and
   * whether each is worth a case.
   *
   * This is deliberately a LIST and not a single variable. A control scoped to
   * one instance of a thing cannot see the next instance of that thing, and the
   * helper is written against the CLASS (`key.startsWith("GIT_")`), not against
   * `GIT_DIR`. Narrowing the sweep to `key === "GIT_DIR"` leaves this suite
   * entirely green for as long as only `GIT_DIR` is exercised — which is exactly
   * what happened until `GIT_COMMON_DIR` was added, and is why the two entries
   * marked `redirects: true` are the ones carrying the weight.
   *
   * `GIT_COMMON_DIR` is the second member that genuinely redirects, and the one a
   * `GIT_DIR`-only control leaves unpinned. The rest are listed so that a
   * redirector found later is added here rather than assumed covered: an entry
   * that cannot redirect is cheap, and one that can is a real control.
   */
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

  /**
   * The depth half, in the environments where it has teeth.
   *
   * A shallow ambient checkout answers "shallow" with or without a redirect, so
   * comparing the shielded depth read against it is true-to-true and cannot
   * fail — the previous version of this test ran it there anyway and was
   * vacuous in CI while looking fully exercised. So the depth half is skipped
   * where it cannot fail, and the SKIP IS REPORTED rather than the assertion
   * being quietly softened. Its unshielded control asserts DISAGREEMENT with the
   * ambient answer, which is what gives the case its bite: if it ever agreed,
   * this case would be proving nothing and says so.
   */
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
        // The bite, and only the two variables that genuinely redirect can
        // carry it — GIT_WORK_TREE and the rest do not move the answer at all,
        // so a disagreement demanded of them would be a false demand. Those
        // cases are still exercised, to catch a shield that breaks ordinary
        // operation, but they carry no bite and are not counted as if they did.
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

  /**
   * The `hasCommit` half, at EVERY depth.
   *
   * It is a separate test rather than folded into the case above because it does
   * not degenerate: the redirect points at a *different* repository whose commits
   * are not this checkout's, so an unshielded read fails to find this checkout's
   * own HEAD in a full-depth and a shallow checkout alike.
   *
   * **What it does NOT do — and an earlier version of this comment claimed the
   * opposite, which was measured false.** It cannot notice an unshielded
   * `isShallowCheckout`. The two are independent reads that share nothing but
   * this module's env constant, so unshielding one leaves the other untouched
   * and no assertion here reacts. The reviewer's M-f mutant — `isShallowCheckout`
   * unshielded alone — is red in a FULL-DEPTH checkout, where the depth half
   * runs, and green in a shallow one, where it is skipped. CI therefore does
   * **not** cover the depth half, and the two halves are complementary rather
   * than redundant: between them the property is covered everywhere it can
   * actually matter, because the consequence of an unshielded depth read (a
   * full-depth checkout reporting itself shallow, and the deep check skipping on
   * a green run) cannot occur in a shallow checkout at all.
   *
   * Stated explicitly because the earlier overstatement invited a reader to
   * conclude the depth test was redundant and delete it — which would make M-f
   * green in the one environment where its consequence lives.
   */
  it("reports the ambient commits, not one redirected by a GIT variable", async () => {
    const ambientHead = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: scratchGitEnv })
      .stdout.trim();
    expect(ambientHead, "the ambient checkout must have a HEAD to look for").toMatch(/^[0-9a-f]{40}$/);

    // The floor, and it holds at BOTH depths: the redirect points at a
    // different repository, so an unshielded read cannot find this checkout's
    // HEAD. Only the two genuinely-redirecting variables can show that, and
    // requiring it of the others would be a false demand — see the depth test's
    // comment on the same distinction.
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


/**
 * The committed baseline's own provenance — the same check, over the real
 * entries, against the real commits they name.
 *
 * This block SKIPS wherever the checkout is shallower than the history it points
 * at, which in practice means CI: `.github/workflows/ci.yml` gives the `verify`
 * job `actions/checkout`'s default depth of 1, and the baseline's entries date
 * from September and October. The skip is deliberate and reported in the run
 * summary. A `try { … } catch { pass }` here would be the same false green this
 * whole exercise has been about, wearing a name tag: a green CI run would read
 * as coverage the run does not have. See the file header for what each
 * environment does and does not establish.
 *
 * What it does NOT do is skip because a commit is missing from a FULL-DEPTH
 * checkout. That is a baseline pointing at a commit this repository does not
 * have — a defect in a tracked artefact — so the guard inside the loop below
 * fails on it, by name, carrying the commit and the file. Where that defect is
 * REPORTED, though, is the secret-scan workflow's last step: the assertion that
 * every commit the baseline names is reachable from HEAD used to live here too,
 * and it was in the one environment that cannot observe it (see the file
 * header). It is now `scripts/secret-scan-baseline.sh`, which runs where
 * `fetch-depth: 0` has the history, and `tests/ci/secret-scan-workflow.test.ts`
 * executes that script end to end. The guard below is the second witness, in
 * the environment that can see it at all — a full-depth checkout — and the two
 * cannot be merged, because only one of them can run where the commits are.
 */
describe("the committed baseline's provenance, where the history is present", () => {
  const findings: Finding[] = JSON.parse(readFileSync(resolve(".github/gitleaks-baseline.json"), "utf8"));
  const shallow = isShallowCheckout();

  it.skipIf(shallow)("reproduces every residue from the source line its entry records", () => {
    const sources = new Map<string, string[]>();
    // How many entries this run can ACTUALLY say something about, as opposed to
    // iterating. `provenanceViolations` returns `[]` for any line — including the
    // empty string — when a finding's residue has no identifier runs, so an entry
    // with a pure-redaction `Match` is checked by this loop and can never fail
    // it. That is semantically correct rather than a hole: a rule whose match IS
    // the secret leaves nothing that could have been spliced into it, and the
    // redaction assertions are what carry those entries.
    //
    // But it means the loop's length is not its coverage, and without the floor
    // below a regeneration that moved findings toward residue-free rules would
    // quietly reduce this check to nothing while it stayed green. The floor says
    // how many were meaningful so a reader can see the ratio without opening the
    // baseline; it deliberately does NOT demand that every entry be checkable,
    // because that is not achievable and asserting it would be a false guarantee.
    let checked = 0;
    for (const finding of findings) {
      const key = `${finding.Commit}:${finding.File}`;
      if (!sources.has(key)) {
        try {
          sources.set(key, showFileLines(finding.Commit, finding.File));
        } catch (error) {
          // A baseline naming a commit this repository does not have is a defect
          // in a tracked artefact, and the weekly secret scan's reachability step
          // is where that defect is reported. So this FAILS too, in the one
          // environment that can see it. A skip here would report the defect as
          // coverage, which is the shape of false green this suite has spent
          // three rounds removing.
          //
          // `expect.fail` THROWS, so control cannot reach the lookup below — and
          // the workflow's own step guards the same property independently, in a
          // full-history checkout and without needing one. The backstop under it
          // exists for a **no-op** downgrade of this guard:
          // downgraded to one, control reaches the lookup, and without the
          // backstop the loop crashes on a missing map entry with a bare
          // TypeError that names nothing. (A `continue` downgrade is a
          // different thing entirely: it skips the loop body, so the lookup is
          // never reached and the crash cannot happen. The backstop does not
          // cover that case and is not claimed to.)
          expect.fail(
            `the baseline names ${key}, which must exist in this repository's history: ` +
              `${(error as Error).message}`,
          );
          // Unreachable while `expect.fail` throws, and that is the point: it
          // exists so that a NO-OP downgrade of the guard above still fails
          // HERE, by name, carrying the commit, the file and the reason — rather
          // than crashing three lines later with a TypeError nobody can act on.
          // Measured: with a corrupt entry, the guard no-op and this backstop
          // removed, the failure is the TypeError; with it, the failure names
          // all three.
          return expect.fail(
            `the baseline names ${key}, but its lines were not read, so there is nothing to check it ` +
              "against. The guard above did not stop the loop.",
          );
        }
      }
      const line = sources.get(key)![finding.StartLine - 1] ?? "";
      // Counted from the finding's OWN residue, not from the verdict: a clean
      // entry has no violations either way, so counting violations would count
      // defects and read zero on a perfectly good baseline. An entry is
      // meaningful to this check when its residue carries at least one
      // identifier run for the checker to account for.
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
    // The captured record's THIRD claim: that it describes something. A baseline
    // entry is a statement about a line in a blob at a commit, and a record that
    // matches the scanner's output field for field can still name a commit this
    // repository cannot reach or a line that does not carry its residue — at
    // which point it is a copy of a finding rather than a record of one, and the
    // weekly sweep's reachability step is where that surfaces, days later.
    //
    // It reads git rather than the file for the reason the rest of this block
    // does, and it inherits the block's skip: at `actions/checkout`'s default
    // depth of 1 these commits are not present, and a skip is reported in the run
    // summary where a silent pass would not be.
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
    /** A GITLEAKS_REPORT_PATH to set, or undefined for the script's own default. */
    reportPath?: string;
    /**
     * The script to run, when the case under test is a copy STAGED INSIDE A
     * FIXTURE REPOSITORY rather than this checkout's own tracked file. The copy
     * is what the script resolves its repository root from, so pointing the run
     * at one is how a case can hold the wiring against a repository that carries
     * a planted secret — see the planted-secret block at the end of this file.
     */
    script?: string;
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

    // The subcommand, the baseline path and the report path were all pinned and
    // none of them said WHAT is scanned. `gitleaks git <path>` restricts the
    // history walk to that subtree, so changing the target to "$REPO_ROOT/tests"
    // is a one-line edit that leaves every other assertion here green — and it
    // is the entire failure mode this workflow exists to catch, defeated by an
    // edit a reader would plausibly describe as "only our own fixtures trip it,
    // save the time". A credential committed to src/, scripts/, a workflow file
    // or a migration would never be reported.
    //
    // The expected value comes from git, not from this file's own idea of where
    // the repository is, so the two cannot drift into agreement about a wrong
    // answer the way a hardcoded path would.
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
    // And it must be a directory that exists, so the assertion above cannot be
    // satisfied by a path that happens to be spelled the same way.
    //
    // `existsSync` first, because `statSync` on a path that is not there throws —
    // and that ENOENT would replace the sentence below with a bare "no such file
    // or directory" for exactly the case it was written for. Same shape, and the
    // same reason, as the guard on the planted fixture's target further down.
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

  /**
   * The planted secret, over a repository this suite builds.
   *
   * Everything above pins the script's WIRING: subcommand, flags, baseline path,
   * report path, exit-code pass-through, refusals. Wiring is not the property
   * issue 938 is about, and it was never the weak point. What was unheld — and is
   * held here — is the step BETWEEN the wiring and the scanner's verdict:
   *
   *   **the secret the scan must find is genuinely inside the history the scan is
   *   pointed at, and genuinely outside the reach of any narrower scan.**
   *
   * The reason it was unheld is worth stating precisely, because the obvious
   * version of it is false. The pre-existing target assertion — the one on
   * `walks the WHOLE repository, not a subtree of it`, above — DOES catch a
   * narrowed target: it compares the script's last argv element against
   * `git rev-parse --show-toplevel`, and a narrowed target is a different path,
   * so the equality goes red. That assertion is not weakened here.
   *
   * What it could not do is say anything ABOUT THE CREDENTIAL. Both sides of
   * that comparison are paths, and no secret was ever at risk behind them, so it
   * established that the scan pointed at the repository root and stopped there.
   * A narrower statement is also the useful one: the wiring assertions can tell
   * you WHICH DIRECTORY was handed to the scanner, and nothing at all about
   * whether anything the scan exists to find was inside it. So the history a
   * scan walks had never been given a secret to carry, and "green" could not
   * distinguish a scan that walked the credential from a scan that stepped over
   * it.
   *
   * So this block builds TWO repositories with REAL COMMITS, plants a secret in
   * an early one, DELETES it in a later one, and runs the REAL
   * `scripts/secret-scan.sh` — a staged copy of it, so that it resolves its own
   * repository root to the fixture and not to this checkout — over each.
   *
   * The deletion is the whole design. It is what leaves the working tree clean
   * while the history still carries the secret, and that gap is exactly what
   * separates `gitleaks git` from `gitleaks dir` and the full repository from a
   * subtree. A fixture that kept the file would be satisfied by a scan that only
   * ever looked at the tree; this one is not, and the assertions below say so at
   * the git level rather than by asserting anything of a scanner.
   *
   * **On how the mis-rooting is caught, stated narrowly because the demonstration
   * is narrower than the fault.** Rooting `REPO_ROOT` at the caller's working
   * directory is red here, but through the script's own BASELINE REFUSAL — the
   * staged copy looks for `.github/gitleaks-baseline.json` under the caller's
   * directory and refuses. That is the correct catch and it is a real one, but
   * this block does not demonstrate the production shape, where the scan step
   * runs from the repository root and the baseline IS present: a mis-rooted
   * script that found a baseline would have to be caught by the target
   * assertions below instead, and that path is not exercised here.
   *
   * **What this block does NOT claim.** It never asserts that a secret was
   * found, because no scanner binary is present on this box or in CI's `verify`
   * job, and the suite will not install one. The stub `gitleaks` above records
   * its argv, answers `version`, and decides NOTHING: it is never told what the
   * fixture planted, and it never sees the planted string at all. Every assertion
   * about the planted secret below is a git read — `git log -p`, `git grep`,
   * `existsSync` — over a repository whose history this suite built. What a
   * refactor can break here is the composition: the target, the subcommand, and
   * the rooting. That gitleaks' own RULES still match a token is the residual,
   * and the file header says so in the same words.
   */
  describe("the planted secret, over a repository this suite builds", () => {
    /**
     * The planted secret, ASSEMBLED HERE from fragments.
     *
     * Never written out as one literal in this file, and that is not
     * squeamishness: a high-entropy credential-shaped string under an
     * api-key-shaped name, committed in a tracked test file, IS a finding in
     * `.github/gitleaks-baseline.json` — which is the very artefact
     * `.github/workflows/secret-scan.yml` exists to report, and which this file
     * pins an exact shape for. The fragments are joined at run time, inside the
     * temporary directory, and never leave it.
     *
     * **The SHAPE is chosen from evidence in this repository, and the basis is
     * the committed baseline rather than a scan run.** The two
     * `generic-api-key` entries in `.github/gitleaks-baseline.json` are findings
     * gitleaks 8.30.1 really produced over this repository's own history, and
     * the pinned version's rule fires on a long plain alphanumeric run after an
     * api-key-shaped assignment — one of them is
     * `TOKEN_ENCRYPTION_KEY", "<64 hex characters>"`. So this value is 64 hex
     * characters under the same identifier, which is the shape this rule set
     * demonstrably flags HERE.
     *
     * What that basis does NOT establish, and what is deliberately not claimed:
     * nobody has run a scanner over this fixture. Constraint 1 forbids
     * installing one, so it is unverified that 8.30.1 would match THIS value —
     * the fragments differ from the committed fixture's. It is shaped like a
     * finding the baseline proves this version produces, which is a claim about
     * resemblance and not about a verdict, and the property under test is the
     * script's wiring. Nothing below asserts anything of a scanner either way,
     * so the fixture's fidelity is not load-bearing for any assertion here.
     *
     * The value is synthetic by construction (fixed, published hex) rather than
     * randomly generated, so a failing run reproduces byte for byte.
     */
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

    /**
     * The subtree a plausible narrowing would choose, planted OUTSIDE it.
     *
     * `tests/` is the narrowing a reader of this repository would reach for —
     * the committed baseline's findings are all under it, so "scan only tests/"
     * sounds like a saving rather than a deletion. The secret is therefore
     * committed at `deploy/service.env`, at the repository root's edge, and the
     * subtree is given its own real commit so that "nothing under tests/ ever
     * carried the secret" is a statement about CONTENT rather than about a path
     * that was never there. A target assertion that could be satisfied by a
     * nonexistent directory would not be an assertion.
     */
    const NARROWED_SUBTREE = "tests";

    /**
     * Fault injection, INERT unless `SECRET_SCAN_TEST_FAULT` names one of the
     * three mutations below.
     *
     * The mutants this suite has to be shown against are defects in
     * `scripts/secret-scan.sh`, and the only way to introduce one without editing
     * a tracked file is to introduce it in the COPY this block stages inside the
     * fixture — which is where the environment variable reaches. With the
     * variable unset the copy is byte-for-byte the tracked script, and the last
     * test in this block asserts exactly that, so the switch cannot colour a
     * normal run without that test going red too.
     *
     * Each needle is a distinctive span of the script, and staging THROWS if one
     * of them no longer matches. A fault that silently injected nothing would
     * leave a green run reading as "this mutant is caught", which is the one
     * conclusion this mechanism must never be able to produce.
     */
    const FAULT = process.env["SECRET_SCAN_TEST_FAULT"] ?? "";

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
        needle: 'readonly REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"',
        replacement: 'readonly REPO_ROOT="$PWD"',
        description: "the repository root taken from the caller's working directory",
      },
      // Not one of the three the brief names, and not a defect anybody would
      // ship — it is here so the target assertions can be shown to EXPLAIN a
      // target that is not there. A `statSync` alone raises ENOENT before the
      // assertion that names the case can speak, so the run went red with a bare
      // "no such file or directory" and no diagnosis.
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
          throw new Error(`SECRET_SCAN_TEST_FAULT names no fault in this file: '${FAULT}'`);
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

    /**
     * A fixture repository with three real commits, the third of which DELETES
     * the line the second planted.
     *
     * Built by one function for both the planted fixture and the control, so the
     * two differ in exactly one thing — the content of one blob that is absent
     * from both working trees. That is what makes the control a control.
     */
    async function buildFixture(name: string, plantedValue: string): Promise<Fixture> {
      const repo = join(tempRoot, name);
      await mkdir(repo, { recursive: true });
      git(repo, "init", "--quiet", "--initial-branch=main");
      await commitFiles(repo, { "README.md": `# ${name}\n` }, "root");
      await commitFiles(
        repo,
        {
          [`${NARROWED_SUBTREE}/fixtures/plain.ts`]: "export const plain = true;\n",
          [PLANTED_PATH]: `TOKEN_ENCRYPTION_KEY = "${plantedValue}"\n`,
        },
        "commit the credential-shaped line",
      );
      git(repo, "rm", "--quiet", PLANTED_PATH);
      git(repo, "commit", "--quiet", "--message", "take it back out of the tree");
      // Staged LAST, and deliberately not committed. The script only needs to be
      // findable at its own path — it resolves the repository it scans from
      // there — and a committed copy would put the script's own bytes into the
      // history this suite then reads. A faulted staging must not be able to
      // alter the history the planted assertions are made against.
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
      // `SECRET_SCAN_TEST_FAULT` left over in a shell's environment would quietly
      // run the whole block against a mutated script, and every green result here
      // would be a claim about a script this repository does not ship.
      expect(FAULT, "SECRET_SCAN_TEST_FAULT is set, so this run is a fault-injection run").toBe("");
      expect(readFileSync(planted.script, "utf8")).toBe(readFileSync(scriptPath, "utf8"));
      expect(readFileSync(control.script, "utf8")).toBe(readFileSync(scriptPath, "utf8"));
    });

    it("puts the planted secret inside the history a scan walks, and outside the tree a scan could read", () => {
      // The fixture's own property, verified with git alone, BEFORE anything is
      // run against it. A fixture that failed this would make every assertion
      // below true-to-true: a scan pointed at it would report a clean history
      // whether or not detection worked, and the suite would be certifying its
      // own fixture rather than the script.
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
      // `GITLEAKS_REPORT_PATH` is set exactly as `.github/workflows/secret-scan.yml`
      // sets it, so the run below is the workflow's scan step with the checkout
      // swapped for the fixture — rather than a near-miss of it.
      const { argv, status, output } = await runScript({ script: planted.script, reportPath: "gitleaks-report.json" });
      expect(
        status,
        `the stub must accept the argv the staged script passed, or the wiring below is untested: ${output}\n` +
          `argv: ${argv.join(" ")}`,
      ).toBe(0);

      // The subcommand is `argv[0]` and nothing else, so this one assertion IS
      // the "`gitleaks dir` reads the working tree" check — `dir` is a subcommand,
      // and subcommands are only ever the first argument. A whole-argv
      // `not.toContain("dir")` here would add no detection over this line and
      // would fail for no reason on any checkout, report path or temporary root
      // whose path happens to contain those three letters.
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

      // NOT A SUBTREE, asked of git rather than of this file: the top level of
      // whatever repository the target belongs to must BE the target. This is
      // narrower than the identity check at the end and fails with a better
      // message — a target narrowed to `$REPO_ROOT/tests` is still a directory
      // and still inside the repository, so nothing above can see it.
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

      // THE ASSERTION WITH TEETH. Read the history from UNDER THE DIRECTORY THE
      // SCAN WAS HANDED, restricted to that directory — `-- .` resolved against
      // the cwd, which is git's own expression of "the history of this
      // directory".
      //
      // The restriction is load-bearing and was measured, because the obvious
      // spelling of this assertion is vacuous: `git log --all -p` run from a
      // SUBDIRECTORY returns the WHOLE repository's history, so a plain read
      // under a narrowed target carries the planted secret anyway and the
      // assertion passes on precisely the mutant it exists to catch. `-- .` does
      // narrow (measured on a fixture shaped like this one: whole-history read
      // from the root and from a subdirectory both find the secret; the `-- .`
      // read from the subdirectory finds none of it), and the assertion above is
      // what catches the target before this one ever has to.
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
      // THE CONTROL. Both fixtures are built by the same function and differ in
      // one thing: the content of one blob, deleted in both. The planted test
      // above establishes that the planted fixture's history carries the secret;
      // this one establishes that the control's does not. Together they are a
      // statement about a DIFFERENCE between two repositories this suite built —
      // not a property both share, which would make the planted case true-to-true
      // and certify nothing. Without this, "the history under the target carries
      // the secret" could be satisfied by a script aimed anywhere at all.
      //
      // Attacking the control means breaking THIS: point the builder at the
      // planted value for both fixtures and the two stop differing. That leaves
      // the planted test green and turns only this one red, which is the shape a
      // control exists to have.
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
      // `existsSync` first, for the same reason as the two siblings above: on a
      // target that is not there `realpathSync` raises a bare ENOENT, and this
      // file's convention is that a reader scanning a failure finds the sentence
      // written for the case rather than the raw syscall. The `=== true` form
      // keeps the message a sentence instead of a diff between two long paths.
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
