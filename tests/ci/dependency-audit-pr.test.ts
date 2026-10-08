import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Issue 1149: the dependency audit's pull-request leg is a required context
 * produced from a definition the pull request cannot change.
 *
 * `.github/workflows/dependency-audit-pr.yml` runs under `pull_request_target`
 * alone, so it always executes MAIN'S copy of itself; the pull request enters
 * only as git objects (this event's head and base SHAs), its merge tree is
 * built locally with `git merge-tree --write-tree`, and the two manifests are
 * materialized as data into a sanitized RUNNER_TEMP directory that
 * `pnpm audit` reads. The audit half of the step is dependency-audit.yml's own
 * audit step VERBATIM — the five-verdict classifier and the narrow transient
 * retry — so the two legs cannot drift.
 *
 * This suite holds the file to that on two layers:
 *
 *  - STRUCTURAL: the trigger set is closed ({pull_request_target}), there is
 *    no paths filter (the leg must fire on EVERY pull request so the required
 *    context always reports — a missing context blocks a merge as surely as a
 *    red one), the concurrency block is the repository-level shape
 *    tests/ci/concurrency.test.ts requires of a required-context producer, the
 *    job is named `dependency-audit` (the context name the relay matches), the
 *    env pins ride at job level, and the audit portion is byte-identical to
 *    the push leg's.
 *  - BEHAVIORAL: the step's own run text is executed the way the runner does
 *    — bash with the runner's flags over git fixtures — with `pnpm` and
 *    `sleep` stubbed first on PATH. Nothing here touches a network or a
 *    registry: the stub replays outcomes captured from pnpm 10.33.0's output
 *    shapes, and every verdict is asserted on the stub's own record plus the
 *    step's exit status.
 *
 * The both-ways proof the issue asks for lives in the behavioral block: a
 * manifest-touching pull request whose merge-tree lockfile carries an
 * advisory exits nonzero (a red audit), and a pull request that touches no
 * manifest is audited on the base's unchanged bytes and exits zero (the
 * context reports green, never missing).
 */

const LINUX_ONLY = process.platform === "linux";

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { "runs-on"?: string; "timeout-minutes"?: number; env?: Record<string, string>; steps?: Step[] };
type Workflow = {
  name?: string;
  on?: unknown;
  permissions?: Record<string, string>;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
};

const PR_FILE = ".github/workflows/dependency-audit-pr.yml";
const PUSH_FILE = ".github/workflows/dependency-audit.yml";
const JOB_NAME = "dependency-audit";
const AUDIT_STEP_NAME = "Audit the pull request's merge-tree manifests";
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_NODE_SHA = "820762786026740c76f36085b0efc47a31fe5020";

const ENV_PINS: Record<string, string> = {
  COREPACK_ENABLE_PROJECT_SPEC: "0",
  npm_config_registry: "https://registry.npmjs.org/",
  npm_config_strict_ssl: "true",
  npm_config_cafile: "/etc/ssl/certs/ca-certificates.crt",
  npm_config_audit_level: "low",
};

/** Every fixed refusal the step's prologue can print; content-free constants. */
const REFUSALS = {
  fetchHead: "::error::could not fetch the pull request's head",
  fetchBase:
    "::error::could not fetch the pull request's base commit; refusing to audit a tree this event is not about",
  conflict: "does not merge cleanly into its base",
  mergeTree: "::error::git merge-tree could not produce a merge tree for this pull request (exit",
  sanitizedExists:
    "already exists; refusing to write the pull request's manifests into a directory this run did not create",
  manifestEntry: "must be exactly one mode-100644 blob entry in the merge tree; refusing",
};

/** Planted in pull-request-controlled content; must never reach the step's output. */
const MARKER = "GHSA-ATTACKER-MANIFEST-MARKER";

let workflow: Workflow;
let pushWorkflow: Workflow;
let steps: Step[];
let auditStep: Step;

beforeAll(async () => {
  workflow = parse(await readFile(resolve(PR_FILE), "utf8")) as Workflow;
  pushWorkflow = parse(await readFile(resolve(PUSH_FILE), "utf8")) as Workflow;
  const job = workflow.jobs?.[JOB_NAME];
  expect(job, `dependency-audit-pr.yml must carry a job named ${JOB_NAME}`).toBeDefined();
  steps = job?.steps ?? [];
  auditStep = steps.find((step) => step.name === AUDIT_STEP_NAME) as Step;
});

describe("dependency-audit-pr.yml's shape", () => {
  it("is named for the relay's filter, which matches the name: field", () => {
    expect(workflow.name).toBe("dependency audit pull request");
  });

  it("triggers on pull_request_target alone, with no paths filter", () => {
    // The closed trigger set, not a denylist: this file reads pull-request
    // data, so the issue-1090 rule leaves it exactly this trigger and nothing
    // else. A paths filter is equally absent ON PURPOSE: branch protection
    // refuses a MISSING required context, so a leg that skipped no-manifest
    // pull requests would strand them — every pull request must produce a
    // run, and the file-level verdict is the audit's on the merge-tree bytes.
    expect(Object.keys(workflow.on ?? {})).toEqual(["pull_request_target"]);
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
  });

  it("scopes permissions to contents: read", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("carries the repository-level required-producer concurrency shape", () => {
    // One group per repository for pull-request arrivals, cancel false, and
    // the parenthesised event-class form the bounded table pins — the shape
    // tests/ci/concurrency.test.ts refuses to let a required context ship
    // any other way.
    expect(workflow.concurrency).toEqual({
      group:
        "dependency-audit-pr-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
  });

  it("runs the one producing job on the pinned runner image and clock", () => {
    expect(workflow.jobs?.[JOB_NAME]?.["runs-on"]).toBe("ubuntu-latest");
    expect(workflow.jobs?.[JOB_NAME]?.["timeout-minutes"]).toBe(10);
  });

  it("binds the pull-request-controlled inputs for every step that runs pnpm", () => {
    // Job level, like the push leg's: Actions env is step-scoped, so a pin on
    // the installing step never reaches the step that executes the audit.
    // The five values are the push leg's five, exactly — a diverged value
    // here would mean the two legs audit under different rules.
    const jobEnv = workflow.jobs?.[JOB_NAME]?.env ?? {};
    for (const [key, value] of Object.entries(ENV_PINS)) {
      expect(jobEnv[key], `${JOB_NAME}'s job env must pin ${key}=${value}`).toBe(value);
    }
    expect(Object.keys(jobEnv).sort()).toEqual(Object.keys(ENV_PINS).sort());
  });

  it("checks out nothing from the pull request, and executes nothing of the pull request's", () => {
    const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toHaveLength(1);
    expect(checkout[0]?.uses).toBe(`actions/checkout@${CHECKOUT_SHA}`);
    expect(checkout[0]?.with?.ref).toBeUndefined();
    expect(checkout[0]?.with?.repository).toBeUndefined();
    expect(checkout[0]?.with?.["persist-credentials"]).toBe(false);
    // Full history is what lets merge-tree below find the two commits' true
    // merge base; a shallow pair reads as unrelated histories.
    expect(checkout[0]?.with?.["fetch-depth"]).toBe(0);

    const setup = steps.filter((step) => step.uses?.startsWith("actions/setup-node"));
    expect(setup).toHaveLength(1);
    expect(setup[0]?.uses).toBe(`actions/setup-node@${SETUP_NODE_SHA}`);

    const enable = steps.find((step) => step.name === "Enable the pinned package manager");
    expect(enable?.run).toBe("corepack enable\ncorepack install --global pnpm@10.33.0\npnpm --version\n");

    // No step may run anything out of a checkout: the only scripts that
    // execute are this file's own run blocks. And the PR's manifests are
    // read, never installed or executed.
    for (const step of steps) {
      expect(step.run ?? "", `step ${step.name ?? step.uses} must not run a repo script`).not.toMatch(
        /\bnode\s+(\.\/)?scripts\//,
      );
      expect(step.run ?? "").not.toMatch(/\b(pnpm|npm|yarn)\s+(ci|install|i)\b/);
    }
  });

  it("carries exactly the four steps, in the established order", () => {
    expect(steps.map((step) => step.name ?? step.uses)).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
      "Enable the pinned package manager",
      AUDIT_STEP_NAME,
    ]);
  });

  it("receives the event through env:, never through shell interpolation", () => {
    // The wire format of the event reaches the shell only through the step's
    // env block; a ${{ }} inside any run block would be an interpolation
    // channel this repository denies everywhere.
    for (const step of steps) {
      expect(step.run ?? "", `step ${step.name ?? step.uses}`).not.toContain("${{");
    }
    expect(auditStep.env).toEqual({
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      GIT_LFS_SKIP_SMUDGE: "1",
    });
  });

  it("fetches by SHA, builds the merge locally, and materializes with the ls-tree discipline", () => {
    const run = auditStep.run ?? "";
    // The head and base are fetched by their pinned event SHAs. No
    // refs/pull refspec anywhere: a pull-request ref is a ref the pull
    // request's pushes move, and fetching by SHA is what keeps the two
    // commits fixed to this event. Matched against the script's code lines
    // only — the prose above the script names the discipline too.
    const code = run
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).toContain('git fetch --quiet --no-tags origin "${HEAD_SHA:?}"');
    expect(code).toContain('git fetch --quiet --no-tags origin "${BASE_SHA:?}"');
    expect(code).not.toContain("refs/pull");
    // The merge tree is built for THIS event's two SHAs, never read from the
    // asynchronous event payload or a refs/pull merge ref.
    expect(run).toContain('git merge-tree --write-tree "${BASE_SHA:?}" "${HEAD_SHA:?}"');
    // The ls-tree single-blob discipline, per manifest, into a fresh
    // sanitized directory, and the audit reads from it.
    expect(run).toContain('git ls-tree "${1:?}" -- "${2:?}"');
    expect(run).toContain('git cat-file blob "${blob}" > "${sanitized}/${manifest}"');
    expect(run).toContain("for manifest in package.json pnpm-lock.yaml");
    expect(run).toContain("${RUNNER_TEMP}/audit-manifests");
    expect(run).toContain('cd -- "${sanitized}"');
  });

  it("prints only the fixed refusal constants, and no pull-request bytes", () => {
    const run = auditStep.run ?? "";
    const prologue = run.slice(0, run.indexOf("set -uo pipefail"));
    const errorLines = prologue.split("\n").filter((line) => line.includes("::error::"));
    expect(errorLines.length).toBeGreaterThan(0);
    for (const line of errorLines) {
      expect(
        Object.values(REFUSALS).some((constant) => line.includes(constant)),
        `every refusal must be one of the fixed constants; found ${JSON.stringify(line)}`,
      ).toBe(true);
    }
  });

  it("audits with the push leg's own audit step, byte-identical", () => {
    // Extracted comparison, never a hand-copied expectation: the audit half
    // (classifier, verdict dispatch, transient retry) of both files is sliced
    // from the parsed run text and required equal, so the two legs cannot
    // drift and a hand-edit to one fails this equality immediately.
    const portionOf = (source: Workflow, jobKey: string, stepName: string): string => {
      const step = source.jobs?.[jobKey]?.steps?.find((entry) => entry.name === stepName);
      const run = step?.run ?? "";
      const idx = run.indexOf("set -uo pipefail");
      expect(idx, `${stepName} must carry the audit portion`).toBeGreaterThan(-1);
      return run.slice(idx);
    };
    const push = portionOf(pushWorkflow, JOB_NAME, "Audit lockfile advisories");
    const pr = portionOf(workflow, JOB_NAME, AUDIT_STEP_NAME);
    expect(pr).toBe(push);
  });
});

describe.skipIf(!LINUX_ONLY)("the audit step, run over git fixtures", () => {
  let root = "";
  let cases = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "dependency-audit-pr-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const BASE_PACKAGE = `${JSON.stringify({ name: "scratch", version: "1.0.0", private: true }, null, 2)}\n`;
  const BASE_LOCKFILE = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n";
  /** The stub replays these captured-SHAPES; no registry, no real advisory. */
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
  const SERVER_5XX = {
    code: 1,
    stdout: `${JSON.stringify({
      error: {
        code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
        message:
          "The audit endpoint (at http://127.0.0.1:40857/-/npm/v1/security/audits/quick) responded with 503: {\"error\":\"service unavailable\"}. The audit endpoint (at http://127.0.0.1:40857/-/npm/v1/security/audits) responded with 503: {\"error\":\"service unavailable\"}",
      },
    })}\n`,
    stderr: "",
  };

  /** Head entry for a path the pull request DELETES from the base tree. */
  const DELETED = Symbol("deleted");

  /**
   * A scratch origin whose `main` carries `base` at BASE_SHA, plus `head`
   * built on it — the two commits the step is handed as this event's head
   * and base — and a workspace (a full clone, the step's cwd, the state
   * actions/checkout's fetch-depth: 0 leaves on a pull_request_target event).
   */
  async function fixture(
    base: Record<string, string>,
    head: Record<string, string | { mode: string; content: string } | typeof DELETED>,
  ): Promise<{ workspace: string; baseSha: string; headSha: string }> {
    cases += 1;
    const origin = join(root, `origin-${cases}`);
    const workspace = join(root, `workspace-${cases}`);
    await mkdir(origin, { recursive: true });
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "scratch repository",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "scratch repository",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const g = (repo: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    let blobCount = 0;
    const writeBlob = async (repo: string, content: string): Promise<string> => {
      const file = join(root, `blob-${cases}-${(blobCount += 1)}`);
      await writeFile(file, content);
      return g(repo, "hash-object", "-w", file);
    };

    g(origin, "init", "--quiet", "--initial-branch=main");
    g(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    for (const [path, content] of Object.entries(base)) {
      const id = await writeBlob(origin, content);
      g(origin, "update-index", "--add", "--cacheinfo", `100644,${id},${path}`);
    }
    g(origin, "commit", "--quiet", "-m", "base");
    const baseSha = g(origin, "rev-parse", "HEAD");

    for (const [path, entry] of Object.entries(head)) {
      if (entry === DELETED) {
        // The base's entry is still in the index after its commit; a deleted
        // path must leave it explicitly, or write-tree rebuilds the base's
        // file and nothing is deleted.
        g(origin, "update-index", "--force-remove", path);
        continue;
      }
      const spec = typeof entry === "string" ? { mode: "100644", content: entry } : entry;
      const id = await writeBlob(origin, spec.content);
      g(origin, "update-index", "--add", "--cacheinfo", `${spec.mode},${id},${path}`);
    }
    const tree = g(origin, "write-tree");
    const headSha = g(origin, "commit-tree", tree, "-p", baseSha, "-m", "head");
    // main stays at the base, so the clone carries both commits and their
    // shared history in one fetch, and merge-tree below finds their true
    // merge base.
    g(origin, "update-ref", "refs/heads/main", baseSha);
    g(origin, "update-ref", "refs/heads/feature", headSha);

    const clone = spawnSync("git", ["clone", "--quiet", `file://${origin}`, workspace], {
      encoding: "utf8",
      env: { ...process.env, ...gitEnv },
    });
    if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);
    return { workspace, baseSha, headSha };
  }

  interface CaseResult {
    status: number | null;
    stdout: string;
    stderr: string;
    sanitized: string;
    /** The stub's record: one `cwd<TAB>argv` line per invocation. */
    invocations: string[];
    sleeps: string[];
  }

  /**
   * Runs the shipped run text the way the runner does — `bash -e`, a script
   * file, cwd the checkout — with `pnpm` and `sleep` stubbed first on PATH.
   * `pnpm` records its cwd and argv, replays `outcomes` in order, and writes
   * its scripted stdout/stderr for the step to redirect; `sleep` records its
   * argument instead of waiting, so the backoff is asserted on the record of
   * the call rather than on a clock.
   */
  async function runStep(
    fx: { workspace: string; baseSha: string; headSha: string },
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

    const runnerTemp = join(home, "runner-temp");
    await mkdir(runnerTemp);
    const script = join(home, "step.sh");
    await writeFile(script, auditStep.run ?? "exit 99\n");

    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: fx.workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        HEAD_SHA: fx.headSha,
        BASE_SHA: fx.baseSha,
        RUNNER_TEMP: runnerTemp,
        AUDIT_STUB_DIR: stubDir,
        DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS: "7",
        PATH: `${join(home, "bin")}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      sanitized: join(runnerTemp, "audit-manifests"),
      invocations: (await readFile(join(stubDir, "invocations"), "utf8")).split("\n").filter((line) => line !== ""),
      sleeps: (await readFile(join(stubDir, "sleeps"), "utf8")).split("\n").filter((line) => line !== ""),
    };
  }

  it("fails a manifest-touching pull request whose merge-tree lockfile carries an advisory", async () => {
    // The red half of the both-ways proof: the pull request changes
    // pnpm-lock.yaml, the merge tree carries the changed bytes, the audit
    // runs on THOSE bytes, and the classifier's advisories verdict exits
    // nonzero — the red the relay mirrors onto a failing check-run.
    const headLockfile = `${BASE_LOCKFILE}# ${MARKER}\n`;
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "pnpm-lock.yaml": headLockfile },
    );
    const outcome = await runStep(fx, [ADVISORIES]);
    expect(outcome.status).toBe(1);
    // The audit ran exactly once, in the sanitized directory, with the
    // merge-tree bytes on disk.
    expect(outcome.invocations).toHaveLength(1);
    const invocationParts = outcome.invocations[0]!.split("\t");
    expect(invocationParts[0]).toBe(outcome.sanitized);
    expect(invocationParts[1]).toBe("audit --json");
    expect(readFileSync(join(outcome.sanitized, "pnpm-lock.yaml"), "utf8")).toBe(headLockfile);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(BASE_PACKAGE);
    // The verdict detail and the advisory listing reached the log — the
    // step echoes the attempt line with the classifier's verdict and detail,
    // then the detail, then the per-advisory listing.
    expect(outcome.stdout).toContain("exited 1: advisories — 1 advisories (1 high)");
    expect(outcome.stdout).toContain("scratch-left-pad high: synthetic advisory for the fixture only");
    expect(outcome.sleeps).toEqual([]);
  });

  it("passes a no-manifest pull request on the base's unchanged bytes", async () => {
    // The green half: the pull request touches no manifest, the merge tree
    // carries the base's blobs unchanged, and the context reports the same
    // verdict any clean run reports — never a missing check.
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "README.md": "docs only\n" },
    );
    const outcome = await runStep(fx, [CLEAN]);
    expect(outcome.status).toBe(0);
    expect(outcome.invocations).toHaveLength(1);
    expect(outcome.invocations[0]!.split("\t")[1]).toBe("audit --json");
    expect(readFileSync(join(outcome.sanitized, "pnpm-lock.yaml"), "utf8")).toBe(BASE_LOCKFILE);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(BASE_PACKAGE);
    expect(outcome.stdout).toContain("clean — no known vulnerabilities found");
  });

  it("audits the merge tree's bytes, not the head's, when main has advanced past the branch point", async () => {
    // Fix round 1: every green-path fixture above builds a head whose
    // merge-tree bytes EQUAL the head's, so a step that materialized
    // "${HEAD_SHA}" instead of the merged tree passed all of them while
    // auditing the wrong artifact on exactly the pull requests where the two
    // diverge. Here main has ADVANCED past the branch point, and the two
    // sides' lockfile edits sit in different regions of the file, so the
    // merge is clean and its lockfile carries BOTH sides' lines — the head's
    // carries only its own, the (advanced) base's only its own.
    cases += 1;
    const origin = join(root, `origin-advance-${cases}`);
    const workspace = join(root, `workspace-advance-${cases}`);
    await mkdir(origin, { recursive: true });
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "scratch repository",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "scratch repository",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const g = (repo: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    let blobCount = 0;
    const write = async (content: string): Promise<string> => {
      const file = join(root, `advance-blob-${cases}-${(blobCount += 1)}`);
      await writeFile(file, content);
      return g(origin, "hash-object", "-w", file);
    };
    const baseLock = "lockfileVersion: '9.0'\n";
    const lockAtMain = `# main-side prepended\n${baseLock}`;
    const lockAtHead = `${baseLock}# head-side appended\n`;
    const mergedLock = `# main-side prepended\n${baseLock}# head-side appended\n`;
    // The state must actually discriminate: if a future edit collapses these
    // into one string, the fixture can no longer tell a merge-tree read from
    // a head read, and the assertion below would hold for the wrong reason.
    expect(mergedLock).not.toBe(lockAtHead);
    expect(mergedLock).not.toBe(lockAtMain);

    g(origin, "init", "--quiet", "--initial-branch=main");
    g(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    // Branch point: the shared manifests.
    const idPkg = await write(BASE_PACKAGE);
    const id0 = await write(baseLock);
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${idPkg},package.json`);
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${id0},pnpm-lock.yaml`);
    g(origin, "commit", "--quiet", "-m", "branch point");
    const branchPoint = g(origin, "rev-parse", "HEAD");
    // main advances: the lockfile gains a line at the top.
    const idMain = await write(lockAtMain);
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${idMain},pnpm-lock.yaml`);
    g(origin, "commit", "--quiet", "-m", "main advances the lockfile");
    const baseSha = g(origin, "rev-parse", "HEAD");
    // The pull request's head, from the branch point: the lockfile gains a
    // line at the bottom, and nothing else changes.
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${id0},pnpm-lock.yaml`);
    const idHead = await write(lockAtHead);
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${idHead},pnpm-lock.yaml`);
    const headTree = g(origin, "write-tree");
    const headSha = g(origin, "commit-tree", headTree, "-p", branchPoint, "-m", "head advances the lockfile");
    g(origin, "update-ref", "refs/heads/main", baseSha);
    g(origin, "update-ref", "refs/heads/feature", headSha);
    const clone = spawnSync("git", ["clone", "--quiet", `file://${origin}`, workspace], {
      encoding: "utf8",
      env: { ...process.env, ...gitEnv },
    });
    if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);

    const outcome = await runStep({ workspace, baseSha, headSha }, [CLEAN]);
    expect(outcome.status).toBe(0);
    // The bytes the audit actually read are the MERGE tree's lockfile — both
    // sides' lines — not the head's and not the advanced base's.
    expect(readFileSync(join(outcome.sanitized, "pnpm-lock.yaml"), "utf8")).toBe(mergedLock);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(BASE_PACKAGE);
  });

  it("refuses a pull request that deletes a manifest, with the fixed constant", async () => {
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "package.json": DELETED },
    );
    const outcome = await runStep(fx, [CLEAN]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("package.json must be exactly one mode-100644 blob entry");
    expect(outcome.stderr).toContain(REFUSALS.manifestEntry);
    // The audit never ran.
    expect(outcome.invocations).toEqual([]);
  });

  it("refuses a symlinked manifest without leaking its target", async () => {
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "pnpm-lock.yaml": { mode: "120000", content: "/etc/ATTACKER-SYMLINK-TARGET" } },
    );
    const outcome = await runStep(fx, [CLEAN]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr).toContain("pnpm-lock.yaml must be exactly one mode-100644 blob entry");
    expect(outcome.stdout + outcome.stderr).not.toContain("ATTACKER-SYMLINK-TARGET");
    expect(outcome.invocations).toEqual([]);
  });

  it("refuses a pull request that does not merge cleanly, and sends the reader to rebase", async () => {
    // Both sides edit the same line after the branch point: merge-tree exits
    // 1, and the refusal is the conflict constant, not the tool-failure one.
    cases += 1;
    const origin = join(root, `origin-conflict-${cases}`);
    const workspace = join(root, `workspace-conflict-${cases}`);
    await mkdir(origin, { recursive: true });
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "scratch repository",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "scratch repository",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const g = (repo: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv } });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    let blobCount = 0;
    const write = async (content: string): Promise<string> => {
      const file = join(root, `conflict-blob-${cases}-${(blobCount += 1)}`);
      await writeFile(file, content);
      return g(origin, "hash-object", "-w", file);
    };
    g(origin, "init", "--quiet", "--initial-branch=main");
    g(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const id0 = await write('{"name": "scratch", "shared": "line"}\n');
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${id0},package.json`);
    g(origin, "commit", "--quiet", "-m", "branch point");
    const branchPoint = g(origin, "rev-parse", "HEAD");
    // main moves the line one way; the pull request's head, from the same
    // branch point, moves it another. Same path, same region: conflict.
    const idMain = await write('{"name": "scratch", "shared": "main side"}\n');
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${idMain},package.json`);
    g(origin, "commit", "--quiet", "-m", "main moves the line");
    const baseSha = g(origin, "rev-parse", "HEAD");
    g(origin, "update-ref", "refs/heads/main", baseSha);
    const idHead = await write('{"name": "scratch", "shared": "head side"}\n');
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${idHead},package.json`);
    const conflictTree = g(origin, "write-tree");
    const headSha = g(origin, "commit-tree", conflictTree, "-p", branchPoint, "-m", "head side");
    g(origin, "update-ref", "refs/heads/feature", headSha);
    const clone = spawnSync("git", ["clone", "--quiet", `file://${origin}`, workspace], {
      encoding: "utf8",
      env: { ...process.env, ...gitEnv },
    });
    if (clone.status !== 0) throw new Error(`clone failed: ${clone.stderr}`);

    const outcome = await runStep({ workspace, baseSha, headSha }, [CLEAN]);
    expect(outcome.status).toBe(1);
    expect(outcome.stderr + outcome.stdout).toContain(REFUSALS.conflict);
    expect(outcome.stderr + outcome.stdout).toContain("rebase the branch onto the base and push again");
    // The audit never ran: nothing was materialized.
    expect(outcome.invocations).toEqual([]);
  });

  it("spends exactly its retry budget on a registry outage and then fails closed", async () => {
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "README.md": "docs only\n" },
    );
    const outcome = await runStep(fx, [SERVER_5XX]);
    expect(outcome.status).toBe(1);
    expect(outcome.invocations).toHaveLength(3);
    expect(outcome.sleeps).toEqual(["7", "7"]);
    expect(outcome.stdout).toContain("transient");
    expect(outcome.stdout).toContain("still unavailable after 3 attempts");
  });

  it("carries no pull-request byte through any output on the advisory path", async () => {
    // The invariant every refusal shares, exercised on the non-refusal path:
    // nothing the pull request authored is echoed — the step's log carries
    // only the fixed constants, the stub's own scripted verdict, and this
    // file's constants. The manifest bytes land on disk in the sanitized
    // directory (asserted above); they never reach the log.
    const headPackage = `${BASE_PACKAGE}/* ${MARKER} */\n`;
    const fx = await fixture(
      { "package.json": BASE_PACKAGE, "pnpm-lock.yaml": BASE_LOCKFILE },
      { "package.json": headPackage },
    );
    const outcome = await runStep(fx, [ADVISORIES]);
    expect(outcome.status).toBe(1);
    expect(outcome.stdout + outcome.stderr).not.toContain(MARKER);
    expect(readFileSync(join(outcome.sanitized, "package.json"), "utf8")).toBe(headPackage);
  });
});
