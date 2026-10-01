import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { commitFiles, git, hasCommit, isShallowCheckout, scratchGitEnv, showFileLines } from "../support/scratch-git";

/**
 * Two contracts for issue 900's history scan, and an explicit statement of what
 * this suite covers in each environment it runs in — because those differ, and a
 * reader who assumes they do not is exactly the reader this suite is for.
 *
 * **Covered everywhere, at any checkout depth:** the wiring of
 * `scripts/secret-scan.sh` (the version pin, the git-history mode, `--redact`,
 * `--no-banner`, the baseline path, the report path, the exit-code pass-through,
 * and the two refusal diagnostics); every property of the committed baseline
 * readable from the file itself; and the provenance CHECKER, driven against a
 * repository this suite builds for itself.
 *
 * **Covered only where the history is present:** the committed baseline's
 * provenance — that each finding's redacted residue really came from the source
 * line it names. That check reads the blobs the baseline points at, and
 * `.github/workflows/ci.yml`'s `verify` job checks out at `actions/checkout`'s
 * default depth of 1, where those nine September commits do not exist. The test
 * that does it therefore **SKIPS in CI, and the skip is reported in the run
 * summary rather than passing quietly.** In a full-depth checkout it runs. Do not
 * read a green CI run as evidence about the committed baseline's provenance: it
 * is evidence about the checker, and about the file's own contents.
 *
 * The checker is the part covered everywhere, and it is covered by planting the
 * defect it exists to catch — a finding whose residue is material spliced in
 * beside a redaction — in a real commit the suite creates, and watching it be
 * rejected. A guard only ever run against data known to be clean has never been
 * shown to reject anything.
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
    // or this test would pass on the seven `gitlab-pat` entries alone and pin
    // nothing.
    expect(checked, "no committed entry leaves a non-empty residue to check").toBeGreaterThan(0);
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

  it("reports the ambient checkout, not one named by a GIT variable", async () => {
    // The ambient checkout's real answers, captured BEFORE anything is poisoned.
    // Comparing the shielded read against a value read while GIT_DIR is set
    // would compare it against the wrong repository, which is the very mistake
    // this test exists to catch. The HEAD read carries `env: scratchGitEnv` too,
    // so it is the ambient checkout's HEAD even for a developer who already runs
    // with a GIT_DIR exported.
    const ambient = {
      shallow: isShallowCheckout(),
      head: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", env: scratchGitEnv }).stdout.trim(),
    };
    expect(ambient.head, "the ambient checkout must have a HEAD to look for").toMatch(/^[0-9a-f]{40}$/);

    for (const { variable, value, redirects } of REDIRECTORS) {
      const saved = process.env[variable];
      process.env[variable] = value();
      try {
        const unshielded = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
          encoding: "utf8",
          env: process.env,
        }).stdout.trim();
        if (redirects) {
          // Asserted, not assumed: a redirector that stops redirecting would
          // leave the case below passing for the wrong reason, and a control
          // that cannot fail is not a control.
          expect(unshielded, `${variable} must genuinely redirect, or this case proves nothing`).toBe("true");
        }

        // A module reload per case, because the environment the helper uses is
        // snapshotted at import — which is exactly why a GIT_DIR present at
        // process start is stripped rather than honoured.
        vi.resetModules();
        const shielded = await import("../support/scratch-git");
        expect(
          shielded.isShallowCheckout(),
          `with ${variable} pointed elsewhere, the shielded read must still answer about the checkout ` +
            "this test is running in. Answering 'shallow' here skips the deep provenance check on a " +
            "full-depth repository, on a green run.",
        ).toBe(ambient.shallow);
        expect(
          shielded.hasCommit(ambient.head),
          `with ${variable} redirected, hasCommit must still find the ambient checkout's own HEAD`,
        ).toBe(true);
      } finally {
        if (saved === undefined) delete process.env[variable];
        else process.env[variable] = saved;
      }
    }
  });
});


/**
 * The committed baseline's own provenance — the same check, over the real
 * entries, against the real commits they name.
 *
 * This block SKIPS wherever the checkout is shallower than the history it points
 * at, which in practice means CI: `.github/workflows/ci.yml` gives the `verify`
 * job `actions/checkout`'s default depth of 1, and the baseline's entries date
 * from September. The skip is deliberate and reported in the run summary. A
 * `try { … } catch { pass }` here would be the same false green this whole
 * exercise has been about, wearing a name tag: a green CI run would read as
 * coverage the run does not have. See the file header for what each environment
 * does and does not establish.
 *
 * What it does NOT do is skip because a commit is missing from a FULL-DEPTH
 * checkout. That is a baseline pointing at a commit this repository does not
 * have — a defect in a tracked artefact that the weekly scan is the only thing
 * to notice — so it fails, in the check above, by name.
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
          // in a tracked artefact, and the weekly scan is the only thing that
          // would ever notice it. So this FAILS. A skip here would report that
          // defect as coverage, which is the shape of false green this suite
          // has spent three rounds removing.
          expect.fail(
            `the baseline names ${key}, which must exist in this repository's history: ` +
              `${(error as Error).message}`,
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
      `this run verified the provenance of ${checked} of ${findings.length} committed entries. A finding ` +
        "whose Match is a pure redaction leaves no residue and cannot be checked this way — that is " +
        "correct, not a gap, and the redaction assertions are what carry those entries. Zero is not " +
        "correct, though: it means this check examined nothing and still reported green.",
    ).toBeGreaterThan(0);
  });

  it.skipIf(!shallow)("corroborates the checkout's own depth against the objects it holds", () => {
    // The companion to the skip above, and it exists to pin the PREDICATE, not
    // the baseline. The skip is taken on the checkout's word that it is shallow;
    // this asserts that the word is true, by checking that the objects really are
    // absent. That is what makes the pair self-pinning: a predicate hardcoded to
    // "shallow" makes this test RUN in a full-depth checkout, where nothing is
    // unresolvable, and it fails there.
    //
    // It is deliberately not a tautology. Under the old predicate — derived from
    // the baseline's own `Commit` values — a corrupted entry naming a commit this
    // repository does not have turned the deep check off in a FULL-DEPTH checkout
    // and the run stayed green, because a broken baseline and a shallow checkout
    // produced the same green and the same skip. The predicate is now a property
    // of the environment, so that entry is no longer a way to disable anything: at
    // full depth the deep check runs, and its own `expect(blob.status)` fires.
    const unresolvable = findings.filter((finding) => !hasCommit(finding.Commit)).map((f) => f.Fingerprint);
    expect(
      unresolvable,
      "this checkout reports itself shallow, and the provenance check above was skipped on that word — " +
        "but every commit the baseline names resolves here. Either the depth predicate is reporting " +
        "something other than this checkout's depth, or the skip above was taken for a reason that does " +
        "not hold. Either way the committed baseline's provenance is unverified by this run and nothing " +
        "above said so.",
    ).not.toEqual([]);
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
