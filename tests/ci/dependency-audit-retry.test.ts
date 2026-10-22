import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "dependency-audit-retry-")]);

type ScriptedOutcome = { code: number; stdout: string; stderr: string };

const STEP_TIMEOUT_MS = 120_000;

const STEP_KILL_SIGNAL = "SIGKILL";

const RUNAWAY_MAX_DEPTH = 5;

const RUNAWAY_WAIT_SECONDS = 2;

/**
 * The bound the runaway fixture is deliberately run under. Below the chain's
 * own lifetime, so the chain is guaranteed to still be running when it fires.
 */
const RUNAWAY_BOUND_MS = 1_500;

const SURVIVOR_SETTLE_MS = 4_000;

const STEP_LAUNCHER = 'echo $$ > "$1"; shift; exec bash -e "$@"';

function killTree(pgid: number | undefined, pid: number | undefined): void {
  if (pgid !== undefined) {
    try {
      process.kill(-pgid, STEP_KILL_SIGNAL);
      return;
    } catch (error) {

      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  if (pid !== undefined) {
    try {
      process.kill(pid, STEP_KILL_SIGNAL);
    } catch {
      // Already gone, or not ours to signal.
    }
  }
}

function runBoundedScript(
  script: string,
  home: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  scriptArgs: string[] = [],
): SpawnSyncReturns<string> {
  const pgidFile = join(home, "step-pgid");
  const result = spawnSync("setsid", ["bash", "-c", STEP_LAUNCHER, "step", pgidFile, script, ...scriptArgs], {
    cwd: home,
    encoding: "utf8",
    env,
    timeout: timeoutMs,
    killSignal: STEP_KILL_SIGNAL,
  });
  // The script publishes `$$` before the exec, so this read is after the fact
  // and never races: by now either the file is there or the script never ran.
  let pgid: number | undefined;
  try {
    const published = Number(readFileSync(pgidFile, "utf8").trim());

    const own = ownProcessGroup();
    if (Number.isInteger(published) && published > 1 && published !== process.pid && published !== own) {
      pgid = published;
    }
  } catch {
    // No file: `setsid` never got as far as the script.
  }
  // Unconditional, not only on a timeout: a script that exits can leave a
  // descendant running, and that is the same leak by another route.
  killTree(pgid, result.pid ?? undefined);
  return result;
}

function countProcesses(marker: string): number {
  const found = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  return found.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

function ownProcessGroup(): number | undefined {
  try {
    const stat = readFileSync("/proc/self/stat", "utf8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
    const pgid = Number(afterComm[2]);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

const LINUX_ONLY = process.platform === "linux";

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

function mixedRegistryFailure(transient: number, answered: number): ScriptedOutcome {
  return {
    code: 1,
    stderr: "",
    stdout: JSON.stringify({
      error: {
        code: "ERR_PNPM_AUDIT_BAD_RESPONSE",
        message:
          "The audit endpoint (at http://127.0.0.1:40857/-/npm/v1/security/audits/quick) responded with "
          + `${transient}: {"error":"service unavailable"}. Fallback endpoint (at `
          + `http://127.0.0.1:40857/-/npm/v1/security/audits) responded with ${answered}: {"error":"forbidden"}`,
      },
    }),
  };
}

const SERVER_5XX = registryFailure(503, "ERR_PNPM_AUDIT_BAD_RESPONSE");
const RATE_LIMITED = registryFailure(429, "ERR_PNPM_AUDIT_BAD_RESPONSE");
const FORBIDDEN = registryFailure(403, "ERR_PNPM_AUDIT_BAD_RESPONSE");
/** Quick endpoint 503, fallback endpoint 403 — a split answer. */
const SPLIT_ANSWER = mixedRegistryFailure(503, 403);

const OUT_OF_RANGE = registryFailure(600, "ERR_PNPM_AUDIT_BAD_RESPONSE");
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

const UNREADABLE: ScriptedOutcome = { code: 1, stdout: "", stderr: " ERROR  Unknown option: 'audit-level'\n" };

const UNTRUSTED: ScriptedOutcome = { code: 1, stderr: "", stdout: CLEAN.stdout };

const NO_ADVISORIES_FIELD: ScriptedOutcome = {
  code: 0,
  stderr: "",
  stdout: JSON.stringify({ actions: [], muted: [], metadata: { dependencies: 688 } }),
};

const NO_LOCKFILE: ScriptedOutcome = {
  code: 1,
  stderr: "",
  stdout: JSON.stringify({
    error: {
      code: "ERR_PNPM_AUDIT_NO_LOCKFILE",
      message:
        "No pnpm-lock.yaml found: Cannot audit a project without a lockfile\n"
        + 'at resolveDependencies (.../node_modules/.pnpm/@pnpm+audit.../lib/audit.js:12:11)',
    },
  }),
};

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: unknown;
};

describe("the dependency audit workflow's audit step", () => {
  let steps: Step[] = [];
  let auditSteps: Step[] = [];
  let jobEnv: Record<string, string> | undefined;
  let workflowEnv: Record<string, string> | undefined;

  beforeAll(async () => {
    const workflow = parse(await readFile(resolve(".github/workflows/dependency-audit.yml"), "utf8")) as {
      env?: Record<string, string>;
      jobs?: { "dependency-audit"?: { env?: Record<string, string>; steps?: Step[] } };
    };
    steps = workflow.jobs?.["dependency-audit"]?.steps ?? [];
    jobEnv = workflow.jobs?.["dependency-audit"]?.env;

    workflowEnv = workflow.env;
    auditSteps = steps.filter((step) => step.name === "Audit lockfile advisories");
  });

  it("exists exactly once, and never tolerates its own failure", () => {
    expect(auditSteps).toHaveLength(1);
    // `continue-on-error` here would swallow the very signal the workflow
    // exists to raise: a step that cannot fail cannot report an advisory.
    expect(Boolean(auditSteps[0]?.["continue-on-error"])).toBe(false);
  });

  it("executes nothing from the pull request, and reads the lockfile as data", () => {

    const checkout = steps.filter((step) => step.uses?.startsWith("actions/checkout"));
    expect(checkout).toHaveLength(1);
    const run = auditSteps[0]?.run ?? "";
    // No install, so no PR-authored manifest is ever resolved and executed:
    // `pnpm audit` reads pnpm-lock.yaml directly.
    expect(run).not.toMatch(/\b(pnpm|npm|yarn)\s+(ci|install|i)\b/);
    // No expression is interpolated into the shell, so nothing about the event
    // can become a command. The step's inputs are reads of what pnpm wrote.
    expect(run.includes("${{")).toBe(false);
  });

  it("keeps the retry inside the workflow, where a pull request cannot replace it", () => {

    const run = auditSteps[0]?.run ?? "";
    expect(run).not.toMatch(/\bnode\s+(\.\/)?scripts\//);
    expect(run).not.toMatch(/\bbash\s+(\.\/)?scripts\//);
  });

  it("binds the pull-request-controlled inputs for every step that runs pnpm", () => {
    const PINS: Record<string, string> = {
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      npm_config_registry: "https://registry.npmjs.org/",
      npm_config_strict_ssl: "true",
      npm_config_cafile: "/etc/ssl/certs/ca-certificates.crt",
      npm_config_audit_level: "low",
    };

    const effective = (step: Step | undefined, key: string): string | undefined =>
      step?.env?.[key] ?? jobEnv?.[key] ?? workflowEnv?.[key];

    // The step the finding was about, named on its own so a regression there
    // fails with a message about the audit rather than about a sweep.
    for (const [key, value] of Object.entries(PINS)) {
      expect(
        effective(auditSteps[0], key),
        `the step that runs \`pnpm audit\` must resolve ${key} from the workflow. An env block on the ` +
          "step that INSTALLS pnpm does not reach it: Actions env is step-scoped, so that placement " +
          "leaves the audit reading whatever the pull request's own package.json and .npmrc name",
      ).toBe(value);
    }

    const pnpmSteps = steps.filter((step) => /\bpnpm\b/.test(step.run ?? ""));
    expect(
      pnpmSteps.length,
      "this sweep is vacuous if fewer than two steps run pnpm — the install step and the audit step",
    ).toBeGreaterThan(1);
    for (const step of pnpmSteps) {
      for (const [key, value] of Object.entries(PINS)) {
        expect(
          effective(step, key),
          `step "${step.name ?? step.uses}" runs pnpm and must resolve ${key} from the workflow, ` +
            "not from a value its own env block shadows",
        ).toBe(value);
      }
    }
  });

  it("signals every process it kills with SIGKILL", () => {
    // Lives here, outside the Linux-gated block, because it is about a constant
    // and needs no shell — so it still runs on a platform that skips the rest.
    expect(STEP_KILL_SIGNAL).toBe("SIGKILL");
  });

  it("reads the audit's own output rather than a report file a pull request could stage", () => {
    // `pnpm audit` is the only thing that writes the report here. A path under
    // version control would be pull-request-staged input to a decision.
    expect(auditSteps[0]?.run ?? "").toMatch(/pnpm audit --json/);
  });

  describe.skipIf(!LINUX_ONLY)("run against a scripted advisory endpoint", () => {
    let root = "";
    let cases = 0;

    beforeAll(async () => {
      root = await tempDirectories.createAsync(join(tmpdir(), "dependency-audit-retry-"));
    });

    afterAll(async () => {
      await tempDirectories.disposeAsync(root);
    });

    function runStep(
      outcomes: ScriptedOutcome[],
      options?: { delaySeconds?: string },
    ): { status: number | null; stdout: string; attempts: number; sleeps: string[] } {
      cases += 1;
      const home = join(root, `case-${cases}`);
      mkdirSync(join(home, "bin"), { recursive: true });
      const counter = join(home, "counter");
      writeFileSync(counter, "0");
      writeFileSync(join(home, "outcomes.json"), JSON.stringify(outcomes));
      writeFileSync(join(home, "sleeps"), "");
      writeFileSync(
        join(home, "bin", "pnpm"),
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
      writeFileSync(
        join(home, "bin", "sleep"),
        [
          "#!/usr/bin/env node",
          'require("node:fs").appendFileSync(process.env.AUDIT_STUB_DIR + "/sleeps", process.argv.slice(2).join(" ") + "\\n");',
          "",
        ].join("\n"),
      );
      for (const stub of ["pnpm", "sleep"]) chmodSync(join(home, "bin", stub), 0o755);

      const script = join(home, "audit.sh");
      writeFileSync(script, auditSteps[0]!.run!);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${join(home, "bin")}:${process.env.PATH}`,
        AUDIT_STUB_DIR: home,

        EVENT_NAME: "schedule",
      };
      // Omitting the key entirely is how the shipped default is exercised.
      if (options?.delaySeconds !== undefined) {
        env.DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS = options.delaySeconds;
      } else {
        delete env.DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS;
      }

      const result = runBoundedScript(script, home, env, STEP_TIMEOUT_MS);
      return {
        status: result.status,
        stdout: result.stdout,
        attempts: Number(readFileSync(counter, "utf8").trim()),
        sleeps: readFileSync(join(home, "sleeps"), "utf8").split("\n").filter((line) => line !== ""),
      };
    }

    /** The delay every case below asks for unless it is testing the default. */
    const RETRY_DELAY = "7";

    it("passes a clean lockfile without retrying", () => {
      const outcome = runStep([CLEAN], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(0);
      expect(outcome.attempts).toBe(1);
      expect(outcome.sleeps).toEqual([]);
    });

    it("fails a lockfile carrying advisories, on the first attempt and without retrying", () => {

      const outcome = runStep([ADVISORIES], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.sleeps).toEqual([]);
    });

    it("retries a transient registry failure and passes when the endpoint recovers", () => {
      const outcome = runStep([SERVER_5XX, CLEAN], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(0);
      expect(outcome.attempts).toBe(2);
      // One sleep, and it is the delay asked for — the backoff is the record
      // the stub kept, not a literal the script happens to contain.
      expect(outcome.sleeps).toEqual([RETRY_DELAY]);
    });

    it("retries a rate-limited endpoint too — 429 is a transient registry answer", () => {
      const outcome = runStep([RATE_LIMITED, RATE_LIMITED, ADVISORIES], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      // Two retries then the real finding: the loop stops at the finding
      // rather than spending its remaining attempts on it.
      expect(outcome.attempts).toBe(3);
      expect(outcome.sleeps).toEqual([RETRY_DELAY, RETRY_DELAY]);
    });

    it("spends exactly its retry budget on a registry outage and then fails", () => {

      const outcome = runStep([SERVER_5XX], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(3);
      // Two sleeps for three attempts: the last failure reports rather than
      // waiting for a fourth that will not come.
      expect(outcome.sleeps).toEqual([RETRY_DELAY, RETRY_DELAY]);
    });

    it("sleeps its shipped default when nothing overrides it", () => {
      // The suite above always asks for a delay of its own, so the default is
      // what a CI run actually uses, and it is read off the recorded call.
      const outcome = runStep([SERVER_5XX, CLEAN]);
      expect(outcome.status).toBe(0);
      expect(outcome.sleeps).toEqual(["30"]);
    });

    it("does not retry a registry answer that is not transient", () => {

      const forbidden = runStep([FORBIDDEN], { delaySeconds: RETRY_DELAY });
      expect(forbidden.status).toBe(1);
      expect(forbidden.attempts).toBe(1);
      const refused = runStep([REFUSED], { delaySeconds: RETRY_DELAY });
      expect(refused.status).toBe(1);
      expect(refused.attempts).toBe(1);
    });

    it("names which of the two non-retryable states it is, in the log a human reads", () => {
      const forbidden = runStep([FORBIDDEN], { delaySeconds: RETRY_DELAY });
      expect(forbidden.stdout).toMatch(/\bunreachable\b/);
      expect(forbidden.stdout).not.toMatch(/\bunreadable\b/);

      const refused = runStep([REFUSED], { delaySeconds: RETRY_DELAY });
      expect(refused.stdout).toMatch(/\bunreachable\b/);

      // Both sites the `unreadable` label is emitted from, plus the
      // `unreachable` site, so every label in the classifier is covered and a
      // partial swap cannot hide behind the others.
      for (const outcome of [UNREADABLE, NO_ADVISORIES_FIELD, UNTRUSTED, NO_LOCKFILE]) {
        const result = runStep([outcome], { delaySeconds: RETRY_DELAY });
        expect(result.stdout).toMatch(/\bunreadable\b/);
        expect(result.stdout).not.toMatch(/\bunreachable\b/);
      }
    });

    it("names each way of failing to produce a verdict by what actually happened", () => {

      const seen: Record<string, string> = {};
      for (const [name, outcome, expected, forbidden] of [
        ["unparseable", UNREADABLE, "no JSON report", "carried"],
        ["absent field", NO_ADVISORIES_FIELD, "carried no advisories field", "empty advisories map"],
        ["empty map at a nonzero exit", UNTRUSTED, "carried an empty advisories map", "carried no advisories field"],
      ] as const) {
        const result = runStep([outcome], { delaySeconds: RETRY_DELAY });
        expect(result.status, `${name} must still fail closed`).toBe(1);
        expect(
          result.stdout,
          `a report that is ${name} has to say so; the run log is what a human reads`,
        ).toContain(expected);
        expect(
          result.stdout,
          `a report that is ${name} must not be described as ${forbidden}`,
        ).not.toContain(forbidden);
        seen[name] = result.stdout;
      }
      // And the three texts are genuinely three: no two agree. Without this the
      // pins above would pass a classifier that printed all three fragments in
      // every case.
      expect(new Set(Object.values(seen)).size, "the three texts are not distinguishable").toBe(3);
    });

    it("does not blame the registry when there was no lockfile to audit", () => {
      const outcome = runStep([NO_LOCKFILE], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.sleeps).toEqual([]);
      expect(outcome.stdout).toMatch(/\bunreadable\b/);
      expect(outcome.stdout).not.toMatch(/\bunreachable\b/);
      expect(outcome.stdout).not.toMatch(/\btransient\b/);
    });

    it("does not retry when one endpoint's answer is transient and the other's is not", () => {

      const outcome = runStep([SPLIT_ANSWER], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.sleeps).toEqual([]);
    });

    it("does not retry a status outside 500–599, however it reads", () => {
      // The classifier promises 5xx and 429. A 6xx is not one, and retrying it
      // would spend the whole budget on an answer that is not going to change.
      const outcome = runStep([OUT_OF_RANGE], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.sleeps).toEqual([]);
    });

    it("fails closed when the audit produced no readable report at all", () => {

      const outcome = runStep([UNREADABLE], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
    });

    it("fails an empty advisories map that arrived with a nonzero exit", () => {

      const outcome = runStep([UNTRUSTED], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.stdout).not.toContain("no known vulnerabilities found");
    });

    it("reports neither a clean lockfile nor an advisory when the report has no advisories field", () => {

      const outcome = runStep([NO_ADVISORIES_FIELD], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.stdout).not.toContain("advisories (");
    });

    it("leaves nothing running when the step script never terminates", async () => {

      const marker = `audit-runaway-${randomBytes(8).toString("hex")}`;
      const home = join(root, marker);
      mkdirSync(home, { recursive: true });
      const script = join(home, "audit.sh");

      writeFileSync(
        script,
        [
          "#!/usr/bin/env bash",
          "trap '' TERM",
          `if [ "\${AUDIT_DEPTH:-0}" -lt ${RUNAWAY_MAX_DEPTH} ]; then`,
          '  AUDIT_DEPTH=$((AUDIT_DEPTH + 1)) bash ./audit.sh "$1"',
          "fi",
          `sleep ${RUNAWAY_WAIT_SECONDS}`,
          "",
        ].join("\n"),
      );

      const baseline = countProcesses(marker);

      expect(
        SURVIVOR_SETTLE_MS,
        "the settle window must end before the chain finishes unwinding, or an " +
          "unfixed build's survivors expire on their own and this test passes vacuously",
      ).toBeLessThan(RUNAWAY_MAX_DEPTH * RUNAWAY_WAIT_SECONDS * 1000);

      // Bounded far below the chain's own lifetime, so the chain is guaranteed
      // to still be running when the bound fires — the only state in which this
      // can fail.
      const result = runBoundedScript(script, home, { ...process.env }, RUNAWAY_BOUND_MS, [marker]);

      // It was killed, not merely slow: `spawnSync` reports the timeout it
      // applied, which is a record of what the code did rather than a duration
      // this test measured.
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe("ETIMEDOUT");

      expect(result.signal).toBe("SIGKILL");

      const deadline = Date.now() + SURVIVOR_SETTLE_MS;
      let survivors = countProcesses(marker);
      while (survivors > baseline && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50));
        survivors = countProcesses(marker);
      }
      expect(
        survivors,
        `the step script left ${survivors - baseline} of its own re-exec chain still running after ` +
          "the run — that many processes carrying this run's marker. The bound killed the direct child " +
          "and left the rest reparented, which is the 2026-10-03 failure. (The count covers the chain's " +
          "own shells only — the `sleep` each level waits on carries no marker and is not included, " +
          "which is why the group kill rather than the count is what has to cover it.)",
      ).toBe(baseline);
    }, 30_000);
  });
});
