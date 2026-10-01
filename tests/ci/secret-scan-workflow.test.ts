import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The shape of .github/workflows/secret-scan.yml, asserted on the PARSED YAML
 * and never on raw bytes, so reformatting the file does not disturb these
 * assertions while a change to any of the values below fails loudly.
 *
 * Every assertion here exists because of a specific way this workflow could go
 * quietly green while doing nothing:
 *
 *  - a `pull_request` trigger, which this workflow must not have, would make it
 *    reachable from a fork and change what a red run means;
 *  - a checkout without `fetch-depth: 0` turns a full-history scan into a scan
 *    of the tip commit, which passes every time;
 *  - a gitleaks installed from an action reference or a package manager is a
 *    version this file does not pin, so the rule set can move under a committed
 *    baseline;
 *  - a `continue-on-error` or an `if: always()` on the scan step turns findings
 *    into a green run;
 *  - a non-SHA-pinned `uses` makes the supply chain of a repository that reads
 *    full history an unpinned one;
 *  - an install step that extracts a binary without putting that directory on
 *    the PATH of LATER steps — the Critical this suite now executes rather than
 *    reads about, below.
 *
 * The model of the assertions is tests/api/ci-workflows.test.ts, which pins
 * dependency-audit.yml and code-scanning.yml; tests/ci/concurrency.test.ts is
 * what classifies this workflow's concurrency group.
 */

const PINNED_GITLEAKS_VERSION = "8.30.1";
const PINNED_GITLEAKS_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";

/**
 * The version the fixture gitleaks in the step-boundary test reports. It has to
 * be the pinned one, because the scan step's script refuses to scan under
 * anything else — and that refusal is a second, load-bearing thing the test
 * proves by getting past it.
 */
const FAKE_GITLEAKS_VERSION = PINNED_GITLEAKS_VERSION;

type Workflow = {
  name?: string;
  on: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
  jobs: Record<
    string,
    {
      name?: string;
      "runs-on"?: string;
      "timeout-minutes"?: number;
      steps: Array<{
        name?: string;
        if?: string;
        uses?: string;
        run?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
        "continue-on-error"?: unknown;
      }>;
    }
  >;
};

describe(".github/workflows/secret-scan.yml", () => {
  let workflow: Workflow;
  let scan: Workflow["jobs"][string];

  beforeAll(async () => {
    workflow = parse(await readFile(resolve(".github/workflows/secret-scan.yml"), "utf8")) as Workflow;
    scan = workflow.jobs.scan;
  });

  it("is named for what it does", () => {
    expect(workflow.name).toBe("secret scan");
  });

  it("is scheduled weekly and dispatchable, and is not reachable from a pull request", () => {
    expect(workflow.on).toEqual({
      schedule: [{ cron: expect.any(String) as unknown as string }],
      workflow_dispatch: null,
    });
    expect((workflow.on.schedule as Array<{ cron: string }>)).toHaveLength(1);
  });

  it("carries no pull_request or pull_request_target trigger", () => {
    // Pinned on its own rather than only through the equality above: that
    // equality is an `objectContaining`-shaped check to a reader, and adding a
    // second trigger is the change most likely to arrive with a plausible
    // reason ("let authors see it on their own branches"). This workflow exists
    // for history push protection never saw; a new commit is already gated by
    // push protection, so a pull-request leg would be metered for a signal
    // that already exists.
    const triggers = Object.keys(workflow.on ?? {});
    for (const trigger of ["pull_request", "pull_request_target"]) {
      expect(triggers, `secret-scan.yml must not be reachable through ${trigger}`).not.toContain(trigger);
    }
  });

  it("ticks weekly, off the top of the hour, and not on the half hour either", () => {
    const [cron] = (workflow.on.schedule as Array<{ cron: string }>).map((entry) => entry.cron);
    // Five fields: minute, hour, day-of-month, month, day-of-week. A fixed
    // day-of-week with `*` in the day-of-month field is what makes it WEEKLY —
    // a `*` day-of-week with a fixed day-of-month would be monthly, which is a
    // different promise than the one the header comment makes.
    expect(cron, "the cron must have five fields").toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
    const fields = cron.split(/\s+/);
    expect(fields[2], "a fixed day-of-week with '*' in the day-of-month field is weekly").toBe("*");
    expect(fields[3], "a fixed month would make the entry run once a year").toBe("*");
    expect(fields[4], "a fixed day-of-week is what makes the schedule weekly").toMatch(/^[0-6]$/);
    // The repository's stated reason for the off-peak minute: the Actions queue
    // is busiest on the hour, and dependency-audit.yml says so in its own
    // header. 0 and 30 are the two minutes everybody picks.
    expect(fields[0], `the minute must be off the top of the hour (got ${fields[0]})`).not.toBe("0");
    expect(fields[0], `the minute must not be the half hour (got ${fields[0]})`).not.toBe("30");
    expect(Number(fields[1]), "the hour must be a valid UTC hour").toBeLessThan(24);
  });

  it("reads the repository and nothing more", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("pins the job's runner and its budget", () => {
    // `runs-on` unpinned means a silently different image — a different glibc,
    // a different runner generation, a runner that no longer has the tools the
    // install step needs. `timeout-minutes` unpinned is the one that matters
    // most here: this job's only input is a full history walk, so the failure
    // mode it is prone to is a scan that never finishes, and with no budget
    // that scan holds a runner for the default six hours.
    expect(scan["runs-on"]).toBe("ubuntu-latest");
    expect(scan["timeout-minutes"]).toBe(15);
  });

  it("pins every action reference to a full commit SHA", () => {
    const uses = scan.steps.map((step) => step.uses).filter((value): value is string => value !== undefined);
    expect(uses.length, "the workflow must actually use actions").toBeGreaterThan(0);
    for (const value of uses) {
      // A version tag or a branch on an action that walks full history is an
      // unpinned supply chain for the one job whose whole job is to read every
      // commit ever made.
      expect(value, `${value} must be pinned to a 40-character commit SHA`).toMatch(
        /^[A-Za-z0-9_.\-/]+@[0-9a-f]{40}$/,
      );
    }
  });

  it("checks out the FULL history, without credentials, because the history is the whole point", () => {
    const checkout = scan.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout, "the workflow must check the repository out").toBeDefined();
    expect(
      checkout!.with?.["fetch-depth"],
      "without fetch-depth: 0 the checkout is a shallow clone and the scan walks one commit — a green no-op",
    ).toBe(0);
    expect(checkout!.with?.["persist-credentials"], "the job's token is read-only and must not be left in the checkout").toBe(
      false,
    );
  });

  it("installs gitleaks from the checksum-verified release tarball, not from an action or a package manager", () => {
    // No step may install gitleaks by reference. A `gitleaks/gitleaks-action@…`
    // step is pinned by SHA like any other action, but the ACTION decides the
    // scanner's version, so a bump inside it moves the rule set under a
    // committed baseline with nothing in this repository to change.
    for (const step of scan.steps) {
      expect(step.uses ?? "", "no step may install gitleaks from an action reference").not.toMatch(/gitleaks/i);
    }
    for (const step of scan.steps) {
      const run = step.run ?? "";
      expect(run, "gitleaks must not be installed from a package manager").not.toMatch(
        /(pip|npm|pnpm|yarn|go|apt-get|brew)\s+(install|get)\s+[^\n]*gitleaks/i,
      );
    }

    const install = scan.steps.find((step) => /sha256sum -c/.test(step.run ?? ""));
    expect(install, "no step verifies a downloaded gitleaks tarball with sha256sum -c").toBeDefined();
    const run = install!.run ?? "";
    // The checksum and the version live in the step's env:, not in run: — the
    // same rule every other workflow here follows, and the reason the run block
    // below carries no ${{ }} interpolation at all.
    const env = { ...(install!.env ?? {}), ...Object.fromEntries(Object.entries(install!.with ?? {})) };
    const named = Object.values(env).map(String).join("\n");
    expect(named, "the install step must carry the pinned checksum literal").toContain(PINNED_GITLEAKS_SHA256);
    expect(named, "the install step must name the pinned version").toContain(PINNED_GITLEAKS_VERSION);
    expect(run, "the install step must extract the binary").toMatch(/tar\s+-xzf/);
    // Tolerates whatever path prefix the extraction is addressed by, because
    // that prefix is exactly what the step-boundary test below exercises and
    // this one only needs to know the step verifies what it just unpacked.
    expect(run, "the install step must print the version it installed").toMatch(/gitleaks"?\s+version\b/);
  });

  it("runs the scan script, and the script's exit code is the gate", async () => {
    const scanStep = scan.steps.find((step) => /bash scripts\/secret-scan\.sh/.test(step.run ?? ""));
    expect(scanStep, "no step runs scripts/secret-scan.sh").toBeDefined();
    // The whole workflow's signal is this step's exit code. Anything that lets
    // it continue past a nonzero exit turns a detection signal into decoration.
    for (const step of scan.steps) {
      expect(
        step["continue-on-error"],
        `${step.name ?? step.uses ?? "a step"} must not tolerate failure — the run has to be able to go red`,
      ).toBeUndefined();
    }
    // Scoped to the scan step alone: the upload step is REQUIRED to carry
    // `if: always()`, which is what leaves a red run's findings readable. A
    // blanket "no step has an if" would deny the one gate that does real work.
    expect(
      scanStep!.if ?? "",
      "the scan step must not be gated — `if: always()` or `if: failure()` on it is precisely the " +
        "wiring that lets a findings run finish green",
    ).not.toMatch(/always\(\)|failure\(\)|!cancelled|cancelled\(\)/);
  });

  it("uploads the JSON report as an artifact even when the scan failed", () => {
    const upload = scan.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload, "no step uploads the findings report as an artifact").toBeDefined();
    // `if: always()` is the only thing that makes a red run leave the report
    // behind, and the report is what a human reads to learn WHICH commit and
    // WHICH line carried the finding.
    expect(upload!.if, "the upload must run on a failed scan too").toMatch(/always\(\)/);
    const path = upload!.with?.path;
    const named = Array.isArray(path) ? path.join("\n") : String(path ?? "");
    expect(named, "the uploaded artifact must be the gitleaks JSON report").toMatch(/\.json$/);
  });

  it("keeps every event value out of run: interpolation", () => {
    for (const step of scan.steps) {
      // Values from the event reach the shell through env:, never through ${{ }}
      // inside run:, or a repository or branch name becomes shell source.
      expect(step.run ?? "", `${step.name ?? step.uses ?? "a step"} must not interpolate into run:`).not.toContain(
        "${{",
      );
    }
  });

  it("uses a job id and name that cannot collide with a required check context", () => {
    // tests/ci/required-checks.test.ts fails on a ${{ }} expression in a job
    // name, and .github/required-checks.json names verify, actionlint and
    // ratchet-guard. A job id or name that matched one of those would be a
    // required context this workflow's conclusions could silently satisfy.
    expect(workflow.jobs, "the job id must be scan").not.toHaveProperty("verify");
    expect(workflow.jobs, "the job id must not be actionlint").not.toHaveProperty("actionlint");
    expect(workflow.jobs, "the job id must not be ratchet-guard").not.toHaveProperty("ratchet-guard");
    expect(scan.name ?? "", "a job name carrying an expression is a required-checks failure").not.toContain("${{");
  });

  it("installs a gitleaks that the scan step's OWN shell can resolve by bare name", async () => {
    // This is the assertion that spans the step boundary, and it EXECUTES both
    // steps rather than reading either one.
    //
    // The defect it exists for was a workflow that could never go green: the
    // install step extracted the binary into the step's working directory, and
    // never put that directory on the PATH of later steps. Every assertion in
    // this file was still green — the install step's shape was pinned here, the
    // script's wiring was pinned in secret-scan-script.test.ts against a stub
    // the test itself put on PATH, and the gap between them was owned by
    // neither. Three green suites certifying a job that failed on its first
    // scheduled run, with a message that pointed at the wrong cause.
    //
    // So the invariant pinned is the CONSUMER's resolution, and the only honest
    // way to check it is to run it. This test:
    //
    //   1. stages a repository the way actions/checkout would leave one — the
    //      real scripts/secret-scan.sh and the real .github/gitleaks-baseline.json,
    //      and nothing else;
    //   2. builds a gitleaks release tarball locally and points the install
    //      step's `curl` at a stub that hands it over, so the step's own script
    //      runs with no network;
    //   3. executes the install step's `run:` block VERBATIM, with a runner's
    //      three environment variables set to the temp tree;
    //   4. executes the scan step's `run:` block VERBATIM in a FRESH shell whose
    //      PATH is the runner's own PATH plus exactly the entries the install
    //      step appended to $GITHUB_PATH — which is what a GitHub runner hands
    //      the next step;
    //   5. asserts the scan step exited 0 and wrote a report.
    //
    // Step 4 is the whole test. A stubbed binary in step 2 is what makes this
    // runnable offline; it is not what makes it pass, because the stub lives
    // where the install step put it and the consumer's PATH is built without
    // knowing that. Remove the install step's $GITHUB_PATH write and step 4
    // fails with the very message the real job would have printed.
    //
    // The one thing stubbed is the download, and the checksum the step verifies
    // is this fixture's real digest rather than the workflow's literal — this
    // test is about reachability across the boundary, not about the checksum,
    // which the install-step assertion in this file pins by literal.
    const install = scan.steps.find((step) => /sha256sum -c/.test(step.run ?? ""));
    const consumer = scan.steps.find((step) => /scripts\/secret-scan\.sh/.test(step.run ?? ""));
    expect(install?.run, "no install step to execute").toBeDefined();
    expect(consumer?.run, "no scan step to execute").toBeDefined();

    const root = join(tmpdir(), `secret-scan-runner-${process.pid}-${Date.now()}`);
    // The runner's own PATH. Deliberately excludes the workspace and every
    // directory the install step might use, because on a real runner neither is
    // on it — that exclusion is the entire subject of the test.
    const RUNNER_PATH = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":");
    try {
      const workspace = join(root, "workspace");
      const runnerTemp = join(root, "runner-temp");
      const stubBin = join(root, "stub-bin");
      const dist = join(root, "dist");
      const githubPathFile = join(root, "github-path");
      for (const directory of [workspace, runnerTemp, stubBin, dist]) await mkdir(directory, { recursive: true });
      await writeFile(githubPathFile, "", "utf8");

      // Stage the repository the way the checkout step leaves it: the script the
      // scan step runs, and the baseline the script insists exists. No .git —
      // the scanner below is a fixture, not gitleaks.
      await mkdir(join(workspace, "scripts"), { recursive: true });
      await mkdir(join(workspace, ".github"), { recursive: true });
      await copyFile(resolve("scripts/secret-scan.sh"), join(workspace, "scripts/secret-scan.sh"));
      await copyFile(resolve(".github/gitleaks-baseline.json"), join(workspace, ".github/gitleaks-baseline.json"));
      await chmod(join(workspace, "scripts/secret-scan.sh"), 0o755);

      // The gitleaks release tarball, built locally. `version` answers so the
      // script's pin check can pass; the scan subcommand validates the argv the
      // script passes and writes the report, so a mis-wired command still fails
      // loudly here rather than producing plausible-looking data.
      const fakeBinary = join(dist, "gitleaks");
      await writeFile(
        fakeBinary,
        [
          "#!/usr/bin/env bash",
          "set -uo pipefail",
          'if [ "${1:-}" = version ]; then printf \'%s\\n\' "${FAKE_GITLEAKS_VERSION}"; exit 0; fi',
          'if [ "${1:-}" != git ]; then echo "stub gitleaks: unrecognised subcommand ${1:-}" >&2; exit 3; fi',
          "shift",
          "report_path=''; report_format=''; baseline=''; target=''; redacted=0; no_banner=0",
          'while [ "$#" -gt 0 ]; do',
          '  case "$1" in',
          "    --redact) redacted=1 ;;",
          "    --no-banner) no_banner=1 ;;",
          '    --report-path) report_path="$2"; shift ;;',
          '    --report-format) report_format="$2"; shift ;;',
          '    --baseline-path) baseline="$2"; shift ;;',
          '    -*) echo "stub gitleaks: unrecognised flag $1" >&2; exit 3 ;;',
          '    *) target="$1" ;;',
          "  esac",
          "  shift",
          "done",
          '[ "$redacted" = 1 ] || { echo "stub gitleaks: no --redact" >&2; exit 3; }',
          '[ "$no_banner" = 1 ] || { echo "stub gitleaks: no --no-banner" >&2; exit 3; }',
          '[ "$report_format" = json ] || { echo "stub gitleaks: report format is \'$report_format\'" >&2; exit 3; }',
          '[ -f "$baseline" ] || { echo "stub gitleaks: baseline is not a file: $baseline" >&2; exit 3; }',
          '[ -n "$target" ] || { echo "stub gitleaks: no scan target" >&2; exit 3; }',
          "printf '[]\\n' > \"$report_path\"",
          "exit 0",
        ].join("\n") + "\n",
        "utf8",
      );
      await chmod(fakeBinary, 0o755);
      const tarball = join(root, `${FAKE_GITLEAKS_VERSION}_linux_x64.tar.gz`);
      const packed = spawnSync("tar", ["-czf", tarball, "-C", dist, "gitleaks"], { encoding: "utf8" });
      expect(packed.status, `the fixture tarball must build: ${packed.stderr}`).toBe(0);
      const digest = createHash("sha256").update(readFileSync(tarball)).digest("hex");

      // A curl that hands over the fixture instead of reaching the network. The
      // stub fails loudly if the install step stops using -o, so this cannot
      // quietly become a no-op that "passes" an install that downloaded nothing.
      await writeFile(
        join(stubBin, "curl"),
        [
          "#!/usr/bin/env bash",
          "set -uo pipefail",
          'out=""',
          'prev=""',
          'for a in "$@"; do',
          '  if [ "$prev" = "-o" ]; then out="$a"; fi',
          '  prev="$a"',
          "done",
          '[ -n "$out" ] || { echo "stub curl: no -o target" >&2; exit 3; }',
          '[ -f "$STUB_TARBALL" ] || { echo "stub curl: no fixture tarball at $STUB_TARBALL" >&2; exit 3; }',
          'cp "$STUB_TARBALL" "$out"',
        ].join("\n") + "\n",
        "utf8",
      );
      await chmod(join(stubBin, "curl"), 0o755);

      // (3) The install step, verbatim, with the runner's environment.
      const installEnv: NodeJS.ProcessEnv = {
        // Neither step reads NODE_ENV; it is present because this repository's
        // NodeJS.ProcessEnv requires it, and the convention across its tests.
        NODE_ENV: "test",
        PATH: `${stubBin}:${RUNNER_PATH}`,
        HOME: root,
        GITHUB_WORKSPACE: workspace,
        GITHUB_PATH: githubPathFile,
        RUNNER_TEMP: runnerTemp,
        RUNNER_OS: "Linux",
        STUB_TARBALL: tarball,
        FAKE_GITLEAKS_VERSION: FAKE_GITLEAKS_VERSION,
        ...install!.env,
        // This fixture's real digest, so `sha256sum -c` is a real check. The
        // workflow's literal is pinned by the install-step assertion above.
        GITLEAKS_SHA256: digest,
      };
      const installed = spawnSync("bash", ["-c", install!.run!], {
        cwd: workspace,
        encoding: "utf8",
        env: installEnv,
      });
      expect(
        installed.status,
        `the install step must succeed in the simulated runner:\n${installed.stdout}\n${installed.stderr}`,
      ).toBe(0);

      // (4) The scan step, verbatim, in a FRESH shell whose PATH is the
      // runner's own PATH plus the entries the install step appended — which is
      // precisely how a GitHub runner composes a later step's PATH.
      const appended = readFileSync(githubPathFile, "utf8").split("\n").filter((line) => line.trim() !== "");
      const consumerEnv: NodeJS.ProcessEnv = {
        NODE_ENV: "test",
        PATH: [RUNNER_PATH, ...appended].join(":"),
        HOME: root,
        GITHUB_WORKSPACE: workspace,
        GITHUB_PATH: githubPathFile,
        RUNNER_TEMP: runnerTemp,
        RUNNER_OS: "Linux",
        FAKE_GITLEAKS_VERSION: FAKE_GITLEAKS_VERSION,
        ...consumer!.env,
      };
      const consumerResult = spawnSync("bash", ["-c", consumer!.run!], {
        cwd: workspace,
        encoding: "utf8",
        env: consumerEnv,
      });
      expect(
        consumerResult.status,
        `the scan step must succeed in a shell that only has the runner's PATH plus whatever the ` +
          `install step appended to $GITHUB_PATH. It exited ${consumerResult.status} with:\n` +
          `${consumerResult.stdout}\n${consumerResult.stderr}\n` +
          "A gitleaks extracted by one step is NOT on the next step's PATH. The install step has to " +
          "append the directory it extracted into to $GITHUB_PATH, or the scan step runs against a " +
          "runner that has never heard of gitleaks and fails as if the history were dirty.",
      ).toBe(0);
      expect(
        consumerResult.stderr,
        "the scan step must not report a missing or unpinned gitleaks once the install step has run",
      ).not.toMatch(/no gitleaks on PATH|is on PATH, but this/);
      expect(
        existsSync(join(workspace, "gitleaks-report.json")),
        "the scan step must actually produce the report the upload step then reads",
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is tracked under the deny-by-default ignore policy", () => {
    for (const path of [
      ".github/workflows/secret-scan.yml",
      ".github/gitleaks-baseline.json",
      "scripts/secret-scan.sh",
    ]) {
      expect(
        checkIgnore(path),
        `${path} must be named back by .gitignore, or it is invisible to git despite existing on disk`,
      ).toBe(1);
    }
    // The negative direction, so a `!.github/**` or `!scripts/**` widening
    // cannot satisfy the assertions above while reopening every untracked file
    // in those directories. The junk under .github/workflows/ carries the
    // .yaml extension on purpose: `.github/workflows/*.yml` is a deliberate
    // glob, so an unshipped .yml there would legitimately be named back.
    for (const path of [".github/workflows/junk.yaml", ".github/junk.txt", "scripts/junk.sh"]) {
      expect(checkIgnore(path), `${path} is junk and must stay ignored`).toBe(0);
    }
  });
});

/**
 * `git check-ignore` exit status for a path: 1 when the path is NOT ignored —
 * the state a deliberately named-back file must be in — and 0 when it is.
 * `--no-index` is what makes the answer about the ignore policy rather than
 * about what happens to be staged, so the assertion holds for a file that has
 * not been added yet.
 */
function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
  }).status;
}
