import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * `pnpm audit` exits 1 both when the lockfile carries advisories and when the
 * registry could not answer, so a bare `pnpm audit` step cannot tell a finding
 * from an outage. Issue 985 asks for a retry that fires on the second and only
 * on the second, so this suite pins the decision by running the SHIPPED run
 * script against a scripted advisory endpoint — the same shape
 * tests/ci/docs-only-step.test.ts uses for ci.yml's docs-only step. Nothing
 * here touches a network or a registry: `pnpm` is a stub first on PATH that
 * replays outputs captured from pnpm 10.33.0, and the suite asserts on the
 * exit status and on how many times the stub was called.
 *
 * The captured outputs are the whole reason this suite can be written at all,
 * and they are worth stating because they are what the classification rests on:
 *
 * | outcome            | exit | stdout                                             |
 * |--------------------|-----:|----------------------------------------------------|
 * | clean lockfile     |    0 | `advisories: {}` plus `metadata.vulnerabilities`    |
 * | advisories present |    1 | `advisories: {<id>: …}` plus `metadata.vulnerabilities` |
 * | registry 5xx / 429 |    1 | `error.code: "ERR_PNPM_AUDIT_BAD_RESPONSE"`          |
 * | transport failure  |    1 | `error.code: "ECONNREFUSED"`                        |
 *
 * The registry rows are `pnpm audit --json` output against a local server that
 * answered the advisory endpoint with 503 and 429 respectively; pnpm tries
 * `…/audits/quick` first, falls back to `…/audits`, and throws
 * `AUDIT_BAD_RESPONSE` naming BOTH statuses, which is why the shipped script
 * reads the statuses back out of `error.message` instead of retrying on any
 * error at all. Every audit case writes to stdout and leaves stderr empty, so
 * the classification reads stdout.
 */

type ScriptedOutcome = { code: number; stdout: string; stderr: string };

/** `pnpm audit --json` over a lockfile with no known vulnerabilities. */
const CLEAN: ScriptedOutcome = {
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    actions: [],
    advisories: {},
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
      dependencies: 688,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 688,
    },
  }),
};

/** `pnpm audit --json` over a lockfile pinning lodash 4.17.11 (trimmed). */
const ADVISORIES: ScriptedOutcome = {
  code: 1,
  stderr: "",
  stdout: JSON.stringify({
    actions: [],
    advisories: {
      1106913: {
        findings: [{ version: "4.17.11", paths: [".>lodash"] }],
        module_name: "lodash",
        severity: "high",
        title: "Command Injection in lodash",
        vulnerable_versions: "<4.17.21",
        patched_versions: ">=4.17.21",
      },
    },
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 3, high: 3, critical: 1 },
      dependencies: 1,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 1,
    },
  }),
};

/** `pnpm audit --json` against an advisory endpoint answering `status`. */
function registryFailure(status: number, code: string): ScriptedOutcome {
  return {
    code: 1,
    stderr: "",
    stdout: JSON.stringify({
      error: {
        code,
        message:
          "The audit endpoint (at http://127.0.0.1:40857/-/npm/v1/security/audits/quick) responded with "
          + `${status}: {"error":"service unavailable"}. Fallback endpoint (at `
          + `http://127.0.0.1:40857/-/npm/v1/security/audits) responded with ${status}: {"error":"service unavailable"}`,
      },
    }),
  };
}

const SERVER_5XX = registryFailure(503, "ERR_PNPM_AUDIT_BAD_RESPONSE");
const RATE_LIMITED = registryFailure(429, "ERR_PNPM_AUDIT_BAD_RESPONSE");
const FORBIDDEN = registryFailure(403, "ERR_PNPM_AUDIT_BAD_RESPONSE");
const REFUSED: ScriptedOutcome = {
  code: 1,
  stderr: "",
  stdout: JSON.stringify({
    error: {
      code: "ECONNREFUSED",
      message: "request to http://127.0.0.1:1/-/npm/v1/security/audits/quick failed, reason: connect ECONNREFUSED 127.0.0.1:1",
    },
  }),
};

/**
 * What pnpm writes when it cannot run the audit at all: an unusable invocation
 * exits 1 with EMPTY stdout and the complaint on stderr. Nothing here may read
 * that as a clean lockfile.
 */
const UNREADABLE: ScriptedOutcome = { code: 1, stdout: "", stderr: " ERROR  Unknown option: 'audit-level'\n" };

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: unknown;
};

describe("the dependency audit workflow's audit step", () => {
  let steps: Step[] = [];
  let auditSteps: Step[] = [];

  beforeAll(async () => {
    const workflow = parse(await readFile(resolve(".github/workflows/dependency-audit.yml"), "utf8")) as {
      jobs?: { audit?: { steps?: Step[] } };
    };
    steps = workflow.jobs?.audit?.steps ?? [];
    auditSteps = steps.filter((step) => step.name === "Audit lockfile advisories");
  });

  it("exists exactly once, and never tolerates its own failure", () => {
    expect(auditSteps).toHaveLength(1);
    // `continue-on-error` here would swallow the very signal the workflow
    // exists to raise: a step that cannot fail cannot report an advisory.
    expect(Boolean(auditSteps[0]?.["continue-on-error"])).toBe(false);
  });

  it("executes nothing from the pull request, and reads the lockfile as data", () => {
    // Issue 985's scope guard: the audit reads pnpm-lock.yaml and queries the
    // registry's advisory endpoint. It never runs anything the pull request
    // authored, because on a `pull_request` event the checkout IS the pull
    // request. Each of the three shapes that would break that boundary is
    // denied by name rather than left to a whole-job diff.
    const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toHaveLength(1);
    // A `ref:` or `repository:` from the event would fetch a different tree
    // than the lockfile under audit belongs to.
    expect(checkout[0]?.with?.ref).toBeUndefined();
    expect(checkout[0]?.with?.repository).toBeUndefined();
    const run = auditSteps[0]?.run ?? "";
    // No install, so no PR-authored manifest is ever resolved and executed:
    // `pnpm audit` reads pnpm-lock.yaml directly.
    expect(run).not.toMatch(/\b(pnpm|npm|yarn)\s+(ci|install|i)\b/);
    // No expression is interpolated into the shell, so nothing about the event
    // can become a command. The step's inputs are reads of what pnpm wrote.
    expect(run.includes("${{")).toBe(false);
  });

  it("keeps the retry inside the workflow, where a pull request cannot replace it", () => {
    // The classifier is a run-script step rather than a module under
    // `scripts/`, and that placement IS the fork boundary: on a
    // `pull_request` event `actions/checkout` checks out the pull request, so
    // `node scripts/<anything>.ts` would execute the pull request's copy of it.
    const run = auditSteps[0]?.run ?? "";
    expect(run).not.toMatch(/\bnode\s+(\.\/)?scripts\//);
    expect(run).not.toMatch(/\bbash\s+(\.\/)?scripts\//);
  });

  it("reads the audit's own output rather than a report file a pull request could stage", () => {
    // `pnpm audit` is the only thing that writes the report here. A path under
    // version control would be pull-request-staged input to a decision.
    expect(auditSteps[0]?.run ?? "").toMatch(/pnpm audit --json/);
  });

  it("keeps a retry delay of its own, so the shipped backoff is not a test-only zero", () => {
    // The suite below zeroes the delay to run in milliseconds. Without a
    // shipped default, zeroing it would be the only value the delay ever had
    // and the retry would hammer the endpoint from CI.
    expect(auditSteps[0]?.run ?? "").toContain("DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS:-30");
  });

  describe("run against a scripted advisory endpoint", () => {
    let root = "";
    let cases = 0;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "dependency-audit-retry-"));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /**
     * Runs the step's own run script the way the runner would — `bash -e`, a
     * script file, its own working directory — with a `pnpm` stub first on
     * PATH. The stub replays `outcomes` in order and counts its own
     * invocations, so `attempts` is how many times the audit actually ran:
     * that is the whole difference between "retried and then succeeded" and
     * "retried and still failing".
     */
    function runStep(outcomes: ScriptedOutcome[]): { status: number | null; stdout: string; attempts: number } {
      cases += 1;
      const home = join(root, `case-${cases}`);
      mkdirSync(join(home, "bin"), { recursive: true });
      const counter = join(home, "counter");
      writeFileSync(counter, "0");
      writeFileSync(join(home, "outcomes.json"), JSON.stringify(outcomes));
      const stub = join(home, "bin", "pnpm");
      writeFileSync(
        stub,
        [
          "#!/usr/bin/env node",
          'const fs = require("node:fs");',
          'const dir = process.env.AUDIT_STUB_DIR;',
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
      chmodSync(stub, 0o755);

      const script = join(home, "audit.sh");
      writeFileSync(script, auditSteps[0]!.run!);

      const result = spawnSync("bash", ["-e", script], {
        cwd: home,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(home, "bin")}:${process.env.PATH}`,
          AUDIT_STUB_DIR: home,
          // The retry's backoff is real in CI and irrelevant here; the shipped
          // default is pinned above, so zeroing it for the run costs no
          // coverage.
          DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS: "0",
        },
      });
      return {
        status: result.status,
        stdout: result.stdout,
        attempts: Number(readFileSync(counter, "utf8").trim()),
      };
    }

    it("passes a clean lockfile without retrying", () => {
      const outcome = runStep([CLEAN]);
      expect(outcome.status).toBe(0);
      expect(outcome.attempts).toBe(1);
    });

    it("fails a lockfile carrying advisories, on the first attempt and without retrying", () => {
      // The narrowness this whole suite exists for: a finding is the answer,
      // not a failure to be re-asked. Retrying it would delay the report and
      // spend runner minutes to arrive at the same verdict.
      const outcome = runStep([ADVISORIES]);
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
    });

    it("retries a transient registry failure and passes when the endpoint recovers", () => {
      const outcome = runStep([SERVER_5XX, CLEAN]);
      expect(outcome.status).toBe(0);
      expect(outcome.attempts).toBe(2);
    });

    it("retries a rate-limited endpoint too — 429 is a transient registry answer", () => {
      const outcome = runStep([RATE_LIMITED, RATE_LIMITED, ADVISORIES]);
      expect(outcome.status).toBe(1);
      // Two retries then the real finding: the loop stops at the finding
      // rather than spending its remaining attempts on it.
      expect(outcome.attempts).toBe(3);
    });

    it("fails after its attempts are spent on a registry outage, having retried each time", () => {
      // One scripted outcome replays forever, so `attempts` is the retry
      // budget. It has to exceed one, or the retry does not exist.
      const outcome = runStep([SERVER_5XX]);
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBeGreaterThan(1);
    });

    it("does not retry a registry answer that is not transient", () => {
      // 403 and 404 are not an outage: the request was answered, and asking
      // again gets the same answer. A transport failure reads the same to a
      // human but gets the same treatment — one attempt, then a red run
      // somebody looks at.
      const forbidden = runStep([FORBIDDEN]);
      expect(forbidden.status).toBe(1);
      expect(forbidden.attempts).toBe(1);
      const refused = runStep([REFUSED]);
      expect(refused.status).toBe(1);
      expect(refused.attempts).toBe(1);
    });

    it("fails closed when the audit produced no readable report at all", () => {
      // pnpm exiting 1 with empty stdout is what an unusable invocation looks
      // like. Reading that as "no advisories" would turn a broken step into a
      // green one, which is the failure mode a detection signal must not have.
      const outcome = runStep([UNREADABLE]);
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
    });
  });
});
