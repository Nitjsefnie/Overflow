import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv, tryGit } from "../support/scratch-git";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "secret-scan-reachability-")]);

// Which gitleaks release the workflow pins is the workflow's business

// the workflow itself instead of repeating a literal here, so a

// the scan script rejects anything the workflow does not name.
const workflowVersion = String(parse(
  readFileSync(resolve(".github/workflows/secret-scan.yml"), "utf8"),
).jobs["secret-scan"].steps.find((step: { name?: string }) => step.name === "Install gitleaks").env.GITLEAKS_VERSION);

const FAKE_GITLEAKS_VERSION = workflowVersion;

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

const LEGS = [
  { file: ".github/workflows/secret-scan.yml", pr: false },
  { file: ".github/workflows/pr-gates.yml", pr: true },
] as const;

const basename = (file: string): string => file.slice(".github/workflows/".length);

describe.each(LEGS)("$file", ({ file, pr }) => {
  let workflow: Workflow;
  let scan: Workflow["jobs"][string];

  beforeAll(async () => {
    workflow = parse(await readFile(resolve(file), "utf8")) as Workflow;
    scan = workflow.jobs["secret-scan"] ?? workflow.jobs.scan;
  });

  it("is named for what it does, and names its leg distinctly", () => {
    // Two workflows sharing one `name:` would make the ledger relay's

    // under one heading with nothing to tell them apart.
    expect(workflow.name).toBe(pr ? "pr gates" : "secret scan");
  });

  it(pr ? "runs on pull_request_target alone" : "runs on push, daily, and on dispatch", () => {
    expect(workflow.on).toEqual(
      pr
        ? { pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] } }
        : {
            push: { branches: ["main"] },
            schedule: [{ cron: "41 4 * * *" }],
            workflow_dispatch: null,
          },
    );
  });

  if (!pr) {
    it("ticks daily at the pinned off-peak UTC slot", () => {
      expect(workflow.on.schedule).toEqual([{ cron: "41 4 * * *" }]);
    });
  }

  if (pr) {
    it("scopes the trusted PR trigger to main only, with no pull_request trigger", () => {
      expect(workflow.on).not.toHaveProperty("pull_request");
      expect(workflow.on.pull_request_target).toEqual({
        branches: ["main"], types: ["opened", "synchronize", "reopened"],
      });
    });
  }

  it("produces exactly the secret-scan check context", () => {
    expect(Object.keys(workflow.jobs)).toEqual(pr
      ? ["actionlint", "ratchet-guard", "secret-scan", "dependency-audit"]
      : ["secret-scan"]);
    expect(scan.name ?? "secret-scan").toBe("secret-scan");
  });

  it(pr ? "uses main's checkout and fetches the PR head only as git objects" : "uses main's checkout, and fetches no pull-request ref", () => {
    const checkouts = scan.steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);

    // nothing left to switch on.
    expect(checkouts[0].if).toBeUndefined();
    const fetch = scan.steps.find((step) => step.name === "Fetch the pull request head");
    if (pr) {
      expect(fetch?.if).toBeUndefined();
      expect(fetch?.env).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
      expect(fetch?.run).toBe('git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"');
      const installIndex = scan.steps.findIndex((step) => step.name === "Install gitleaks");
      expect(scan.steps.indexOf(fetch!)).toBeGreaterThan(scan.steps.indexOf(checkouts[0]));
      expect(scan.steps.indexOf(fetch!)).toBeLessThan(installIndex);
    } else {

      // what keeps a privileged trigger from reaching a `refs/pull` fetch.
      expect(fetch, "the push/schedule/dispatch leg must fetch no pull-request ref").toBeUndefined();
    }
    for (const step of scan.steps) {
      expect(step.run ?? "").not.toMatch(/git\s+(checkout|switch|reset|worktree)\b/);
    }

    // green on the shape.
    if (pr) {
      const source = readFileSync(resolve(file), "utf8");
      expect(source).toMatch(/pull_request_target:\s*# zizmor: ignore\[dangerous-triggers\]/);
    }
  });

  it("scans and uploads, with the reachability root its leg needs", () => {
    const scanStep = scan.steps.find((step) => step.name === "Scan the full history");
    const upload = scan.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(scanStep?.run).toBe("bash scripts/secret-scan.sh");
    expect(scanStep?.if).toBeUndefined();
    expect(scanStep?.env).toEqual({ GITLEAKS_REPORT_PATH: "gitleaks-report.json" });
    expect(upload?.if).toBe("${{ always() }}");
    expect(upload?.with?.path).toBe(scanStep?.env?.GITLEAKS_REPORT_PATH);
    const checks = scan.steps.filter((step) => /scripts\/secret-scan-baseline\.sh/.test(step.run ?? ""));
    expect(checks.map((step) => [step.if, step.run])).toEqual([
      [undefined, pr ? "bash scripts/secret-scan-baseline.sh refs/remotes/pr/head" : "bash scripts/secret-scan-baseline.sh"],
    ]);
    for (const check of checks) expect(scan.steps.indexOf(check)).toBeGreaterThan(scan.steps.indexOf(upload!));
  });

  it("rejects an event without a scan path", () => {
    const gate = scan.steps.find((step) => step.name === "Refuse unhandled events");
    expect(gate?.run).toBeDefined();
    expect(scan.steps.indexOf(gate!)).toBe(0);
    const accepted = pr ? ["pull_request_target"] : ["push", "schedule", "workflow_dispatch"];
    for (const event of ["push", "pull_request_target", "schedule", "workflow_dispatch", "pull_request", "unknown"]) {
      const result = spawnSync("bash", ["-e", "-c", gate!.run!], {
        encoding: "utf8", env: { ...scratchGitEnv, GITHUB_EVENT_NAME: event },
      });
      expect(result.status, `${basename(file)} / ${event}: ${result.stdout} ${result.stderr}`).toBe(
        accepted.includes(event) ? 0 : 1,
      );
    }
  });

  it("reads the repository and nothing more", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("bounds the history scan's runtime", () => {

    expect(scan["timeout-minutes"]).toBe(15);
  });

  it("checks out the repository before scanning its history", () => {
    const checkout = scan.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout, "the workflow must check the repository out").toBeDefined();
  });

  it("verifies and extracts the scanner tarball without a package-manager install", () => {

    // scanner's version, so a bump inside it moves the rule set under a
    // committed baseline with nothing in this repository to change.
    for (const step of scan.steps) {
      const run = step.run ?? "";
      expect(run, "gitleaks must not be installed from a package manager").not.toMatch(
        /(pip|npm|pnpm|yarn|go|apt-get|brew)\s+(install|get)\s+[^\n]*gitleaks/i,
      );
    }

    const install = scan.steps.find((step) => /sha256sum -c/.test(step.run ?? ""));
    expect(install, "no step verifies a downloaded gitleaks tarball with sha256sum -c").toBeDefined();
    const run = install!.run ?? "";
    expect(run, "the install step must extract the binary").toMatch(/tar\s+-xzf/);

    expect(run, "the install step must print the version it installed").toMatch(/gitleaks"?\s+version\b/);
  });

  it("runs the scan script, and the script's exit code is the gate", async () => {
    const scanStep = scan.steps.find((step) => /bash scripts\/secret-scan\.sh/.test(step.run ?? ""));
    expect(scanStep, "no step runs scripts/secret-scan.sh").toBeDefined();

    for (const step of scan.steps) {
      expect(
        step["continue-on-error"],
        `${step.name ?? step.uses ?? "a step"} must not tolerate failure — the run has to be able to go red`,
      ).toBeUndefined();
    }
    // Scoped to the scan step alone: the upload step is REQUIRED to carry

    expect(
      scanStep!.if ?? "",
      "the scan step must not be gated — `if: always()` or `if: failure()` on it is precisely the " +
        "wiring that lets a findings run finish green",
    ).not.toMatch(/always\(\)|failure\(\)|!cancelled|cancelled\(\)/);
  });

  it("uploads the JSON report as an artifact even when the scan failed", () => {
    const upload = scan.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload, "no step uploads the findings report as an artifact").toBeDefined();

    // WHICH line carried the finding.
    expect(upload!.if, "the upload must run on a failed scan too").toMatch(/always\(\)/);
  });

  it("keeps every event value out of run: interpolation", () => {
    for (const step of scan.steps) {

      // inside run:, or a repository or branch name becomes shell source.
      expect(step.run ?? "", `${step.name ?? step.uses ?? "a step"} must not interpolate into run:`).not.toContain(
        "${{",
      );
    }
  });

  it("uses a job id and name that cannot collide with a required check context", () => {

    // name, and .github/required-checks.json names verify, actionlint and

    expect(workflow.jobs, "the job id must not be verify").not.toHaveProperty("verify");
    if (!pr) {
      expect(workflow.jobs, "the push scan must not produce actionlint").not.toHaveProperty("actionlint");
      expect(workflow.jobs, "the push scan must not produce ratchet-guard").not.toHaveProperty("ratchet-guard");
    }
    expect(scan.name ?? "", "a job name carrying an expression is a required-checks failure").not.toContain("${{");
  });

  it("installs a gitleaks that the scan step's OWN shell can resolve by bare name", async () => {

    // steps rather than reading either one.
    //

    // the test itself put on PATH, and the gap between them was owned by

    // scheduled run, with a message that pointed at the wrong cause.
    //

    // way to check it is to run it. This test:
    //

    //      and nothing else;

    //      runs with no network;

    //      three environment variables set to the temp tree;

    //      the next step;
    //   5. asserts the scan step exited 0 and wrote a report.
    //

    // fails with the very message the real job would have printed.
    //

    // which the install-step assertion in this file pins by literal.
    const install = scan.steps.find((step) => /sha256sum -c/.test(step.run ?? ""));
    const consumer = scan.steps.find((step) => /scripts\/secret-scan\.sh/.test(step.run ?? ""));
    expect(install?.run, "no install step to execute").toBeDefined();
    expect(consumer?.run, "no scan step to execute").toBeDefined();

    const root = join(tmpdir(), `secret-scan-runner-${process.pid}-${Date.now()}`);

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

      // the scanner below is a fixture, not gitleaks.
      await mkdir(join(workspace, "scripts"), { recursive: true });
      await mkdir(join(workspace, ".github"), { recursive: true });
      await copyFile(resolve("scripts/secret-scan.sh"), join(workspace, "scripts/secret-scan.sh"));
      await copyFile(resolve(".github/gitleaks-baseline.json"), join(workspace, ".github/gitleaks-baseline.json"));
      await chmod(join(workspace, "scripts/secret-scan.sh"), 0o755);

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
        // fixture digest makes checksum validation execute on real bytes.
        GITLEAKS_SHA256: digest,
      };
      // `bash -e`, which is what a GitHub runner uses for a `run:` block on
      // Linux. Not an optimisation: without errexit a failed command in the

      // 0 — the test would then pass on an install whose checksum did not
      // verify. The reviewer's T-4 mutant is exactly that, and it is green
      // without this flag.
      //

      // either and the point is to reproduce the runner. What makes

      // under `bash -e` without pipefail a pipeline's status is the last

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

      // load-bearing here: the property it makes observable is "a checksum

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

    // which is fine for the report upload and wrong for this.
    expect(
      step!.if ?? "",
      "the reachability step must not be gated — it is the step whose nonzero exit ends the run",
    ).not.toMatch(/always\(\)|failure\(\)|!cancelled|cancelled\(\)/);

    const scanStep = scan.steps.findIndex((candidate) => /bash scripts\/secret-scan\.sh/.test(candidate.run ?? ""));
    const uploadStep = scan.steps.findIndex((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"));
    const reachabilityStep = scan.steps.indexOf(step!);
    expect(scanStep, "no scan step to order against").toBeGreaterThan(-1);
    expect(uploadStep, "no upload step to order against").toBeGreaterThan(-1);
    expect(reachabilityStep, "the reachability step must come after the scan").toBeGreaterThan(scanStep);
    expect(reachabilityStep, "the reachability step must come after the report upload, so a red run still leaves the report").toBeGreaterThan(uploadStep);
  });

  describe("the reachability step, executed against repositories this suite builds", () => {
    const SCRIPT = "scripts/secret-scan-baseline.sh";

    const step = () => {
      const found = scan.steps.find((candidate) => /scripts\/secret-scan-baseline\.sh/.test(candidate.run ?? ""));
      expect(found, "no step runs the baseline-reachability check").toBeDefined();
      return found!;
    };

    let root = "";

    let unmerged = "";

    let reachable = "";

    let orphaned = "";

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

    const runStep = (repoPath: string, baseline: unknown) => {
      writeFileSync(join(repoPath, ".github", "gitleaks-baseline.json"), `${JSON.stringify(baseline, null, 1)}\n`, "utf8");
      return spawnSync("bash", ["-e", "-c", step().run!], {
        cwd: repoPath,
        encoding: "utf8",
        // `scratchGitEnv` already carries this session's NODE_ENV and strips
        // every inherited GIT_* selector, so the step runs against the
        // repository it was pointed at and nothing can redirect it elsewhere.
        env: scratchGitEnv,
      });
    };

    beforeAll(async () => {
      root = await tempDirectories.createAsync(join(tmpdir(), "secret-scan-reachability-"));
      const repoPath = join(root, "checkout");
      await mkdir(repoPath, { recursive: true });
      git(repoPath, "init", "--quiet", "--initial-branch=main");
      await commitFiles(repoPath, { "README.md": "# checkout\n" }, "root");
      reachable = await commitFiles(repoPath, { "a.txt": "a\n" }, "an ancestor");
      git(repoPath, "checkout", "--quiet", "-b", "side");
      unmerged = await commitFiles(repoPath, { "b.txt": "b\n" }, "on a branch that is never merged");
      git(repoPath, "checkout", "--quiet", "main");
      git(repoPath, "update-ref", "refs/remotes/pr/head", unmerged);

      git(repoPath, "checkout", "--quiet", "-b", "orphan");
      orphaned = await commitFiles(repoPath, { "c.txt": "c\n" }, "on a branch that is deleted");
      git(repoPath, "checkout", "--quiet", "main");
      git(repoPath, "branch", "-D", "orphan");
      expect(tryGit(repoPath, "cat-file", "-e", `${orphaned}^{commit}`).status).toBe(0);
      expect(tryGit(repoPath, "merge-base", "--is-ancestor", orphaned, "HEAD").status).toBe(1);
      expect(tryGit(repoPath, "merge-base", "--is-ancestor", orphaned, "refs/remotes/pr/head").status).toBe(1);

      // a staged copy the checkout as far as the step is concerned.
      await mkdir(join(repoPath, "scripts"), { recursive: true });
      await mkdir(join(repoPath, ".github"), { recursive: true });
      await copyFile(resolve(SCRIPT), join(repoPath, SCRIPT));
    });

    afterAll(async () => {
      if (root) await tempDirectories.disposeAsync(root);
    });

    it("passes when every commit the baseline names is an ancestor of HEAD", () => {
      const result = runStep(join(root, "checkout"), [
        finding(reachable, "tests/security/token-cipher.test.ts"),
      ]);
      expect(
        result.status,
        `the step must pass on a baseline naming only reachable commits:\n${result.stdout}\n${result.stderr}`,
      ).toBe(0);

      // would satisfy that too, so it has to say what it checked.
      expect(result.stdout, "the step must report how many entries it checked").toMatch(/1\b/);
    });

    it("fails, naming the fingerprint and the commit, on an entry on neither root", () => {

      // the pull-request leg, which reads it as a second root. The commit on
      // neither root is the only one both legs reject.
      const orphan = finding(orphaned, "tests/security/orphan.test.ts");
      const result = runStep(join(root, "checkout"), [
        finding(reachable, "tests/security/token-cipher.test.ts"),
        orphan,
      ]);
      expect(
        result.status,
        "a baseline naming a commit on neither HEAD nor the pull request is a defect in a tracked " +
          "artefact, and this step is the only thing that ever notices it",
      ).not.toBe(0);

      // day, so it is what is pinned.
      expect(
        `${result.stdout}\n${result.stderr}`,
        "the failure must name the entry's fingerprint AND the commit it names",
      ).toContain(`${orphan.Fingerprint} names commit ${orphaned}`);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/not an ancestor/i);
    });

    it(pr
      ? "accepts a baseline entry reachable only from the PR root"
      : "rejects a baseline entry reachable only from a pull-request ref, because this leg has no PR root", () => {
      const repo = join(root, "checkout");
      expect(tryGit(repo, "merge-base", "--is-ancestor", unmerged, "HEAD").status).toBe(1);
      const result = runStep(repo, [finding(reachable, "tests/main.ts"), finding(unmerged, "tests/pr.ts")]);

      // root, so an entry reachable only there passes there and FAILS on the

      // files would have papered over the split rather than pinned it.
      if (pr) {
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("all 2 entries");
      } else {
        expect(result.status, "the push leg must not resolve a baseline entry against a pull-request ref").not.toBe(0);
        expect(result.stderr).toContain(`${finding(unmerged, "tests/pr.ts").Fingerprint} names commit ${unmerged}`);
      }
    });

    it("rejects an entry reachable from neither HEAD nor the additional root", () => {
      const repo = join(root, "checkout");
      git(repo, "checkout", "--quiet", "-b", "other");
      git(repo, "commit", "--allow-empty", "-m", "outside both roots");
      const orphanCommit = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "--quiet", "main");
      const orphan = finding(orphanCommit, "tests/neither.ts");
      const result = runStep(repo, [finding(unmerged, "tests/pr.ts"), orphan]);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
      expect(result.stderr).toContain(`${orphan.Fingerprint} names commit ${orphanCommit}`);
      expect(result.stderr).toMatch(/not an ancestor/i);
    });

    it("fails, by name, on an entry whose commit this checkout does not carry at all", () => {
      const absent = "0123456789abcdef".repeat(3).slice(0, 40);
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

      // if anyone ever pointed it at a shallow checkout.
      const shallowPath = join(root, "shallow");
      await mkdir(shallowPath, { recursive: true });
      git(shallowPath, "init", "--quiet", "--initial-branch=main");
      const head = await commitFiles(shallowPath, { "README.md": "# shallow\n" }, "root");
      await mkdir(join(shallowPath, "scripts"), { recursive: true });
      await mkdir(join(shallowPath, ".github"), { recursive: true });
      await copyFile(resolve(SCRIPT), join(shallowPath, SCRIPT));

      // guard is shown to read the property and not a variable.
      await writeFile(join(shallowPath, ".git", "shallow"), `${head}\n`, "utf8");

      const result = runStep(shallowPath, [finding(head, "tests/security/token-cipher.test.ts")]);
      expect(result.status, "the step must refuse rather than report a false orphan").not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`, "and it must say why, naming the depth it needs").toMatch(/shallow/i);
    });

    it("cannot pass on a baseline it did not read", () => {

      // quiet:
      //

      //    This is the vacuous pass itself, and the step guards it.

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

      // invisible to git ships nothing, and this workflow's whole job is to
      // scan what actually landed.
      file,
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

    // in those directories. The junk under .github/workflows/ carries the

    // glob, so an unshipped .yml there would legitimately be named back.
    for (const path of [".github/workflows/junk.yaml", ".github/junk.txt", "scripts/junk.sh"]) {
      expect(checkIgnore(path), `${path} is junk and must stay ignored`).toBe(0);
    }
  });
});

function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
    env: scratchGitEnv,
    timeout: 10_000,
  }).status;
}
