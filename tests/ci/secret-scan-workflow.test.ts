import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv, tryGit } from "../support/scratch-git";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "secret-scan-reachability-")]);

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

const isScan = (step: { uses?: string }) => step.uses?.startsWith("Nitjsefnie-Actions/secret-scan@") ?? false;

const LEGS = [{ file: ".github/workflows/secret-scan.yml", pr: false }, { file: ".github/workflows/pr-gates.yml", pr: true }] as const;

/** The file that carries a given leg, as it is named inside `.github/workflows/`. */
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
    // `workflows:` filter ambiguous, and GitHub's own UI would show two runs
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
    // Ungated on both legs: each file has exactly one event class, so there is
    // nothing left to switch on.
    expect(checkouts[0].if).toBeUndefined();
    const fetch = scan.steps.find((step) => step.name === "Fetch the pull request head");
    if (pr) {
      expect(fetch?.if).toBeUndefined();
      expect(fetch?.env).toEqual({ OVERFLOW_PR_NUMBER: "${{ github.event.pull_request.number }}" });
      expect(fetch?.run).toBe('git fetch --no-tags origin "+refs/pull/${OVERFLOW_PR_NUMBER}/head:refs/remotes/pr/head"');
      expect(scan.steps.indexOf(fetch!)).toBeGreaterThan(scan.steps.indexOf(checkouts[0]));
      expect(scan.steps.indexOf(fetch!)).toBeLessThan(scan.steps.findIndex(isScan));
    } else {
      // The load-bearing half of the split, asserted on the FILE that has to
      // be free of it: no pull-request fetch survives on the push leg, which is
      // what keeps a privileged trigger from reaching a `refs/pull` fetch.
      expect(fetch, "the push/schedule/dispatch leg must fetch no pull-request ref").toBeUndefined();
    }
    for (const step of scan.steps) {
      expect(step.run ?? "").not.toMatch(/git\s+(checkout|switch|reset|worktree)\b/);
    }

    if (pr) {
      const source = readFileSync(resolve(file), "utf8");
      expect(source).toMatch(/pull_request_target:\s*# zizmor: ignore\[dangerous-triggers\]/);
    }
  });

  it("scans and uploads, with the reachability root its leg needs", () => {
    const scanStep = scan.steps.find(isScan);
    const upload = scan.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(scanStep, "no step runs Nitjsefnie-Actions/secret-scan").toBeDefined();
    expect(scanStep?.if).toBeUndefined();
    expect(upload?.if).toBe("${{ always() }}");
    expect(scan.steps.indexOf(upload!)).toBeGreaterThan(scan.steps.indexOf(scanStep!));
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
    // A hung full-history scan must release its runner within a bounded time.
    expect(scan["timeout-minutes"]).toBe(15);
  });

  it("checks out the repository before scanning its history", () => {
    const checkout = scan.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout, "the workflow must check the repository out").toBeDefined();
  });

  it("runs the secret-scan action, and its exit code is the gate", () => {
    const scanStep = scan.steps.find(isScan);
    expect(scanStep, "no step runs Nitjsefnie-Actions/secret-scan").toBeDefined();
    // The whole workflow's signal is this step's exit code. Anything that lets
    // it continue past a nonzero exit turns a detection signal into decoration.
    for (const step of scan.steps) {
      // The upload's tolerated first attempt; verify-step-reachability runs its retry.
      if (step.uses?.startsWith("actions/upload-artifact@") && step.with?.overwrite !== true) continue;
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
    expect(workflow.jobs, "the job id must not be verify").not.toHaveProperty("verify");
    if (!pr) {
      expect(workflow.jobs, "the push scan must not produce actionlint").not.toHaveProperty("actionlint");
      expect(workflow.jobs, "the push scan must not produce ratchet-guard").not.toHaveProperty("ratchet-guard");
    }
    expect(scan.name ?? "", "a job name carrying an expression is a required-checks failure").not.toContain("${{");
  });

  it("checks the ignore list's commits for reachability, as a step that can end the run", () => {
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

    const scanStep = scan.steps.findIndex(isScan);
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
    /** An ancestor of HEAD, so the positive direction has something real to pass on. */
    let reachable = "";
    let orphaned = "";

    const finding = (commit: string, file: string) => ({ Fingerprint: `${commit}:${file}:generic-api-key:116` });

    /** Run the step's `run:` block verbatim in `repoPath`, `entries` committed as .gitleaksignore and the copy deleted as the scan action does. */
    const runStep = (repoPath: string, entries: { Fingerprint: string }[], preamble = "# fixture findings\n") => {
      const lines = entries.map((entry) => `${entry.Fingerprint}\n`).join("");
      writeFileSync(join(repoPath, ".gitleaksignore"), `${preamble}${lines}`, "utf8");
      git(repoPath, "add", ".gitleaksignore");
      git(repoPath, "commit", "--quiet", "--allow-empty", "-m", "the ignore list");
      rmSync(join(repoPath, ".gitleaksignore"));
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
      // A second branch, committed and then deleted: the object survives (no gc
      // runs in this fixture) but nothing names it, so it is on neither HEAD nor
      // the PR root. `unmerged` above cannot play this part — it IS the PR root.
      git(repoPath, "checkout", "--quiet", "-b", "orphan");
      orphaned = await commitFiles(repoPath, { "c.txt": "c\n" }, "on a branch that is deleted");
      git(repoPath, "checkout", "--quiet", "main");
      git(repoPath, "branch", "-D", "orphan");
      expect(tryGit(repoPath, "cat-file", "-e", `${orphaned}^{commit}`).status).toBe(0);
      expect(tryGit(repoPath, "merge-base", "--is-ancestor", orphaned, "HEAD").status).toBe(1);
      expect(tryGit(repoPath, "merge-base", "--is-ancestor", orphaned, "refs/remotes/pr/head").status).toBe(1);
      // Staged last, so the history above is the history git actually has. The
      // script resolves its repository from its OWN location, which is what makes
      // a staged copy the checkout as far as the step is concerned.
      await mkdir(join(repoPath, "scripts"), { recursive: true });
      await copyFile(resolve(SCRIPT), join(repoPath, SCRIPT));
    });

    afterAll(async () => {
      if (root) await tempDirectories.disposeAsync(root);
    });

    it("passes when every commit the ignore list names is an ancestor of HEAD", () => {
      const result = runStep(join(root, "checkout"), [
        finding(reachable, "tests/security/token-cipher.test.ts"),
      ]);
      expect(result.status, `the step must pass on an ignore list naming only reachable commits:\n${result.stdout}\n${result.stderr}`).toBe(0);
      // Not a bare exit code: a step that exited 0 without reading the ignore list
      // would satisfy that too, so it has to say what it checked.
      expect(result.stdout, "the step must report how many entries it checked").toMatch(/1\b/);
    });

    it("reads the list HEAD commits, after the scan action deleted the working-tree copy", () => {
      const repo = join(root, "checkout");
      const result = runStep(repo, [finding(reachable, "tests/a.ts"), finding(reachable, "tests/b.ts")]);
      expect(existsSync(join(repo, ".gitleaksignore"))).toBe(false);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("all 2 entries");
    });

    it("fails, naming the fingerprint and the commit, on an entry on neither root", () => {
      const orphan = finding(orphaned, "tests/security/orphan.test.ts");
      const result = runStep(join(root, "checkout"), [
        finding(reachable, "tests/security/token-cipher.test.ts"),
        orphan,
      ]);
      expect(result.status, "an ignore list naming a commit on neither HEAD nor the pull request is a defect in a tracked " +
        "artefact, and this step is the only thing that ever notices it").not.toBe(0);

      expect(`${result.stdout}\n${result.stderr}`, "the failure must name the entry's fingerprint AND the commit it names")
        .toContain(`${orphan.Fingerprint} names commit ${orphaned}`);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(/not an ancestor/i);
    });

    it(pr
      ? "accepts an ignore-list entry reachable only from the PR root"
      : "rejects an ignore-list entry reachable only from a pull-request ref, because this leg has no PR root", () => {
      const repo = join(root, "checkout");
      expect(tryGit(repo, "merge-base", "--is-ancestor", unmerged, "HEAD").status).toBe(1);
      const result = runStep(repo, [finding(reachable, "tests/main.ts"), finding(unmerged, "tests/pr.ts")]);

      if (pr) {
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(result.stdout).toContain("all 2 entries");
      } else {
        expect(result.status, "the push leg must not resolve an ignore-list entry against a pull-request ref").not.toBe(0);
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
      expect(`${result.stdout}\n${result.stderr}`, "the two faults have different fixes, so they get different messages")
        .toContain(`${orphan.Fingerprint} names commit ${absent}`);
      expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/not an ancestor/i);
    });

    it("fails, naming it, when HEAD commits no ignore list", () => {
      const repo = join(root, "checkout");
      runStep(repo, []);
      git(repo, "rm", "--quiet", "--cached", ".gitleaksignore");
      git(repo, "commit", "--quiet", "-m", "no ignore list");
      const result = spawnSync("bash", ["-e", "-c", step().run!], { cwd: repo, encoding: "utf8", env: scratchGitEnv });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("the committed ignore list is missing: HEAD:.gitleaksignore");
    });

    it("refuses to answer in a shallow checkout, where every verdict would be a false alarm", async () => {
      const shallowPath = join(root, "shallow");
      await mkdir(shallowPath, { recursive: true });
      git(shallowPath, "init", "--quiet", "--initial-branch=main");
      const head = await commitFiles(shallowPath, { "README.md": "# shallow\n" }, "root");
      await mkdir(join(shallowPath, "scripts"), { recursive: true });
      await copyFile(resolve(SCRIPT), join(shallowPath, SCRIPT));
      await writeFile(join(shallowPath, ".git", "shallow"), `${head}\n`, "utf8");

      const result = runStep(shallowPath, [finding(head, "tests/security/token-cipher.test.ts")]);
      expect(result.status, "the step must refuse rather than report a false orphan").not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`, "and it must say why, naming the depth it needs").toMatch(/shallow/i);
    });

    it("cannot pass on an ignore list it did not read", () => {
      const empty = runStep(join(root, "checkout"), []);
      expect(empty.status, "the step must not report success on an ignore list it read nothing from").not.toBe(0);
      expect(`${empty.stdout}\n${empty.stderr}`, "and it must say it checked nothing").toMatch(/checked nothing|no entries|nothing to check/i);

      const global = runStep(join(root, "checkout"), [{ Fingerprint: "tests/a.ts:generic-api-key:1" }]);
      expect(global.status, "an entry naming no commit gives the step nothing to check").not.toBe(0);
    });

    it("reads comments, blank lines and a missing final newline the way gitleaks does", () => {
      const repo = join(root, "checkout");
      const result = runStep(repo, [], `# a comment\n\n  ${finding(reachable, "tests/a.ts").Fingerprint}  \n${finding(reachable, "tests/b.ts").Fingerprint}`);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("all 2 entries");
    });
  });

  it("is tracked under the deny-by-default ignore policy", () => {
    for (const path of [
      // Both legs, per the file under test: a split producer whose new file is
      // invisible to git ships nothing, and this workflow's whole job is to
      // scan what actually landed.
      file,
      ".gitleaksignore",
      "scripts/secret-scan-baseline.sh",
    ]) {
      expect(checkIgnore(path), `${path} must be named back by .gitignore, or it is invisible to git despite existing on disk`).toBe(1);
    }

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
