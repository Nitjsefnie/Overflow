import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
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

/**
 * The bound on ONE invocation of the step script.
 *
 * Without it the suite hands the script to `bash` and waits forever, which is
 * how a script that never terminates takes the whole run down with it. The
 * number is generous because it has to clear every legitimate case on a loaded
 * machine: the slowest legitimate case measured on this worktree was the
 * three-attempt retry-budget case at ~570 ms (the six-spawn classification case
 * is ~970 ms end to end, and the suite's `sleep` is a stub, so its 7- and
 * 30-second backoffs cost nothing here), and this sits ~200x above the
 * slowest single spawn. The one case that deliberately overruns it is the
 * runaway fixture below, which is bounded by a much shorter explicit limit.
 */
const STEP_TIMEOUT_MS = 120_000;

/**
 * SIGKILL, not SIGTERM: the point is that nothing is left to answer a second
 * signal.
 *
 * This constant is PINNED BY A TEST ("signals every process it kills with
 * SIGKILL"), which the in-test signal assertion cannot do: that one observes
 * `spawnSync`'s REPORTED `killSignal`, so it covers the spawn option and
 * nothing else. Both kill sites in `killTree` read this constant, and the
 * brief's mandate is that they send SIGKILL.
 *
 * Measured here, and the reason that test exists: swapping the constant to
 * SIGTERM was caught, but writing `"SIGTERM"` literally at the two `killTree`
 * sites — the group kill sending a signal that can be handled — left the file
 * 21/21 GREEN, because this constant was never read on that path. The
 * behavioural half of that gate is the runaway fixture's `trap '' TERM` below;
 * the constant assertion covers the other half, so neither is load-bearing
 * alone.
 *
 * The assertion lives inside a test rather than at module scope because a
 * module-level violation aborts collection: the run then reports "0 test" and
 * every other case in the file never runs, so the failure hides the state of
 * everything else.
 */
const STEP_KILL_SIGNAL = "SIGKILL";

/**
 * The runaway fixture's recursion cap. It is a cap in the fixture's own source,
 * so the chain cannot grow however long the bound takes to fire — rule 19's
 * shape, one foreground child per level.
 */
const RUNAWAY_MAX_DEPTH = 5;

/**
 * How long each level of the runaway chain waits before it ends on its own.
 *
 * The chain must outlive the bound it is run under, or the survivors count
 * would find nothing there and the test would pass against unfixed code. It
 * must NOT be unbounded, or a run with the bound removed would hang this suite
 * instead of failing it.
 */
const RUNAWAY_WAIT_SECONDS = 2;

/**
 * The bound the runaway fixture is deliberately run under. Below the chain's
 * own lifetime, so the chain is guaranteed to still be running when it fires.
 */
const RUNAWAY_BOUND_MS = 1_500;

/**
 * How long to wait for processes the group kill reached to leave the process
 * table before the survivor count is judged.
 *
 * This is NOT a wall-clock margin on the fix, and it is not what makes the test
 * a gate. The chain's levels unwind one at a time, each taking
 * RUNAWAY_WAIT_SECONDS, so a leaked chain takes roughly
 * RUNAWAY_MAX_DEPTH * RUNAWAY_WAIT_SECONDS to disappear on its own — measured
 * at 9s for the values here, with 3 processes still alive at 4s. This window
 * ends while that chain is still unwinding, which is what stops the count from
 * reaching zero on its own and passing an unfixed build. The assertion is about
 * the COUNT returning to its baseline; a fixed build reaches it in well under a
 * second because the group kill is synchronous.
 */
const SURVIVOR_SETTLE_MS = 4_000;

/**
 * Publishes the shell's own pid, then becomes the step script.
 *
 * `setsid` makes its caller a session and process-group leader, so `$$` IS the
 * process group — no `ps`, no assumption that `setsid` execed in place. That
 * matters because `setsid` does NOT always exec in place (measured here: it
 * forked on one run and execed on the next), so the pid `spawnSync` reports is
 * not reliably the group leader. The pid is published BEFORE the exec, so the
 * file exists whenever the script ran at all.
 *
 * `shift` then hands the rest of the launcher's own arguments to the script,
 * which is how a caller-supplied argument reaches the script's `$1`.
 */
const STEP_LAUNCHER = 'echo $$ > "$1"; shift; exec bash -e "$@"';

/**
 * Kills a whole process group, or a lone process when no group is known.
 *
 * SIGKILL because a step script that has to be bounded cannot be asked to stop
 * politely. ESRCH is the expected race — the group is already gone — so it is
 * swallowed rather than reported.
 */
function killTree(pgid: number | undefined, pid: number | undefined): void {
  if (pgid !== undefined) {
    try {
      process.kill(-pgid, STEP_KILL_SIGNAL);
      return;
    } catch (error) {
      // ESRCH: the group is already gone, which is the expected race and the
      // only failure worth ignoring. Anything else (EPERM) means the group did
      // not go down, and falling through to the single pid is better than
      // leaving the tree alive.
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

/**
 * Runs one shell script in its own process group, under a bound, and takes the
 * whole group down afterwards — whether the script finished or overran.
 *
 * The group kill is the load-bearing half. Measured on this host: with the
 * script started under `setsid` and left to overrun, `spawnSync`'s own timeout
 * signal killed ONLY the direct child — eight descendants survived, reparented
 * to PID 1, exactly the shape of the 2026-10-03 runaway. `kill(-pgid)` after
 * the fact took the same run from eight survivors to zero.
 */
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
    // Refuse anything that is not a plausible group id, and never a group this
    // process belongs to — a stray `kill(-pgid)` aimed at the test runner or
    // its own shell would take the suite down, which is the failure this whole
    // mechanism exists to prevent. The runner's real group is NOT `process.pid`
    // or `process.ppid`: measured inside a vitest worker, pid 615705 and ppid
    // 614470 sat in group 614439. So the group is read from /proc, not
    // inferred from those two.
    //
    // This is defence in depth, not the protection: `setsid` is what puts the
    // script in a group of its own, and a published pgid that collided with
    // ours would mean `setsid` had not done that. It costs one small read and
    // removes a way to aim a group-kill at the runner.
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

/**
 * Counts the processes whose command line carries `marker`, which is how the
 * runaway test counts what it leaked. `pgrep` never matches itself, and the
 * marker is unique to one test run, so the count is this run's processes and
 * nothing else on the host.
 */
function countProcesses(marker: string): number {
  const found = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
  return found.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * This process's own process group, or undefined where it cannot be read.
 *
 * `process.getpgrp` does not exist in Node 24.17.0 (the version this workflow
 * pins), so field 5 of /proc/self/stat is the source. The comm field that
 * precedes it can contain spaces and parentheses, so the parse starts after the
 * LAST `)`, not by splitting the whole line.
 */
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

/**
 * Every case here runs a real shell through `setsid`, which is util-linux and
 * absent on macOS — where this file ran before this branch. Gated the same way
 * as the other platform-specific cases in this repo
 * (tests/db/postgres-shared.test.ts), so a developer on a Mac skips rather than
 * reading 16 ENOENT failures. The workflow assertions above the gate are pure
 * YAML reads and still run everywhere. CI is ubuntu-latest, which is why this
 * needs stating rather than discovering.
 *
 * `pgrep` is not gated: it is in the base system on macOS too, and it is only
 * reached from the Linux-gated case.
 */
const LINUX_ONLY = process.platform === "linux";

/**
 * NOTE ON THE "RUN STOPPED FROM OUTSIDE" CASE — there is no protection for it,
 * deliberately, and this comment exists so nobody adds one that cannot work.
 *
 * An earlier version kept a set of live process groups and killed them from
 * `process.on("exit")` and from SIGINT/SIGTERM/SIGHUP handlers. Measured here,
 * that set was ALWAYS empty when a handler could run: the only two statements
 * that touched it — the `add` and the `delete` — sit inside a single synchronous
 * `runBoundedScript` frame, and a signal callback cannot interleave inside a
 * synchronous call. An instrumented exit handler printed
 * `observedLiveGroups=0`. So the handlers could never kill anything, while the
 * `process.exit(0)` in them really did change vitest worker's signal semantics
 * — a real cost for zero protection.
 *
 * What actually bounds a step script is the `timeout` in `runBoundedScript`,
 * because that is what stops the script from running indefinitely in the first
 * place. That bound holds only while this process is alive: if the whole test
 * run is killed from outside, the timeout dies with it, so whatever was running
 * at that instant is left behind UNBOUND. The honest summary is narrower than
 * "bounded rather than eternal" — the timeout bounds what a step script can
 * leave behind WHILE THE TEST IS RUNNING, and bounds nothing at all once the
 * test process itself is gone.
 */

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

/**
 * Two endpoints, two different answers — which is what pnpm's fallback produces
 * whenever the quick endpoint and the full endpoint disagree. Built here because
 * pnpm has never been observed to emit it (both endpoints answer alike in every
 * capture), and the classifier's contract is about the pair: `every` statuses
 * must be transient, so one transient leg is not a transient answer. A
 * `some()` classifier retries this; the shipped one must not.
 */
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
/**
 * A 6xx. Not something registry.npmjs.org has been observed to answer with,
 * and the point is exactly that: the classifier promises "5xx or 429", so a
 * status outside 500–599 must not buy a retry. Dropping the `< 600` bound
 * retries this.
 */
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

/**
 * What pnpm writes when it cannot run the audit at all: an unusable invocation
 * exits 1 with EMPTY stdout and the complaint on stderr. Nothing here may read
 * that as a clean lockfile.
 */
const UNREADABLE: ScriptedOutcome = { code: 1, stdout: "", stderr: " ERROR  Unknown option: 'audit-level'\n" };

/**
 * An empty `advisories` map with a NONZERO exit — pnpm answered in a shape
 * carrying no findings while telling us something went wrong. Reading that as
 * clean is the fail-open the workflow's own comment says it does not have, and
 * the only fixture here that can catch it, because every other empty-advisories
 * case exits 0.
 */
const UNTRUSTED: ScriptedOutcome = { code: 1, stderr: "", stdout: CLEAN.stdout };

/**
 * A report with no `advisories` key at all, exiting 0. Nothing in it says the
 * lockfile was clean, so it must not be read as clean — and it must not be read
 * as a finding either, which is the only shape that would report an advisory
 * the registry never mentioned.
 */
const NO_ADVISORIES_FIELD: ScriptedOutcome = {
  code: 0,
  stderr: "",
  stdout: JSON.stringify({ actions: [], muted: [], metadata: { dependencies: 688 } }),
};

/**
 * What real pnpm 10.33.0 answers when the tree has no pnpm-lock.yaml — a pull
 * request that DELETES it, which the workflow's path filter does trigger on.
 * Neither registry nor transport failed: there was nothing to audit, so pnpm
 * never asked one. Labelling it `unreachable` would blame a registry for an
 * answer nobody asked it for.
 */
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
      jobs?: { audit?: { env?: Record<string, string>; steps?: Step[] } };
    };
    steps = workflow.jobs?.audit?.steps ?? [];
    jobEnv = workflow.jobs?.audit?.env;
    // Read, not asserted: Actions merges workflow-level env into every job, so
    // a pin there is as effective as one on the job and this suite must not
    // fail a placement that works. The exact shape is the string pin's to own.
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

  it("binds both pull-request-controlled inputs for every step that runs pnpm", () => {
    // `corepack install --global pnpm@10.33.0` sets corepack's DEFAULT and
    // nothing more. When the `pnpm` shim runs, corepack otherwise reads
    // `packageManager` from the nearest `package.json` and downloads THAT
    // version — and `package.json` is one of the two files this task added to
    // the path filter, so the trigger is what put a pull-request-controlled
    // field in the position that selects the binary.
    //
    // The step that matters is the one that EXECUTES `pnpm audit`, not the one
    // that installs pnpm, and GitHub Actions `env:` is step-scoped: it does not
    // carry forward. An earlier version of this branch pinned the variable on
    // the install step and every assertion here stayed green while the hole
    // was open — measured on the Node 24.17.0 this workflow pins, replaying the
    // two steps as separate processes against a `packageManager` of
    // `pnpm@9.15.9`:
    //
    //   step 1 with the variable on the step:  pnpm --version -> 10.33.0
    //   step 2 without it:                     pnpm --version -> 9.15.9
    //
    // The second pin is the same class of thing about a different input: pnpm
    // reads `.npmrc` from the working directory, and a `registry=` there
    // redirects the advisory endpoint, so a pull request touching `.npmrc` AND
    // `package.json` could have the audit answer "no known vulnerabilities".
    // `.npmrc` is not in the path filter so that pair does not trigger on its
    // own, but this workflow already runs on the `package.json` half of it.
    // Measured on pnpm 10.33.0: a project `.npmrc` does redirect `pnpm config
    // get registry`, and `npm_config_registry` outranks it.
    //
    // Both pins are swept over every step that runs pnpm, from ONE table. They
    // were placed on mirrored steps by accident once — one right, one wrong —
    // and it was the ASYMMETRY that let it stand: one pin was asserted, the
    // other was not. A table means a pin cannot be added, removed or given a
    // different value without the sweep noticing, and no second pin can slip in
    // beside it unasserted.
    const PINS: Record<string, string> = {
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      npm_config_registry: "https://registry.npmjs.org/",
    };

    // Actions resolves a step's environment as workflow, then job, then the
    // step's own block. Any of the three levels satisfies the requirement, so
    // this asserts the PROPERTY — every step that runs pnpm resolves these
    // inputs from the workflow — rather than a particular level. Asserting a
    // level instead is what made an earlier version of this message claim a
    // property that an equally effective placement also had.
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

    // And no step may shadow either pin, in either direction — a step-level
    // `env` that re-set one would win over the job's for that step alone. The
    // set is every step whose script mentions pnpm, which over-includes the
    // install step: a step that cannot resolve a registry today may be the one
    // that can after an edit, and a pin that only covers the steps that exist
    // today is the pin that will be forgotten.
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
      root = await mkdtemp(join(tmpdir(), "dependency-audit-retry-"));
    });

    afterAll(async () => {
      // Nothing to clean up beyond the directory: `runBoundedScript` kills
      // every group it starts before it returns, so there is never a live
      // group by the time this runs. An earlier version swept a set of "live"
      // groups here; it was always empty, for the reason recorded above.
      await rm(root, { recursive: true, force: true });
    });

    /**
     * Runs the step's own run script the way the runner would — `bash -e`, a
     * script file, its own working directory — with two stubs first on PATH.
     *
     * `pnpm` replays `outcomes` in order and counts its own invocations, so
     * `attempts` is how many times the audit actually ran: that is the whole
     * difference between "retried and then succeeded" and "retried and still
     * failing". `sleep` records the argument it was handed instead of waiting,
     * so the backoff is asserted on the RECORD of the call rather than on a
     * literal in the script — and so no assertion here depends on a clock.
     */
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
      // The narrowness this whole suite exists for: a finding is the answer,
      // not a failure to be re-asked. Retrying it would delay the report and
      // spend runner minutes to arrive at the same verdict.
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
      // One scripted outcome replays forever, so `attempts` is the retry
      // budget, and it is asserted EXACTLY: a budget raised to 99 would pass a
      // `toBeGreaterThan(1)` and then overrun this job's `timeout-minutes: 10`
      // on a slow registry.
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
      // 403 and 404 are not an outage: the request was answered, and asking
      // again gets the same answer. A transport failure reads the same to a
      // human but gets the same treatment — one attempt, then a red run
      // somebody looks at.
      const forbidden = runStep([FORBIDDEN], { delaySeconds: RETRY_DELAY });
      expect(forbidden.status).toBe(1);
      expect(forbidden.attempts).toBe(1);
      const refused = runStep([REFUSED], { delaySeconds: RETRY_DELAY });
      expect(refused.status).toBe(1);
      expect(refused.attempts).toBe(1);
    });

    it("names which of the two non-retryable states it is, in the log a human reads", () => {
      // `unreachable` and `unreadable` share the `*)` arm, the same echo and
      // the same exit status — nothing programmatic consumes them — but the
      // verdict word is echoed into the step's own output, and the two say
      // different things to whoever reads a red run: a registry that answered
      // "no" is not a report this step failed to read. Swapping the labels
      // mislabels the diagnosis without changing anything else, which is why
      // asserting on the word is the only thing that catches it.
      //
      // This is not an assertion on prose. The token is written to stdout at
      // run time by the classifier, in the same sense as the `not.toContain`
      // checks below and above it; the repository's ban is on matching page
      // copy or a comment's wording in a source file.
      // Matched on the word alone. An earlier version of this asserted
      // `": unreachable —"`, which copied the colon and em dash out of the echo
      // above, so reformatting that echo — changing no verdict — turned this
      // red for an unrelated reason. The word is the contract; its punctuation
      // is not.
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
      // Three states reach the classifier's trailing branch and all three are
      // red, so the verdict word cannot tell them apart — only the detail can,
      // and the detail is the whole added value of a five-verdict classifier.
      // Sent to the wrong one, a reader either hunts a malformed report that is
      // not there, or reads an empty `advisories` map as a report that never
      // arrived. So each state's own text is pinned here, and pinned AGAINST the
      // other two: a fix that collapses the three back into one sentence dies
      // whichever of the three it collapses.
      //
      // Not an assertion on prose in the sense the repository bans. Each string
      // is written to stdout at run time by the classifier under test — the
      // same footing as the verdict words above and the `not.toContain` checks
      // around it; what is banned is matching a source file's copy or a
      // comment's wording. Here the strings come out of the executed program,
      // so what is pinned is its behaviour, not the file it was typed into.
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
      // A pull request that DELETES pnpm-lock.yaml still triggers this workflow
      // — the path filter names that file — and pnpm then answers
      // ERR_PNPM_AUDIT_NO_LOCKFILE. No registry was asked and none failed, so
      // the `unreachable` label ("an answered or unconnected registry") is
      // wrong on both halves, and a reader who believes it goes looking for an
      // outage. Red either way, and still one attempt: a lockfile does not
      // appear between two tries.
      const outcome = runStep([NO_LOCKFILE], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.sleeps).toEqual([]);
      expect(outcome.stdout).toMatch(/\bunreadable\b/);
      expect(outcome.stdout).not.toMatch(/\bunreachable\b/);
      expect(outcome.stdout).not.toMatch(/\btransient\b/);
    });

    it("does not retry when one endpoint's answer is transient and the other's is not", () => {
      // pnpm asks `…/audits/quick`, falls back to `…/audits`, and reports BOTH
      // statuses. A 503 on the first and a 403 on the second is not an outage
      // that a retry can clear — the second endpoint answered, and it answered
      // "no". `every` is what makes that the rule; `some` would retry it.
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
      // pnpm exiting 1 with empty stdout is what an unusable invocation looks
      // like. Reading that as "no advisories" would turn a broken step into a
      // green one, which is the failure mode a detection signal must not have.
      const outcome = runStep([UNREADABLE], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
    });

    it("fails an empty advisories map that arrived with a nonzero exit", () => {
      // The other fail-closed edge, and the one the workflow's own comment
      // claims: `advisories: {}` says nothing was found, but a nonzero exit
      // says something went wrong, so the report is one this step does not
      // trust. Accepting it would report the lockfile clean on the strength of
      // a run that also reported a failure.
      const outcome = runStep([UNTRUSTED], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.stdout).not.toContain("no known vulnerabilities found");
    });

    it("reports neither a clean lockfile nor an advisory when the report has no advisories field", () => {
      // Nothing in this report says the lockfile was clean. It also says
      // nothing about an advisory, so calling it a finding would report one the
      // registry never mentioned — the failure a detection signal can least
      // afford, because it sends someone looking for a vulnerability that does
      // not exist.
      const outcome = runStep([NO_ADVISORIES_FIELD], { delaySeconds: RETRY_DELAY });
      expect(outcome.status).toBe(1);
      expect(outcome.attempts).toBe(1);
      expect(outcome.stdout).not.toContain("advisories (");
    });

    it("leaves nothing running when the step script never terminates", async () => {
      // The regression this suite did not have until issue 1008. Every case
      // above runs a script that answers; this one runs the same kind of script
      // with a `run:` block that re-executes itself, which is what a mutation
      // probe did to this workflow on 2026-10-03. The bound took the direct
      // child down, the rest of the chain survived reparented to PID 1, and
      // 57,700 processes were still alive twelve hours later.
      //
      // So the assertion is on the PROCESSES, not on a duration: the count of
      // processes carrying this run's unique marker must be back at its
      // baseline once the run returns. Nothing here says how long the run took,
      // and the fixture's own chain is depth-capped in its source, so a run that
      // leaked it would cost five processes rather than fifty thousand.
      const marker = `audit-runaway-${randomBytes(8).toString("hex")}`;
      const home = join(root, marker);
      mkdirSync(home, { recursive: true });
      const script = join(home, "audit.sh");
      // A cap on the recursion depth AND one foreground child per level: the
      // chain is linear, so a run that leaked without the group kill would cost
      // five processes, not a fork bomb.
      //
      // The marker is passed as an argument and re-passed on every level, so
      // it is in each descendant's own argv. That is what makes `pgrep -f` able
      // to count the whole chain: the alternative — matching on the script's
      // path — silently counts nothing once a level re-execs by a RELATIVE
      // path, which is exactly how this fixture recurses.
      // The fixture IGNORES SIGTERM. That is what makes the survivor count a
      // real gate on the SIGNAL rather than only on the group: a chain that
      // declines to handle SIGTERM survives a SIGTERM group kill and is taken
      // down only by SIGKILL, so swapping the signal to SIGTERM at either kill
      // site in `killTree` leaves processes alive here and turns this red.
      // Measured on this host: with SIGTERM planted at both sites the file was
      // otherwise 21/21 green, so without this the assertion could not see it.
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

      // The settle window has to end while a leaked chain is STILL unwinding,
      // or the count would drift to zero on its own and this would pass against
      // unfixed code. Asserted rather than left to a comment to hold, because
      // it is exactly the kind of relationship that rots when one constant moves.
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
      // The literal, not STEP_KILL_SIGNAL. Comparing the observed signal to the
      // constant that configures it is self-referential: planting SIGTERM in the
      // constant satisfied this assertion and left the file 21/21 green, because
      // `spawnSync` faithfully reported the signal it was told to send. SIGKILL
      // is the property being pinned — a script that has to be bounded cannot be
      // asked to stop politely, and a process still running to handle SIGTERM is
      // the thing this whole mechanism exists to prevent.
      expect(result.signal).toBe("SIGKILL");

      // And nothing it started outlived it. This is the assertion that carries
      // the issue: the bound alone takes down the direct child and leaves the
      // rest of the chain running, reparented to PID 1 — measured at 3 processes
      // still alive after the window below, on the unfixed spawn.
      //
      // What the count covers is the chain's own shells, matched on the marker
      // in their argv. Each level's `sleep` child carries no marker and is not
      // counted; it is still killed, because the group kill takes every member
      // of the group rather than the ones this count can see.
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
