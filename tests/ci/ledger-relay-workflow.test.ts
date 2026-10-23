import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";
import * as relayHttp from "../../scripts/ledger-relay-http.ts";
import { RELAY_JOB_NAME, RELAY_JOB_TIMEOUT_MINUTES } from "../../scripts/ledger-relay-job-budget.ts";

/**
 * The relay mints its App installation token from the OVERFLOW_LEDGER_APP_ID and
 * OVERFLOW_LEDGER_INSTALLATION_ID literals pinned in its step env, so a silently
 * altered literal repoints every relay posting at another App installation
 * whose check-runs protection and the deploy gate read as the ledger App's —
 * and the suite gave it no cover: the final review's mutant (5118624 for
 * 5118623) survived all 129 tests. This suite holds the workflow file to the
 * exact literals; the script-side wiring around them is covered by
 * tests/scripts/ledger-relay.test.ts.
 *
 * Assertions are made on the parsed YAML data, never on the raw bytes, so
 * reformatting the step does not disturb them and a changed, added or
 * duplicated literal fails loudly here instead of quietly repointing the
 * relay.
 */
type WorkflowStep = {
  name?: string;
  env?: Record<string, string | undefined>;
  "timeout-minutes"?: number;
};
type ParsedWorkflow = {
  on?: {
    schedule?: string[];
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string };
  jobs?: Record<string, { name?: string; steps?: WorkflowStep[]; "timeout-minutes"?: number }>;
};

describe("the ledger relay workflow's pinned App identity", () => {
  let workflow: ParsedWorkflow = {};
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ledger-relay.yml"), "utf8");
    workflow = parse(source) as ParsedWorkflow;

    steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? []);
  });

  /** Every step-env value the workflow carries for one of the pinned names. */
  const envValues = (name: string): unknown[] =>
    steps.flatMap((step) => (step.env?.[name] === undefined ? [] : [step.env[name]]));

  it("bounds every step so the job cannot cut off an in-flight relay request", () => {
    const job = workflow.jobs?.["relay-required-checks"];
    expect(job?.steps?.length).toBeGreaterThan(0);
    for (const step of job?.steps ?? []) {
      expect(step["timeout-minutes"], "each relay job step needs its own time bound").toBeTypeOf("number");
      expect(step["timeout-minutes"]).toBeGreaterThan(0);
    }
    const relaySteps = steps.filter((step) => step.env?.OVERFLOW_LEDGER_APP_ID !== undefined);
    expect(relaySteps).toHaveLength(1);
    const worstCaseMs = relayHttp.RUN_DEADLINE_MS + relayHttp.REQUEST_TIMEOUT_MS +
      relayHttp.BACKOFF_MS.reduce((sum, delay) => sum + delay, 0);
    expect((relaySteps[0]["timeout-minutes"] ?? 0) * 60_000).toBeGreaterThan(worstCaseMs);
    const stepMinutes = (job?.steps ?? []).reduce((sum, step) => sum + (step["timeout-minutes"] ?? 0), 0);
    expect(
      job?.["timeout-minutes"],
      "the job bound needs a margin over its declared steps for the runner's Set up job phase",
    ).toBeGreaterThan(stepMinutes);
  });

  it("names the relay job as the script's job-start read selects it, with the job timeout the script budgets", () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual([RELAY_JOB_NAME]);
    const job = workflow.jobs?.[RELAY_JOB_NAME];
    expect(job?.name, "a name: override would rename the job the jobs API lists").toBeUndefined();
    expect(
      job?.["timeout-minutes"],
      "RELAY_JOB_TIMEOUT_MINUTES must equal the job's timeout-minutes, or the job-start deadline drifts",
    ).toBe(RELAY_JOB_TIMEOUT_MINUTES);
  });

  it("leaves the relay run's own id and attempt to the runner's default variables", () => {
    // A step cannot override a default GITHUB_* variable, so an env entry for
    // either would be ignored; the job-start read uses the runner's values.
    expect(envValues("GITHUB_RUN_ID")).toEqual([]);
    expect(envValues("GITHUB_RUN_ATTEMPT")).toEqual([]);
  });

  it("carries the ledger App id exactly once, as the literal the gate and tests pin", () => {
    expect(
      envValues("OVERFLOW_LEDGER_APP_ID"),
      "the relay job must carry env OVERFLOW_LEDGER_APP_ID exactly once — the App id every " +
        "relay check-run is posted under, which branch protection and the deploy " +
        "gate read back",
    ).toEqual(["5118623"]);
  });

  it("carries the App installation id exactly once, as the pinned literal", () => {
    expect(
      envValues("OVERFLOW_LEDGER_INSTALLATION_ID"),
      "the relay job must carry env OVERFLOW_LEDGER_INSTALLATION_ID exactly once — the " +
        "installation the step mints its token for",
    ).toEqual(["166057493"]);
  });

  it("grants the workflow exactly contents: read plus actions: write", () => {
    expect(
      workflow.permissions,
      "the relay workflow must hold exactly contents: read + actions: write — " +
        "actions:write is the rerun-heal's re-dispatch of a cancelled producer " +
        "run (issue 861), contents: read is the checkout, and nothing more",
    ).toEqual({ contents: "read", actions: "write" });
  });

  it("passes the workflow's own token as OVERFLOW_RELAY_RERUN_TOKEN exactly once", () => {
    expect(
      envValues("OVERFLOW_RELAY_RERUN_TOKEN"),
      "the relay step must carry OVERFLOW_RELAY_RERUN_TOKEN exactly once — the " +
        "repo-scoped workflow token the job-start read and the rerun-heal authenticate with",
    ).toEqual(["${{ github.token }}"]);
  });

  it("passes the triggering run's attempt as OVERFLOW_GITHUB_WORKFLOW_RUN_ATTEMPT exactly once", () => {
    expect(
      envValues("OVERFLOW_GITHUB_WORKFLOW_RUN_ATTEMPT"),
      "the relay step must carry OVERFLOW_GITHUB_WORKFLOW_RUN_ATTEMPT exactly once — " +
        "the triggering run's attempt number, which the rerun-heal's attempt " +
        "cap compares against (issue 861)",
    ).toEqual(["${{ github.event.workflow_run.run_attempt }}"]);
  });

  it("passes the triggering run's head branch as OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_BRANCH exactly once", () => {
    expect(
      envValues("OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_BRANCH"),
      "the relay step must carry OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_BRANCH exactly once, through env — " +
        "the head branch the relay's trusted-producer check reads for push, " +
        "workflow_dispatch and schedule runs",
    ).toEqual(["${{ github.event.workflow_run.head_branch }}"]);
  });

  it("triggers on a schedule carrying exactly the ten-minute cron", () => {
    expect(
      workflow.on?.schedule,
      "the relay must trigger on a schedule — the sweep-only start exists so a " +
        "pending placeholder the sweep once posted is completed without waiting " +
        "for a producer run to arrive (issue 1116) — and the cron is pinned exactly",
    ).toEqual([{ cron: "*/10 * * * *" }]);
  });

  it("keeps the dispatch's run_id optional with an empty default", () => {
    const runId = workflow.on?.workflow_dispatch?.inputs?.run_id;
    // The two load-bearing fields; the description is prose and unpinned.
    expect(
      runId,
      "run_id must stay optional with an empty default: a dispatch WITH a run_id " +
        "heals exactly as today, and an empty-run_id dispatch is sweep-only — a " +
        "required input would make the sweep-only dispatch inexpressible",
    ).toMatchObject({ required: false, default: "" });
  });

  it("serializes every relay trigger in one literal concurrency group", () => {
    const group = workflow.concurrency?.group;
    expect(group, "the relay group must not vary with the event or run_id").not.toContain("${{");
    expect(
      group,
      "schedule, workflow_dispatch with or without run_id, and workflow_run " +
        "must share one repository-wide group so relay writes cannot overlap",
    ).toBe("ledger-relay");
  });

  it("passes the sweep-only predicate as OVERFLOW_LEDGER_SWEEP_ONLY exactly once, as the pinned expression", () => {
    expect(
      envValues("OVERFLOW_LEDGER_SWEEP_ONLY"),
      "the relay step must carry OVERFLOW_LEDGER_SWEEP_ONLY exactly once — the event " +
        "predicate that makes a scheduled start (or a workflow_dispatch without " +
        "a run_id) sweep-only, which the script fails closed on; every mode " +
        "still shares the literal ledger-relay concurrency group",
    ).toEqual([
      "${{ github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.run_id == '') }}",
    ]);
  });
});
