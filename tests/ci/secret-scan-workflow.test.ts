import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv, tryGit } from "../support/scratch-git";

/**
 * The shape of .github/workflows/secret-scan.yml, asserted on the PARSED YAML
 * and never on raw bytes, so reformatting the file does not disturb these
 * assertions while a change to any of the values below fails loudly.
 *
 * Every assertion here exists because of a specific way this workflow could go
 * quietly green while doing nothing:
 *
 *  - a `pull_request` trigger could execute untrusted PR scripts; the trusted
 *    `pull_request_target` leg must only fetch the PR head as git objects;
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
    scan = workflow.jobs["secret-scan"] ?? workflow.jobs.scan;
  });

  it("is named for what it does", () => {
    expect(workflow.name).toBe("secret scan");
  });

  it("runs on every main push and pull request, daily, and on dispatch", () => {
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
      push: { branches: ["main"] },
      schedule: [{ cron: "41 4 * * *" }],
      workflow_dispatch: null,
    });
  });

  it("scopes the trusted PR trigger to main only, with no pull_request trigger", () => {
    expect(workflow.on).not.toHaveProperty("pull_request");
    expect(workflow.on.pull_request_target).toEqual({
      branches: ["main"], types: ["opened", "synchronize", "reopened"],
    });
  });

  it("ticks daily at the pinned off-peak UTC slot", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "41 4 * * *" }]);
  });

  it("produces exactly the future secret-scan check context", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["secret-scan"]);
    expect(scan.name ?? "secret-scan").toBe("secret-scan");
  });

  it("uses main's checkout and fetches the PR head only as git objects", async () => {
    const checkouts = scan.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(2);
    expect(checkouts.map((step) => step.if)).toEqual([
      "${{ github.event_name == 'pull_request_target' }}",
      "${{ github.event_name != 'pull_request_target' }}",
    ]);
    for (const checkout of checkouts) {
      expect(checkout.with).toEqual({ "fetch-depth": 0, "persist-credentials": false });
    }
    const fetch = scan.steps.find((step) => step.name === "Fetch the pull request head");
    expect(fetch?.if).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(fetch?.env).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
    expect(fetch?.run).toBe('git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"');
    const fetchIndex = scan.steps.indexOf(fetch!);
    const installIndex = scan.steps.findIndex((step) => step.name === "Install gitleaks");
    expect(fetchIndex).toBeGreaterThan(scan.steps.indexOf(checkouts[1]));
    expect(fetchIndex).toBeLessThan(installIndex);
    for (const step of scan.steps) {
      expect(step.run ?? "").not.toMatch(/git\s+(checkout|switch|reset|worktree)\b/);
      expect(step.uses ?? "").not.toMatch(/^\.\//);
    }
    const source = await readFile(resolve(".github/workflows/secret-scan.yml"), "utf8");
    expect(source).toMatch(/pull_request_target:\s*# zizmor: ignore\[dangerous-triggers\]/);
  });

  it("scans and uploads for every event, with a PR-specific reachability root", () => {
    const scanStep = scan.steps.find((step) => step.name === "Scan the full history");
    const upload = scan.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(scanStep?.run).toBe("bash scripts/secret-scan.sh");
    expect(scanStep?.if).toBeUndefined();
    expect(scanStep?.env).toEqual({ GITLEAKS_REPORT_PATH: "gitleaks-report.json" });
    expect(upload?.if).toBe("${{ always() }}");
    expect(upload?.with?.path).toBe("gitleaks-report.json");
    const checks = scan.steps.filter((step) => /scripts\/secret-scan-baseline\.sh/.test(step.run ?? ""));
    expect(checks.map((step) => [step.if, step.run])).toEqual([
      ["${{ github.event_name == 'pull_request_target' }}", "bash scripts/secret-scan-baseline.sh refs/remotes/pr/head"],
      ["${{ github.event_name != 'pull_request_target' }}", "bash scripts/secret-scan-baseline.sh"],
    ]);
    for (const check of checks) expect(scan.steps.indexOf(check)).toBeGreaterThan(scan.steps.indexOf(upload!));
  });

  it("rejects an event without a scan path", () => {
    const gate = scan.steps.find((step) => step.name === "Refuse unhandled events");
    expect(gate?.run).toBeDefined();
    expect(scan.steps.indexOf(gate!)).toBe(0);
    for (const event of ["push", "pull_request_target", "schedule", "workflow_dispatch", "pull_request", "unknown"]) {
      const result = spawnSync("bash", ["-e", "-c", gate!.run!], {
        encoding: "utf8", env: { ...scratchGitEnv, GITHUB_EVENT_NAME: event },
      });
      expect(result.status, `${event}: ${result.stdout} ${result.stderr}`).toBe(
        ["push", "pull_request_target", "schedule", "workflow_dispatch"].includes(event) ? 0 : 1,
      );
    }
  });

  it("wires the producer's workflow name into the ledger relay", async () => {
    const relay = parse(await readFile(resolve(".github/workflows/ledger-relay.yml"), "utf8")) as {
      on: { workflow_run: { workflows: string[] } };
    };
    expect(relay.on.workflow_run.workflows).toContain("secret scan");
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
    // `error`, not the default `warn`: the run already carries the real
    // diagnosis in its log when the script refuses before gitleaks runs, so a
    // silently-missing report costs a human nothing. What it would cost is the
    // workflow's stated purpose — "a red run leaves the findings where a human
    // can read them" — quietly becoming "a red run leaves nothing and says
    // nothing", which is this branch's whole subject wearing a different hat.
    expect(
      upload!.with?.["if-no-files-found"],
      "the upload must fail when the report is absent, so a missing report is a red run and not a " +
        "silent one. `warn` — the default — makes an absent report invisible on a run that is " +
        "already red for an unrelated reason.",
    ).toBe("error");
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
    expect(workflow.jobs, "the job id must not be verify").not.toHaveProperty("verify");
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
      // `bash -e`, which is what a GitHub runner uses for a `run:` block on
      // Linux. Not an optimisation: without errexit a failed command in the
      // middle of the block is not fatal, so `echo … | sha256sum -c -` printing
      // FAILED would be followed by the next line running and the step exiting
      // 0 — the test would then pass on an install whose checksum did not
      // verify. The reviewer's T-4 mutant is exactly that, and it is green
      // without this flag.
      //
      // `pipefail` is deliberately NOT set, because the runner does not set it
      // either and the point is to reproduce the runner. What makes
      // `sha256sum -c` safe here is that it is the LAST stage of its pipeline:
      // under `bash -e` without pipefail a pipeline's status is the last
      // stage's, so this check is the one whose status the step inherits. That
      // is a property of the ORDER, not of the flags — an earlier stage
      // failing while a later one succeeds would be invisible here, and the
      // downloader's own flags (`-f -sS -L --retry 3`) are what cover that.
      const installed = spawnSync("bash", ["-e", "-c", install!.run!], {
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
      // `-e` on THIS step is inert by construction, and is kept only so the two
      // blocks are run the way a runner runs them. This step's `run:` is a single
      // command whose exit status is already the script's own, so there is no
      // intervening line for errexit to abandon. Do not "simplify" the flags on
      // one block and not the other, and do not read the install step's `-e` as
      // load-bearing here: the property it makes observable is "a checksum
      // mismatch aborts the install step", and that is a conjunction of the flag
      // and a failing checksum, pinned by the install step's assertions.
      const consumerResult = spawnSync("bash", ["-e", "-c", consumer!.run!], {
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

  it("checks the baseline's commits for reachability, as a step that can end the run", () => {
    const step = scan.steps.find((candidate) => /scripts\/secret-scan-baseline\.sh/.test(candidate.run ?? ""));
    expect(step, "no step runs the baseline-reachability check").toBeDefined();
    expect(step!.name, "a step that can fail the run must be named, or its red is anonymous in the log").toBeTruthy();
    // Not gated. A `if: always()` here would invert the check into a
    // decoration: it runs after a failure the same way it runs after a success,
    // which is fine for the report upload and wrong for this.
    expect(
      step!.if ?? "",
      "the reachability step must not be gated — it is the step whose nonzero exit ends the run",
    ).not.toMatch(/always\(\)|failure\(\)|!cancelled|cancelled\(\)/);
    // Last, not first, and deliberately. An unreachable entry does not make the
    // scan WRONG — gitleaks walks the real history, so such an entry suppresses
    // nothing and the scan still reports whatever is really there — but in the
    // common `--rebase` case it is HALF of a pair whose other half is what
    // suppresses the finding, so the scan's own report is the other half of this
    // diagnosis. Failing before it would discard the evidence a human needs, and
    // would fail the upload with "file not found" beside the real diagnostic.
    const scanStep = scan.steps.findIndex((candidate) => /bash scripts\/secret-scan\.sh/.test(candidate.run ?? ""));
    const uploadStep = scan.steps.findIndex((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"));
    const reachabilityStep = scan.steps.indexOf(step!);
    expect(scanStep, "no scan step to order against").toBeGreaterThan(-1);
    expect(uploadStep, "no upload step to order against").toBeGreaterThan(-1);
    expect(reachabilityStep, "the reachability step must come after the scan").toBeGreaterThan(scanStep);
    expect(reachabilityStep, "the reachability step must come after the report upload, so a red run still leaves the report").toBeGreaterThan(uploadStep);
  });

  /**
   * The reachability step, EXECUTED.
   *
   * Everything above asserts the step's SHAPE from the parsed YAML. That is not
   * evidence the step works: a step whose `run:` block is a `grep` for a string,
   * or whose comparison is inverted, satisfies every shape assertion above and
   * reports a clean baseline as an orphaned one — or, worse, the reverse, on a
   * daily tick nobody is watching. So this executes the step's own `run:` block
   * verbatim, the way the sibling install/scan test executes those two, against a
   * repository this suite builds with real commits.
   *
   * It builds one rather than reading the committed baseline for the same reason
   * the provenance checker does: the committed baseline's eight entries name six
   * commits of THIS repository, five of them from September and one from October,
   * so a case that has to fail cannot use them without first poisoning a tracked
   * file, and a case that has to pass cannot use them at all in any checkout
   * shallower than the oldest of them.
   */
  describe("the reachability step, executed against repositories this suite builds", () => {
    const SCRIPT = "scripts/secret-scan-baseline.sh";
    const step = (pr = false) => {
      const found = scan.steps.find((candidate) => {
        const isPrStep = candidate.if === "${{ github.event_name == 'pull_request_target' }}";
        return /scripts\/secret-scan-baseline\.sh/.test(candidate.run ?? "") && isPrStep === pr;
      });
      expect(found, "no step runs the baseline-reachability check").toBeDefined();
      return found!;
    };

    let root = "";
    /**
     * A commit that is present in the object store but is NOT an ancestor of
     * HEAD. This is the shape the check exists for rather than the easier
     * one: a `--rebase` merge's discarded pre-image is exactly this — a commit
     * git still holds and that `rev-parse` resolves, which a bare
     * `hasCommit`-style existence test would wave through. Building it as a side
     * branch is how a real one is shaped, and it is why the check asks
     * `merge-base --is-ancestor` rather than `cat-file -e`.
     */
    let unmerged = "";
    /** An ancestor of HEAD, so the positive direction has something real to pass on. */
    let reachable = "";

    const finding = (commit: string, file: string) => ({
      RuleID: "generic-api-key",
      Description: "fixture",
      StartLine: 116,
      EndLine: 116,
      Match: 'TOKEN_ENCRYPTION_KEY", "REDACTED"',
      Secret: "REDACTED",
      File: file,
      Commit: commit,
      Fingerprint: `${commit}:${file}:generic-api-key:116`,
    });

    /** Run the step's `run:` block verbatim in `repoPath`, with `baseline` as its committed file. */
    const runStep = (repoPath: string, baseline: unknown, pr = false) => {
      writeFileSync(join(repoPath, ".github", "gitleaks-baseline.json"), `${JSON.stringify(baseline, null, 1)}\n`, "utf8");
      return spawnSync("bash", ["-e", "-c", step(pr).run!], {
        cwd: repoPath,
        encoding: "utf8",
        // `scratchGitEnv` already carries this session's NODE_ENV and strips
        // every inherited GIT_* selector, so the step runs against the
        // repository it was pointed at and nothing can redirect it elsewhere.
        env: scratchGitEnv,
      });
    };

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "secret-scan-reachability-"));
      const repoPath = join(root, "checkout");
      await mkdir(repoPath, { recursive: true });
      git(repoPath, "init", "--quiet", "--initial-branch=main");
      await commitFiles(repoPath, { "README.md": "# checkout\n" }, "root");
      reachable = await commitFiles(repoPath, { "a.txt": "a\n" }, "an ancestor");
      git(repoPath, "checkout", "--quiet", "-b", "side");
      unmerged = await commitFiles(repoPath, { "b.txt": "b\n" }, "on a branch that is never merged");
      git(repoPath, "checkout", "--quiet", "main");
      git(repoPath, "update-ref", "refs/remotes/pr/head", unmerged);
      // Staged last, so the history above is the history git actually has. The
      // script resolves its repository from its OWN location, which is what makes
      // a staged copy the checkout as far as the step is concerned.
      await mkdir(join(repoPath, "scripts"), { recursive: true });
      await mkdir(join(repoPath, ".github"), { recursive: true });
      await copyFile(resolve(SCRIPT), join(repoPath, SCRIPT));
    });

    afterAll(async () => {
      if (root) await rm(root, { recursive: true, force: true });
    });

    it("passes when every commit the baseline names is an ancestor of HEAD", () => {
      const result = runStep(join(root, "checkout"), [
        finding(reachable, "tests/security/token-cipher.test.ts"),
      ]);
      expect(
        result.status,
        `the step must pass on a baseline naming only reachable commits:\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);
      // Not a bare exit code: a step that exited 0 without reading the baseline
      // would satisfy that too, so it has to say what it checked.
      expect(result.stdout, "the step must report how many entries it checked").toMatch(/1\b/);
    });

    it("fails, naming the fingerprint and the commit, on an entry that is not an ancestor of HEAD", () => {
      const orphan = finding(unmerged, "tests/security/orphan.test.ts");
      const result = runStep(join(root, "checkout"), [
        finding(reachable, "tests/security/token-cipher.test.ts"),
        orphan,
      ]);
      expect(
        result.status,
        "a baseline naming a commit that is not an ancestor of HEAD is a defect in a tracked artefact, and " +
          "this step is the only thing that ever notices it",
      ).not.toBe(0);
      // Both halves, in one substring. Asserting the fingerprint alone would be
      // satisfied by any message echoing the commit, because gitleaks builds the
      // fingerprint out of it; asserting the commit alone would not say WHICH
      // entry. The exact expected sentence is what a human reads at 04:41 UTC each
      // day, so it is what is pinned.
      expect(
        `${result.stdout}\n${result.stderr}`,
        "the failure must name the entry's fingerprint AND the commit it names",
      ).toContain(`${orphan.Fingerprint} names commit ${unmerged}`);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/not an ancestor/i);
    });

    it("accepts a baseline entry reachable only from the PR root", () => {
      const repo = join(root, "checkout");
      expect(tryGit(repo, "merge-base", "--is-ancestor", unmerged, "HEAD").status).toBe(1);
      const result = runStep(repo, [finding(reachable, "tests/main.ts"), finding(unmerged, "tests/pr.ts")], true);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("all 2 entries");
    });

    it("rejects an entry reachable from neither HEAD nor the additional root", () => {
      const repo = join(root, "checkout");
      git(repo, "checkout", "--quiet", "-b", "other");
      git(repo, "commit", "--allow-empty", "-m", "outside both roots");
      const orphanCommit = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "--quiet", "main");
      const orphan = finding(orphanCommit, "tests/neither.ts");
      const result = runStep(repo, [finding(unmerged, "tests/pr.ts"), orphan], true);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(`${orphan.Fingerprint} names commit ${orphanCommit}`);
      expect(result.stderr).toMatch(/not an ancestor/i);
    });

    it("fails, by name, on an entry whose commit this checkout does not carry at all", () => {
      const absent = "0123456789abcdef0123456789abcdef01234567";
      const orphan = finding(absent, "tests/security/never-committed.test.ts");
      const result = runStep(join(root, "checkout"), [finding(reachable, "tests/security/token-cipher.test.ts"), orphan]);
      expect(result.status, "an entry naming a commit absent from the checkout is the same defect").not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`, "the two faults have different fixes, so they get different messages").toContain(
        `${orphan.Fingerprint} names commit ${absent}`,
      );
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/not an ancestor/i);
    });

    it("refuses to answer in a shallow checkout, where every verdict would be a false alarm", async () => {
      // Its own repository, because making this one shallow would poison the
      // cases above. A shallow checkout cannot distinguish "this repository does
      // not have the commit" from "this checkout was not fetched far enough", so
      // the honest answer there is to refuse rather than to report a defect that
      // is not there — which is what a step this one would otherwise do daily,
      // if anyone ever pointed it at a shallow checkout.
      const shallowPath = join(root, "shallow");
      await mkdir(shallowPath, { recursive: true });
      git(shallowPath, "init", "--quiet", "--initial-branch=main");
      const head = await commitFiles(shallowPath, { "README.md": "# shallow\n" }, "root");
      await mkdir(join(shallowPath, "scripts"), { recursive: true });
      await mkdir(join(shallowPath, ".github"), { recursive: true });
      await copyFile(resolve(SCRIPT), join(shallowPath, SCRIPT));
      // What `git clone --depth N` leaves behind: the boundary commit listed in
      // .git/shallow, which is what makes `rev-parse --is-shallow-repository`
      // answer true. A real shallow clone rather than a stubbed answer, so the
      // guard is shown to read the property and not a variable.
      await writeFile(join(shallowPath, ".git", "shallow"), `${head}\n`, "utf8");

      const result = runStep(shallowPath, [finding(head, "tests/security/token-cipher.test.ts")]);
      expect(result.status, "the step must refuse rather than report a false orphan").not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`, "and it must say why, naming the depth it needs").toMatch(/shallow/i);
    });

    it("cannot pass on a baseline it did not read", () => {
      // A vacuous pass is the failure this whole repository keeps removing. Two
      // shapes, because they fail for different reasons and only one of them is
      // quiet:
      //
      //  - `[]` is a document jq READS SUCCESSFULLY and that yields no entries
      //    to, so nothing rejects it and the loop simply iterates zero times.
      //    This is the vacuous pass itself, and the step guards it.
      //  - `{findings: []}` is a document jq cannot index, so it dies at the read
      //    and the step's guard never runs. Also correct — it fails loudly — but
      //    for a different reason, so it is not asked to carry the guard's
      //    message.
      const empty = runStep(join(root, "checkout"), []);
      expect(empty.status, "the step must not report success on a baseline it read nothing from").not.toBe(0);
      expect(`${empty.stdout}\n${empty.stderr}`, "and it must say it checked nothing").toMatch(
        /checked nothing|no entries|nothing to check/i,
      );

      const reshaped = runStep(join(root, "checkout"), { findings: [] });
      expect(reshaped.status, "the step must not report success on a baseline that is not the array gitleaks emits").not.toBe(0);
    });
  });

  it("is tracked under the deny-by-default ignore policy", () => {
    for (const path of [
      ".github/workflows/secret-scan.yml",
      ".github/gitleaks-baseline.json",
      "scripts/secret-scan.sh",
      "scripts/secret-scan-baseline.sh",
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
 *
 * `env: scratchGitEnv` and the timeout are hygiene rather than a fix for a hole
 * that exists here, and it is worth saying which is which because the provenance
 * predicates needed the same option for a real exposure and a reader would
 * otherwise assume both were the same thing.
 *
 * Measured: a `GIT_DIR` redirect does NOT change this function's answer. Git's
 * ignore precedence puts the working tree's `.gitignore` above both
 * `info/exclude` and `core.excludesFile`, so the rule that decides a path here is
 * read from this checkout's own `.gitignore` whichever repository GIT_DIR names.
 * `GIT_DIR=/a/shallow/clone/.git` and `core.excludesFile` pointed at a
 * `*`-pattern file both left the answer at 1, exactly as unredirected.
 *
 * What the env does block is `GIT_INDEX_FILE` and a user's `core.excludesFile`
 * reaching the call, which is the same class the helper exists for, and the
 * timeout is because a synchronous call cannot be preempted by vitest's own
 * `testTimeout`.
 */
function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
    env: scratchGitEnv,
    timeout: 10_000,
  }).status;
}
