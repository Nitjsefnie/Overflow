import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * The relay mints its App installation token from the LEDGER_APP_ID and
 * LEDGER_INSTALLATION_ID literals pinned in its step env, so a silently
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
type WorkflowStep = { name?: string; env?: Record<string, string | undefined> };
type ParsedWorkflow = {
  on?: {
    schedule?: string[];
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
  permissions?: Record<string, string>;
  concurrency?: { group?: string };
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
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

  it("carries the ledger App id exactly once, as the literal the gate and tests pin", () => {
    expect(
      envValues("LEDGER_APP_ID"),
      "the relay job must carry env LEDGER_APP_ID exactly once — the App id every " +
        "relay check-run is posted under, which branch protection and the deploy " +
        "gate read back",
    ).toEqual(["5118623"]);
  });

  it("carries the App installation id exactly once, as the pinned literal", () => {
    expect(
      envValues("LEDGER_INSTALLATION_ID"),
      "the relay job must carry env LEDGER_INSTALLATION_ID exactly once — the " +
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

  it("passes the workflow's own token as RELAY_RERUN_TOKEN exactly once", () => {
    expect(
      envValues("RELAY_RERUN_TOKEN"),
      "the relay step must carry RELAY_RERUN_TOKEN exactly once — the " +
        "repo-scoped workflow token the rerun-heal authenticates its POST with",
    ).toEqual(["${{ github.token }}"]);
  });

  it("passes the triggering run's attempt as GITHUB_WORKFLOW_RUN_ATTEMPT exactly once", () => {
    expect(
      envValues("GITHUB_WORKFLOW_RUN_ATTEMPT"),
      "the relay step must carry GITHUB_WORKFLOW_RUN_ATTEMPT exactly once — " +
        "the triggering run's attempt number, which the rerun-heal's attempt " +
        "cap compares against (issue 861)",
    ).toEqual(["${{ github.event.workflow_run.run_attempt }}"]);
  });

  it("passes the triggering run's head branch as GITHUB_WORKFLOW_RUN_HEAD_BRANCH exactly once", () => {
    expect(
      envValues("GITHUB_WORKFLOW_RUN_HEAD_BRANCH"),
      "the relay step must carry GITHUB_WORKFLOW_RUN_HEAD_BRANCH exactly once, through env — " +
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

  it("keys the concurrency group with the same predicate the sweep-only env carries", () => {
    // The predicate is read from the workflow's OWN env value, not restated:
    // the drift this catches is one copy edited and its literal pin updated to
    // match, which leaves every restated pin green while the group and the env
    // diverge.
    const envExpression = String(envValues("LEDGER_SWEEP_ONLY")[0] ?? "");
    const predicate = envExpression.replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim();
    const group = String(workflow.concurrency?.group ?? "").replace(/^\$\{\{/, "").replace(/\}\}$/, "").trim();
    expect(predicate, "the premise: the step carries a sweep-only predicate").not.toBe("");
    // Containment alone is too weak to be the witness: the group legitimately
    // holds each arm of the predicate, so a SHRUNKEN env copy would still be
    // contained. The relation pinned is the design's exact pairing — the group
    // is the env predicate, parenthesized, between the two group names.
    expect(
      group,
      "the concurrency group must decide the sweep-only case from the SAME " +
        "predicate the LEDGER_SWEEP_ONLY env carries: one copy changed without " +
        "the other puts a sweep-only start in the relay group (it displaces a " +
        "PENDING workflow_run relay) or a healing dispatch in the sweep group",
    ).toEqual(`(${predicate}) && 'ledger-relay-sweep' || 'ledger-relay'`);
  });

  it("passes the sweep-only predicate as LEDGER_SWEEP_ONLY exactly once, as the pinned expression", () => {
    expect(
      envValues("LEDGER_SWEEP_ONLY"),
      "the relay step must carry LEDGER_SWEEP_ONLY exactly once — the event " +
        "predicate that makes a scheduled start (or a workflow_dispatch without " +
        "a run_id) sweep-only, which the script fails closed on: the same " +
        "predicate keys the concurrency group, so the two cannot drift",
    ).toEqual([
      "${{ github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.run_id == '') }}",
    ]);
  });
});
