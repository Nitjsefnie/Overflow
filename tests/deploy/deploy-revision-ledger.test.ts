// The ledger App as a required-check producer: the deploy gate's
// OVERFLOW_DEPLOY_LEDGER_APP_ID attribution behaviors. Split from
// tests/deploy/deploy-revision.test.ts — shared fixture in
// tests/support/deploy-revision-harness.ts — so each measured module stays
// under the tests family ceiling (scripts/check-module-size.ts).
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIONS_APP_ID,
  FIXTURE_PINS,
  LEDGER_APP_ID,
  cleanupLiveFixture,
  describeEntry,
  expectGateRefused,
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
      .filter((line, at) => line === "sleep 15" && at > checkRunsAt);
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
