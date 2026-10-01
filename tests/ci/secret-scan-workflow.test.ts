import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
 *    full history an unpinned one.
 *
 * The model of the assertions is tests/api/ci-workflows.test.ts, which pins
 * dependency-audit.yml and code-scanning.yml; tests/ci/concurrency.test.ts is
 * what classifies this workflow's concurrency group.
 */

const PINNED_GITLEAKS_VERSION = "8.30.1";
const PINNED_GITLEAKS_SHA256 = "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb";

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
    expect(run, "the install step must print the version it installed").toMatch(/gitleaks\s+version/);
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
