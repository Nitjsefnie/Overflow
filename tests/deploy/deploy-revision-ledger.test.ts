// The ledger App as a required-check producer: the deploy gate's
// OVERFLOW_DEPLOY_LEDGER_APP_ID attribution behaviors. Split from
// tests/deploy/deploy-revision.test.ts — shared fixture in
// tests/support/deploy-revision-harness.ts — so each measured module stays
// under the tests family ceiling (scripts/check-module-size.ts).
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIONS_APP_ID,
  FIXTURE_PINS,
  LEDGER_APP_ID,
  cleanupLiveFixture,
  describeEntry,
  expectGateRefused,
  gateLog,
  makeFixture,
  readLog,
  runDeploy,
  writeGateState,
  type GateCheckRun,
  type GateRun,
  type ShimLogEntry,
} from "../support/deploy-revision-harness";

afterEach(cleanupLiveFixture);

describe("scripts/deploy-revision.sh — the ledger App as a required-check producer", () => {
  /**
   * The pinned job-record state the ledger-App tests build on — both pinned
   * jobs completed, verify's job concluding `verify` (success by default).
   */
  function happyPinnedRuns(verify: "success" | "failure" = "success"): GateRun[] {
    return [
      { id: 100, path: FIXTURE_PINS.verify!, jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: verify }] },
      { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
    ];
  }

  it.each([
    ["success", false], ["failure", false], ["success", true],
  ] as const)("spends two API requests per steady-state poll after attributing sixteen pinned runs, then stops at %s (missing suites=%s)", async (conclusion, missingSuites) => {
    const fixture = await makeFixture();
    const runs: GateRun[] = Array.from({ length: 16 }, (_, index) => ({
      id: index + 100,
      suite: missingSuites ? null : undefined,
      path: index === 15 ? FIXTURE_PINS["deploy-gate"]! : FIXTURE_PINS.verify!,
      jobs: [{ id: index + 1000, name: index === 15 ? "deploy-gate" : "verify",
        status: "completed", conclusion: "success" }],
    }));
    runs[15]!.jobs[0]!.status = "in_progress";
    const pending = await writeGateState(fixture, "budget-pending", runs);
    runs[15]!.jobs[0]!.status = "completed";
    runs[15]!.jobs[0]!.conclusion = conclusion;
    const concluded = await writeGateState(fixture, "budget-concluded", runs);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: `${pending}:${pending}:${concluded}`,
      OVERFLOW_DEPLOY_CI_TIMEOUT: "30",
    });
    expect(result.status, result.stderr).toBe(conclusion === "success" ? 0 : 1);
    const entries = await readLog(fixture.shimLog);
    if (conclusion === "failure") {
      expect(result.stderr).toContain("deploy-gate concluded failure");
      expectGateRefused(entries);
    }
    const polls: string[][] = [];
    for (const line of gateLog(entries)) {
      if (line.includes("/check-runs?")) polls.push([]);
      if (polls.length && line.startsWith("gh api ")) polls.at(-1)!.push(line);
    }
    expect(polls.map((poll) => poll.length)).toEqual([18, 2, 2]);
    expect(polls.flat().every((line) => line.includes("--paginate"))).toBe(true);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(24);
    expect(entries.filter((entry) => entry.cmd === "sleep").map((entry) => entry.args)).toEqual([["60"], ["60"]]);
  });

  it("keeps an API-created check-run unattributed even inside a pinned run's suite", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-same-suite-impostor", [
      { id: 100, path: FIXTURE_PINS.verify!,
        jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: "success" }] },
      { id: 200, path: FIXTURE_PINS["deploy-gate"]!,
        jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
    ], [{ id: 9999, name: "verify", suite: 10100, conclusion: "success" }]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify (unattributed check-run 9999)");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("refreshes a changed run attempt even before its new check-run appears", async () => {
    const fixture = await makeFixture();
    const runs = happyPinnedRuns();
    runs[1]!.jobs[0]!.status = "in_progress";
    const first = await writeGateState(fixture, "attempt-first", runs);
    runs[0]!.jobs.push({ id: 1002, name: "verify", attempt: 2, status: "completed", conclusion: "failure" });
    runs[1]!.jobs[0]!.status = "completed";
    const second = await writeGateState(fixture, "attempt-second", runs);
    const checks = JSON.parse(await readFile(`${second}/check-runs.json`, "utf8"));
    checks.check_runs = checks.check_runs.filter((check: { id: number }) => check.id !== 1002);
    await writeFile(`${second}/check-runs-next.json`, JSON.stringify(checks));
    await rename(`${second}/check-runs-next.json`, `${second}/check-runs.json`);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: `${first}:${second}` });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify concluded failure");
    const entries = await readLog(fixture.shimLog);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(9);
    expect(entries.filter((entry) => entry.cmd === "sleep")).toHaveLength(1);
    expectGateRefused(entries);
  });

  it("reads a newly listed pinned run before its check-run appears instead of accepting an older green", async () => {
    const fixture = await makeFixture();
    const runs = happyPinnedRuns();
    runs[1]!.jobs[0]!.status = "in_progress";
    const first = await writeGateState(fixture, "new-run-first", runs);
    runs[1]!.jobs[0]!.status = "completed";
    runs.push({ id: 300, path: FIXTURE_PINS.verify!,
      jobs: [{ id: 3001, name: "verify", status: "completed", conclusion: "failure" }] });
    const second = await writeGateState(fixture, "new-run-second", runs);
    const checks = JSON.parse(await readFile(`${second}/check-runs.json`, "utf8"));
    checks.check_runs = checks.check_runs.filter((check: { id: number }) => check.id !== 3001);
    await writeFile(`${second}/check-runs-next.json`, JSON.stringify(checks));
    await rename(`${second}/check-runs-next.json`, `${second}/check-runs.json`);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: `${first}:${second}` });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify concluded failure");
    const entries = await readLog(fixture.shimLog);
    expect(entries.filter((entry) => entry.cmd === "gh")).toHaveLength(9);
    expect(entries.filter((entry) => entry.cmd === "gh" && entry.args[1]?.includes("/runs/300/jobs?"))).toHaveLength(1);
    expect(entries.filter((entry) => entry.cmd === "sleep").map((entry) => entry.args)).toEqual([["60"]]);
    expectGateRefused(entries);
  });

  it("still excludes PR job IDs when the trusted app override names GitHub Actions", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-actions-override", [
      ...happyPinnedRuns(),
      { id: 300, path: FIXTURE_PINS.verify!, event: "pull_request",
        jobs: [{ id: 3001, name: "verify", status: "completed", conclusion: "failure" }] },
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_LEDGER_APP_ID: String(ACTIONS_APP_ID),
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["success", false], ["failure", false], ["success", true], ["failure", true],
  ] as const)("deploys main success beside workflow_run %s with ledger=%s", async (conclusion, ledger) => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-main-and-pr", [
      ...happyPinnedRuns(),
      { id: 300, path: ".github/workflows/ci-pr.yml", event: "workflow_run",
        jobs: [{ id: 3001, name: "verify", status: "completed", conclusion }] },
    ], ledger ? [{ id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: "success" }] : []);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(0);
    expect((await readLog(fixture.shimLog)).some((entry) => entry.args[0] === "release:switch")).toBe(true);
  });

  it.each([
    ["pull_request", "feature"], ["pull_request_target", "feature"], ["workflow_dispatch", "feature"],
    ["pull_request", "(missing)"],
  ])("ignores known excluded %s jobs on %s beside main success", async (event, headBranch) => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-other-excluded", [
      ...happyPinnedRuns(), { id: 300, path: FIXTURE_PINS.verify!, event, headBranch,
        jobs: [{ id: 3001, name: "verify", status: "completed", conclusion: "failure" }] },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["failure", "in_progress"])("lets main %s evidence hold deployment beside excluded success", async (status) => {
    const fixture = await makeFixture();
    const main = happyPinnedRuns(status === "failure" ? "failure" : "success");
    if (status === "in_progress") main[0]!.jobs[0]!.status = status;
    const state = await writeGateState(fixture, "gate-main-not-green", [
      ...main, { id: 300, path: ".github/workflows/ci-pr.yml", event: "workflow_run",
        jobs: [{ id: 3001, name: "verify", status: "completed", conclusion: "success" }] },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(status === "failure" ? "verify concluded failure" : "verify (in_progress)");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("keeps a check with no matching listed job unattributed beside excluded jobs", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-excluded-and-unknown", [
      ...happyPinnedRuns(), { id: 300, path: ".github/workflows/ci-pr.yml", event: "workflow_run",
        jobs: [{ id: 3001, name: "verify", status: "completed", conclusion: "success" }] },
    ], [{ id: 9999, name: "verify", status: "completed", conclusion: "success" }]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify (unattributed check-run 9999)");
    expect(result.stderr).not.toContain("unattributed check-run 3001");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("refuses a missing excluded job ID before attributing its check", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-missing-excluded-id", [
      ...happyPinnedRuns(), { id: 300, path: ".github/workflows/ci-pr.yml", event: "workflow_run",
        jobs: [{ id: 3001, name: "verify", status: "completed", conclusion: "success" }] },
    ]);
    await writeFile(`${state}/jobs-300.json`, JSON.stringify({ jobs: [
      { id: "", name: "verify", run_attempt: 1, status: "completed", conclusion: "success" },
    ] }));
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("run 300 has a job with no id");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("refuses a failed check-run JSON projection before reading main job evidence", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-invalid-check-json", happyPinnedRuns());
    await writeFile(`${state}/check-runs.json`, "{");
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "0" });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Could not read check runs");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("lets the ledger App's check-run decide a required context over the pinned job record, whichever way they split", async () => {
    for (const [label, job, ledger, expected] of [
      ["ledger failed where the job passed", "success", "failure", 1],
      ["ledger succeeded where the job failed", "failure", "success", 0],
    ] as const) {
      const fixture = await makeFixture();
      const state = await writeGateState(
        fixture,
        "gate-ledger-decides",
        happyPinnedRuns(job),
        [{ id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: ledger }],
      );
      const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "30" });

      expect(result.status, `${label}: ${result.stderr}`).toBe(expected);
      if (expected === 1) {
        expect(result.stderr, label).toContain("Required check verify concluded failure");
        expectGateRefused(await readLog(fixture.shimLog), label);
      } else {
        expect(
          (await readLog(fixture.shimLog)).some((entry) => entry.args[0] === "release:switch"),
          label,
        ).toBe(true);
      }
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("lets the newest ledger App check-run decide — highest id wins, not listing order", async () => {
    for (const [label, newest, older, expected] of [
      ["newest passed", "success", "failure", 0],
      ["newest failed", "failure", "success", 1],
    ] as const) {
      for (const newestFirst of [true, false]) {
        const fixture = await makeFixture();
        const olderCr: GateCheckRun = { id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: older };
        const newestCr: GateCheckRun = { id: 5002, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: newest };
        const state = await writeGateState(
          fixture,
          "gate-ledger-newest",
          happyPinnedRuns(),
          newestFirst ? [newestCr, olderCr] : [olderCr, newestCr],
        );
        const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "30" });

        expect(result.status, `${label}, newest first ${newestFirst}: ${result.stderr}`).toBe(expected);
        await rm(fixture.dir, { recursive: true, force: true });
      }
    }
  });

  it("refuses when the pinned job record holds a green rerun but the ledger App's older check-run holds failure", async () => {
    // The original verify run failed and the relay posted its failure
    // check-run; a rerun then went green. The rerun is the pinned workflow's
    // NEWEST job record, but the App check-run carries the name+app identity
    // protection reads, so it outranks the job record whichever way they
    // split — here the job record's success must not mask the App's failure.
    const fixture = await makeFixture();
    const state = await writeGateState(
      fixture,
      "gate-ledger-outranks-rerun",
      [
        {
          id: 100,
          path: FIXTURE_PINS.verify!,
          jobs: [
            { id: 1001, name: "verify", attempt: 1, status: "completed", conclusion: "failure" },
            { id: 1002, name: "verify", attempt: 2, status: "completed", conclusion: "success" },
          ],
        },
        { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
      ],
      [{ id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: "failure" }],
    );
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "30" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Required check verify concluded failure");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("decides from the pinned job record when no ledger App check-run exists", async () => {
    for (const [jobConclusion, expected] of [
      ["success", 0],
      ["failure", 1],
    ] as const) {
      const fixture = await makeFixture();
      const state = await writeGateState(fixture, "gate-no-ledger", [
        { id: 100, path: FIXTURE_PINS.verify!, jobs: [{ id: 1001, name: "verify", status: "completed", conclusion: jobConclusion }] },
        { id: 200, path: FIXTURE_PINS["deploy-gate"]!, jobs: [{ id: 2001, name: "deploy-gate", status: "completed", conclusion: "success" }] },
      ]);
      const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "30" });

      expect(result.status, `${jobConclusion}: ${result.stderr}`).toBe(expected);
      if (expected === 1) {
        expect(result.stderr, jobConclusion).toContain("Required check verify concluded failure");
        expectGateRefused(await readLog(fixture.shimLog), jobConclusion);
      } else {
        expect(
          (await readLog(fixture.shimLog)).some((entry) => entry.args[0] === "release:switch"),
          jobConclusion,
        ).toBe(true);
      }
      await rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("never passes beside an unattributed check-run even when a ledger App check-run succeeded", async () => {
    const fixture = await makeFixture();
    const state = await writeGateState(fixture, "gate-ledger-plus-foreign", happyPinnedRuns(), [
      { id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: "success" },
      { id: 9999, name: "verify", app: ACTIONS_APP_ID, status: "completed", conclusion: "success" },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: state, OVERFLOW_DEPLOY_CI_TIMEOUT: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify (unattributed check-run 9999)");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("waits while the ledger App check-run is pending and proceeds once it completes", async () => {
    const fixture = await makeFixture();
    const pending = await writeGateState(fixture, "gate-ledger-pending", happyPinnedRuns(), [
      { id: 5001, name: "verify", app: LEDGER_APP_ID, status: "in_progress" },
    ]);
    const done = await writeGateState(fixture, "gate-ledger-done", happyPinnedRuns(), [
      { id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: "success" },
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: `${pending}:${done}`,
      OVERFLOW_DEPLOY_CI_TIMEOUT: "30",
    });

    expect(result.status, result.stderr).toBe(0);
    const entries = await readLog(fixture.shimLog);
    const isCheckRuns = (entry: ShimLogEntry) =>
      entry.cmd === "gh" && entry.args.some((arg) => arg.includes("check-runs?filter=all&per_page=100"));
    const checkRunsCalls = entries.filter(isCheckRuns);
    expect(checkRunsCalls).toHaveLength(2);
    const checkRunsAt = entries.findIndex(isCheckRuns);
    const sleepBetween = entries
      .map(describeEntry)
      .filter((line, at) => line === "sleep 60" && at > checkRunsAt);
    expect(sleepBetween.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((entry) => entry.args[0] === "release:switch")).toBe(true);
  });

  it("refuses on the timeout while the ledger App check-run stays pending", async () => {
    const fixture = await makeFixture();
    const stuck = await writeGateState(fixture, "gate-ledger-stuck", happyPinnedRuns(), [
      { id: 5001, name: "verify", app: LEDGER_APP_ID, status: "in_progress" },
    ]);
    const result = await runDeploy(fixture, { GH_SHIM_GATE_SEQUENCE: stuck, OVERFLOW_DEPLOY_CI_TIMEOUT: "1" });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify (in_progress)");
    expect(result.stderr).toContain("HEAD, the index and the working tree are untouched; only the fetched refs moved");
    expectGateRefused(await readLog(fixture.shimLog));
  });

  it("repoints the trusted app with OVERFLOW_DEPLOY_LEDGER_APP_ID; any other app's check-run is unattributed", async () => {
    // With the knob at 999, the default app's (5118623) succeeded check-run
    // no longer attributes the context — and, bearing a required name from an
    // app nothing accounts for, keeps the check pending instead of passing.
    const fixture = await makeFixture();
    const repointedAway = await writeGateState(fixture, "gate-ledger-repointed-away", happyPinnedRuns(), [
      { id: 5001, name: "verify", app: LEDGER_APP_ID, status: "completed", conclusion: "success" },
    ]);
    const result = await runDeploy(fixture, {
      GH_SHIM_GATE_SEQUENCE: repointedAway,
      OVERFLOW_DEPLOY_LEDGER_APP_ID: "999",
      OVERFLOW_DEPLOY_CI_TIMEOUT: "1",
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("verify (unattributed check-run 5001)");
    expectGateRefused(await readLog(fixture.shimLog), "repointed away");

    // The repointed app's own check-run attributes and decides: its failure
    // refuses the deploy on the first poll.
    const fixture2 = await makeFixture();
    const repointed = await writeGateState(fixture2, "gate-ledger-repointed", happyPinnedRuns(), [
      { id: 6001, name: "verify", app: 999, status: "completed", conclusion: "failure" },
    ]);
    const result2 = await runDeploy(fixture2, {
      GH_SHIM_GATE_SEQUENCE: repointed,
      OVERFLOW_DEPLOY_LEDGER_APP_ID: "999",
      OVERFLOW_DEPLOY_CI_TIMEOUT: "30",
    });

    expect(result2.status, result2.stderr).toBe(1);
    expect(result2.stderr).toContain("Required check verify concluded failure");
    expectGateRefused(await readLog(fixture2.shimLog), "repointed decides");
  });
});
