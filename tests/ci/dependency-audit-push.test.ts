import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const prefix = join(tmpdir(), "dependency-audit-push-");
const tempDirectories = createOwnedTempDirectoryRegistry([prefix]);

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
    // Deployment requires an audit conclusion even when the manifests are unchanged.
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
    // Event data reaches the shell through env.
    expect(auditStep?.env).toEqual({
      OVERFLOW_EVENT_NAME: "${{ github.event_name }}",
      OVERFLOW_BEFORE_SHA: "${{ github.event.before }}",
    });
    expect(auditStep?.run ?? "").not.toContain("${{");
  });

  it("classifies inside the script, and every ambiguity falls through to the audit", () => {
    const run = auditStep?.run ?? "";
    // The fast path is gated on the push event only.
    expect(run).toContain('[ "${OVERFLOW_EVENT_NAME:?}" = "push" ]');
    // The before-SHA must be 40 hex and not the all-zeros SHA a new branch
    // or a force push carries.
    expect(run).toContain(`printf '%s' "\${OVERFLOW_BEFORE_SHA}" | grep -Eq '^[0-9a-f]{40}$'`);
    expect(run).toContain(`[ "\${OVERFLOW_BEFORE_SHA}" != "${"0".repeat(40)}" ]`);
    // The before commit must be present and an ancestor of the pushed HEAD.
    expect(run).toContain('git cat-file -e "${OVERFLOW_BEFORE_SHA}^{commit}"');
    expect(run).toContain('git merge-base --is-ancestor "${OVERFLOW_BEFORE_SHA}" HEAD');
    // The manifest diff is the classification itself.
    expect(run).toContain('git diff --quiet "${OVERFLOW_BEFORE_SHA}" HEAD -- package.json pnpm-lock.yaml');
    // The outcome is recorded inside the branch; the audit follows untouched.
    expect(run.indexOf(FAST_PATH_MARKER)).toBeGreaterThan(-1);
    expect(run.indexOf("exit 0")).toBeGreaterThan(run.indexOf(FAST_PATH_MARKER));
    expect(run).toContain("set -uo pipefail");
  });

  it("checks out enough history for the ancestor check", () => {
    // A shallow checkout cannot establish ancestry.
    const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toHaveLength(1);
    expect(checkout[0]?.with?.["fetch-depth"]).toBe(0);
  });
});

describe.skipIf(process.platform !== "linux")("the shipped audit step on real push diffs", () => {
  let root: string;
  let base: string;
  let sequence = 0;
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
  }
  function change(path: string, content: string) {
    git("checkout", "-q", "--detach", base);
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git("add", "--", path);
    git("commit", "-qm", "change");
  }
  beforeAll(async () => {
    root = await tempDirectories.createAsync(prefix);
    git("init", "-qb", "main");
    writeFileSync(join(root, "package.json"), '{"name":"scratch","version":"1.0.0","private":true}\n');
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies: {}\n");
    git("add", ".");
    git("commit", "-qm", "before");
    base = git("rev-parse", "HEAD");
    const bin = join(root, "bin");
    mkdirSync(bin);
    // The retry suite supplies sequences of responses. For classification one
    // fixed registry answer suffices, and every pnpm and sleep call is logged.
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh
echo pnpm >> "$CALLS"
echo "$AUDIT_RESPONSE"
exit "$AUDIT_STATUS"
`, { mode: 0o755 });
    writeFileSync(join(bin, "sleep"), '#!/bin/sh\necho sleep >> "$CALLS"\nexit 1\n', { mode: 0o755 });
  });
  afterAll(async () => { await tempDirectories.disposeAsync(root); });

  function run(before: string, event = "push", advisory = false) {
    const log = join(root, `calls-${++sequence}`);
    writeFileSync(log, "");
    const advisories = advisory ? { "1106913": { module_name: "scratch-left-pad", severity: "high",
      title: "synthetic advisory for the fixture only", vulnerable_versions: "<1.3.1", patched_versions: ">=1.3.1" } } : {};
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", auditStep!.run!], {
      cwd: root, encoding: "utf8", env: { ...gitEnv, PATH: `${root}/bin:${dirname(process.execPath)}:${process.env.PATH}`,
        OVERFLOW_EVENT_NAME: event, OVERFLOW_BEFORE_SHA: before, CALLS: log, AUDIT_STATUS: advisory ? "1" : "0",
        AUDIT_RESPONSE: JSON.stringify({ advisories, metadata: { vulnerabilities: advisory ? { high: 1 } : {} } }) },
    });
    return { ...result, calls: readFileSync(log, "utf8").trim() };
  }

  it.each(["README.md", ".github/ci-thresholds.json"])("returns success without auditing or sleeping for %s", path => {
    change(path, "changed");
    const result = run(base, "push", true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe("");
    expect(result.stdout).toContain(FAST_PATH_MARKER);
  });

  it.each([
    ["pnpm-lock.yaml", false, 0, "clean — no known vulnerabilities found"],
    ["package.json", true, 1, "scratch-left-pad high"],
  ] as const)("audits a change to %s", (path, advisory, status, message) => {
    change(path, "changed");
    const result = run(base, "push", advisory);
    expect(result.status, result.stderr).toBe(status);
    expect(result.calls).toBe("pnpm");
    expect(result.stdout).not.toContain(FAST_PATH_MARKER);
    expect(result.stdout).toContain(message);
  });

  it.each(["zero", "malformed", "missing", "unrelated", "schedule"])("audits a %s base or event", scenario => {
    change("README.md", "documentation");
    // commit-tree without a parent makes an unrelated commit present in the
    // checkout, so this case exercises ancestry separately from a missing base.
    const bases: Record<string, string> = { zero: "0".repeat(40), malformed: "not-a-sha", missing: "1".repeat(40),
      unrelated: git("commit-tree", "HEAD^{tree}", "-m", "unrelated"), schedule: base };
    const result = run(bases[scenario]!, scenario === "schedule" ? "schedule" : "push");
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toBe("pnpm");
    expect(result.stdout).not.toContain(FAST_PATH_MARKER);
  });
});
