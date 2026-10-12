import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The push leg of the dependency audit always reports (issue 1149 fix round
 * 2). Once branch protection requires `dependency-audit`, the deploy gate
 * derives its required set from protection, so a push whose diff touched no
 * manifest must STILL leave a green `dependency-audit` check-run: a
 * `paths:` filter on the push trigger would strand those pushes and the
 * deploy gate would refuse every one of their deploys. So the trigger fires
 * on every push to main, and the audit step itself classifies: a push whose
 * diff changed neither manifest cannot have changed what the audit reads —
 * the manifest and the lockfile ARE its inputs — so the verdict is recorded
 * green without asking the registry. That classification is an OUTCOME
 * inside the step, never a skip: there is no `if:` on the job or on the
 * audit step, the job always runs, and the check-run always posts.
 *
 * The classification is deliberately narrow, and every ambiguity falls
 * through to the FULL audit: a before-SHA that is not 40 hex, the all-zeros
 * SHA (a new branch or a force push), a before commit missing from the
 * checkout, a before that is not an ancestor of the pushed HEAD, and a diff
 * command error all audit. The schedule and dispatch legs never enter the
 * fast path at all — they audit unconditionally, as they always have.
 *
 * This suite pins the shape structurally (the trigger set, the absence of
 * any skip shape, the env-delivered classification inputs, the classification
 * lines themselves) and behaviorally, by executing the shipped run text over
 * scratch repositories with `pnpm` and `sleep` stubbed first on PATH: the
 * fast path exits 0 with the audit stub never consulted, and every
 * ambiguous or manifest-changing case runs the real audit path.
 */

const LINUX_ONLY = process.platform === "linux";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
};
type Job = {
  if?: unknown;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  steps?: Step[];
};
type Workflow = {
  name?: string;
  on?: unknown;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
};

const PUSH_FILE = ".github/workflows/dependency-audit.yml";
const JOB_NAME = "dependency-audit";
const AUDIT_STEP_NAME = "Audit lockfile advisories";
/** The marker the fast path prints when it records the outcome. */
const FAST_PATH_MARKER = "no manifest change since the previous push — audit skipped, context green";

let workflow: Workflow;
let job: Job | undefined;
let steps: Step[];
let auditStep: Step | undefined;

beforeAll(async () => {
  workflow = parse(await readFile(resolve(PUSH_FILE), "utf8")) as Workflow;
  job = workflow.jobs?.[JOB_NAME];
  expect(job, `dependency-audit.yml must carry a job named ${JOB_NAME}`).toBeDefined();
  steps = job?.steps ?? [];
  auditStep = steps.find((step) => step.name === AUDIT_STEP_NAME);
});

describe("the push trigger always fires", () => {
  it("carries no paths filter, and the workflow carries no pull_request trigger", () => {
    // The deploy gate derives its required set from branch protection, so a
    // push that changed no manifest must still produce a dependency-audit
    // check-run: a paths filter would leave that push with a MISSING context,
    // which protection refuses, and the deploy would be stranded. The
    // pull_request trigger is gone with the completed issue-1090 split: the
    // pull-request leg is dependency-audit-pr.yml, the base-defined one.
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      schedule: [{ cron: "37 6 * * *" }],
      workflow_dispatch: null,
    });
  });
});

describe("the fast path is an outcome, not a skip", () => {
  it("gates neither the job nor the audit step with if:", () => {
    expect(job?.if, "the job must run on every trigger it receives").toBeUndefined();
    expect(auditStep?.if, "the audit must never be step-skipped; it classifies instead").toBeUndefined();
    expect(Boolean(auditStep?.["continue-on-error"])).toBe(false);
  });

  it("receives the classification inputs through env:, never interpolation", () => {
    // github.event.before and the event name reach the shell only through the
    // step's env block; a ${{ }} inside the run block would be an
    // interpolation channel this repository denies everywhere.
    expect(auditStep?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      BEFORE_SHA: "${{ github.event.before }}",
    });
    expect(auditStep?.run ?? "").not.toContain("${{");
  });

  it("classifies inside the script, and every ambiguity falls through to the audit", () => {
    const run = auditStep?.run ?? "";
    // The fast path is gated on the push event only.
    expect(run).toContain('[ "${EVENT_NAME:?}" = "push" ]');
    // The before-SHA must be 40 hex and not the all-zeros SHA a new branch
    // or a force push carries.
    expect(run).toContain('[[ "${BEFORE_SHA:?}" =~ ^[0-9a-f]{40}$ ]]');
    expect(run).toContain('[ "${BEFORE_SHA}" != "0000000000000000000000000000000000000000" ]');
    // The before commit must be present and an ancestor of the pushed HEAD.
    expect(run).toContain('git cat-file -e "${BEFORE_SHA}^{commit}"');
    expect(run).toContain('git merge-base --is-ancestor "${BEFORE_SHA}" HEAD');
    // The manifest diff is the classification itself.
    expect(run).toContain('git diff --quiet "${BEFORE_SHA}" HEAD -- package.json pnpm-lock.yaml');
    // The outcome is recorded inside the branch; the audit follows untouched.
    expect(run.indexOf(FAST_PATH_MARKER)).toBeGreaterThan(-1);
    expect(run.indexOf("exit 0")).toBeGreaterThan(run.indexOf(FAST_PATH_MARKER));
    expect(run).toContain("set -uo pipefail");
  });

  it("checks out enough history for the ancestor check", () => {
    // merge-base --is-ancestor needs the previous tip's history: a depth-1
    // checkout would not hold it and every push would fall through to the
    // full audit, which is safe but never fast.
    const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toHaveLength(1);
    expect(checkout[0]?.with?.["fetch-depth"]).toBe(0);
  });
});

describe.skipIf(!LINUX_ONLY)("the audit step's classification, run over scratch repositories", () => {
  let root = "";
  let cases = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dependency-audit-push-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const BASE_PACKAGE = `${JSON.stringify({ name: "scratch", version: "1.0.0", private: true }, null, 2)}\n`;
  const BASE_LOCKFILE = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n";
  const CLEAN = {
    code: 0,
    stdout: `${JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } })}\n`,
    stderr: "",
  };
  const ADVISORIES = {
    code: 1,
    stdout:
      `${JSON.stringify({
        advisories: {
          "1106913": {
            module_name: "scratch-left-pad",
            severity: "high",
            title: "synthetic advisory for the fixture only",
            vulnerable_versions: "<1.3.1",
            patched_versions: ">=1.3.1",
          },
        },
        metadata: { vulnerabilities: { high: 1 } },
      })}\n`,
    stderr: "",
  };

  /**
   * A scratch checkout at `after`, with `before` an ancestor of it — the
   * state actions/checkout's fetch-depth: 0 leaves on a push event. The
   * caller controls what changed between the two commits.
   */
  async function fixture(
    before: Record<string, string>,
    after: Record<string, string | { mode: string; content: string }>,
  ): Promise<{ workspace: string; beforeSha: string; afterSha: string }> {
    cases += 1;
    const repo = join(root, `repo-${cases}`);
    await mkdir(repo, { recursive: true });
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "scratch repository",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "scratch repository",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const g = (repoDir: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: { ...process.env, ...gitEnv } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    let blobCount = 0;
    const writeBlob = async (content: string): Promise<string> => {
      const file = join(root, `blob-${cases}-${(blobCount += 1)}`);
      await writeFile(file, content);
      return g(repo, "hash-object", "-w", file);
    };
    const commitTree = async (
      entries: Record<string, string | { mode: string; content: string }>,
      message: string,
    ): Promise<void> => {
      for (const [path, entry] of Object.entries(entries)) {
        const spec = typeof entry === "string" ? { mode: "100644", content: entry } : entry;
        const id = await writeBlob(spec.content);
        g(repo, "update-index", "--add", "--cacheinfo", `${spec.mode},${id},${path}`);
      }
      g(repo, "commit", "--quiet", "-m", message);
    };
    g(repo, "init", "--quiet", "--initial-branch=main");
    await commitTree(before, "before");
    const beforeSha = g(repo, "rev-parse", "HEAD");
    await commitTree(after, "after");
    const afterSha = g(repo, "rev-parse", "HEAD");
    g(repo, "checkout", "--quiet", "--detach", afterSha);
    return { workspace: repo, beforeSha, afterSha };
  }

  interface CaseResult {
    status: number | null;
    stdout: string;
    stderr: string;
    invocations: string[];
    sleeps: string[];
  }

  /** Runs the shipped audit-step text with `pnpm` and `sleep` stubbed. */
  async function runStep(
    fx: { workspace: string; beforeSha: string },
    eventName: string,
    beforeSha: string | undefined,
    outcomes: Array<{ code: number; stdout: string; stderr: string }>,
  ): Promise<CaseResult> {
    const home = join(root, `run-${(cases += 1)}`);
    mkdirSync(join(home, "bin"), { recursive: true });
    const stubDir = join(home, "stub");
    mkdirSync(stubDir, { recursive: true });
    writeFileSync(join(stubDir, "outcomes.json"), JSON.stringify(outcomes));
    writeFileSync(join(stubDir, "invocations"), "");
    writeFileSync(join(stubDir, "sleeps"), "");
    writeFileSync(join(stubDir, "counter"), "0");
    writeFileSync(
      join(home, "bin", "pnpm"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        'const dir = process.env.AUDIT_STUB_DIR;',
        'fs.appendFileSync(dir + "/invocations", process.cwd() + "\\t" + process.argv.slice(2).join(" ") + "\\n");',
        'const n = Number(fs.readFileSync(dir + "/counter", "utf8").trim());',
        'fs.writeFileSync(dir + "/counter", String(n + 1));',
        'const outcomes = JSON.parse(fs.readFileSync(dir + "/outcomes.json", "utf8"));',
        "const outcome = outcomes[Math.min(n, outcomes.length - 1)];",
        "process.stdout.write(outcome.stdout);",
        "process.stderr.write(outcome.stderr);",
        "process.exit(outcome.code);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(home, "bin", "sleep"),
      [
        "#!/usr/bin/env node",
        'require("node:fs").appendFileSync(process.env.AUDIT_STUB_DIR + "/sleeps", process.argv.slice(2).join(" ") + "\\n");',
        "",
      ].join("\n"),
    );
    for (const stub of ["pnpm", "sleep"]) chmodSync(join(home, "bin", stub), 0o755);

    const script = join(home, "step.sh");
    await writeFile(script, auditStep?.run ?? "exit 99\n");

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      EVENT_NAME: eventName,
      BEFORE_SHA: beforeSha ?? "",
      AUDIT_STUB_DIR: stubDir,
      DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS: "7",
      PATH: `${join(home, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    };
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: fx.workspace,
      encoding: "utf8",
      env,
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      invocations: (await readFile(join(stubDir, "invocations"), "utf8")).split("\n").filter((line) => line !== ""),
      sleeps: (await readFile(join(stubDir, "sleeps"), "utf8")).split("\n").filter((line) => line !== ""),
    };
  }

  it("records a green outcome without auditing when the push changed no manifest", async () => {
    // The whole point: a docs-only push still leaves a green check-run, and
    // the audit stub is never consulted — the fast path is an outcome, not a
    // deferred or skipped audit. The stub is armed with an advisory to prove
    // the outcome does not depend on what the registry would have said.
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE, "README.md": "one\n" },
      { "README.md": "one\ntwo\n" },
    );
    const outcome = await runStep(fx, "push", fx.beforeSha, [ADVISORIES]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toEqual([]);
    expect(outcome.sleeps).toEqual([]);
    expect(outcome.stdout).toContain(FAST_PATH_MARKER);
  });

  it("runs the full audit when the push changed the lockfile", async () => {
    const changedLock = `${BASE_LOCKFILE}# changed\n`;
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "pnpm-lock.yaml": changedLock },
    );
    const outcome = await runStep(fx, "push", fx.beforeSha, [CLEAN]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toHaveLength(1);
    expect(outcome.stdout).not.toContain(FAST_PATH_MARKER);
    expect(outcome.stdout).toContain("clean — no known vulnerabilities found");
  });

  it("runs the full audit when the push changed the manifest", async () => {
    const changedPkg = `${BASE_PACKAGE}{"changed": true}\n`;
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "package.json": changedPkg },
    );
    const outcome = await runStep(fx, "push", fx.beforeSha, [ADVISORIES]);
    expect(outcome.status).toBe(1);
    expect(outcome.invocations).toHaveLength(1);
    expect(outcome.stdout).toContain("scratch-left-pad high");
  });

  it("audits a before-SHA of all zeros — a new branch or force push is ambiguous", async () => {
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE, "README.md": "one\n" },
      { "README.md": "one\ntwo\n" },
    );
    const outcome = await runStep(fx, "push", "0".repeat(40), [CLEAN]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toHaveLength(1);
  });

  it("audits a malformed before-SHA", async () => {
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE, "README.md": "one\n" },
      { "README.md": "one\ntwo\n" },
    );
    const outcome = await runStep(fx, "push", "not-a-sha", [CLEAN]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toHaveLength(1);
  });

  it("audits a before that is not an ancestor of the pushed head", async () => {
    // A second root commit shares no history with the checked-out head, so
    // the ancestor check must refuse the fast path.
    cases += 1;
    const other = join(root, `other-${cases}`);
    await mkdir(other, { recursive: true });
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "scratch repository",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "scratch repository",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const g = (repoDir: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd: repoDir, encoding: "utf8", env: { ...process.env, ...gitEnv } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    g(other, "init", "--quiet", "--initial-branch=main");
    const unrelated = join(root, `unrelated-blob-${cases}`);
    await writeFile(unrelated, "unrelated\n");
    const id = g(other, "hash-object", "-w", unrelated);
    g(other, "update-index", "--add", "--cacheinfo", `100644,${id},README.md`);
    g(other, "commit", "--quiet", "-m", "unrelated root");
    const unrelatedSha = g(other, "rev-parse", "HEAD");

    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE, "README.md": "one\n" },
      { "README.md": "one\ntwo\n" },
    );
    const outcome = await runStep(fx, "push", unrelatedSha, [CLEAN]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toHaveLength(1);
  });

  it("never enters the fast path off a push event — schedule audits unconditionally", async () => {
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE, "README.md": "one\n" },
      { "README.md": "one\ntwo\n" },
    );
    const outcome = await runStep(fx, "schedule", fx.beforeSha, [CLEAN]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toHaveLength(1);
    expect(outcome.stdout).not.toContain(FAST_PATH_MARKER);
  });
});
