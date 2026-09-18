import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Issue 592 mechanism 3: a workflow_run job that comments the patch coverage
 * report onto the pull request. The job holds a PR-writing token and is
 * triggered by an event whose branch name, head SHA, and artifact contents are
 * attacker-influenceable, so its security shape is what must never drift —
 * this suite pins that shape on the parsed YAML data, the way
 * tests/api/ci-workflows.test.ts pins the other workflows:
 *
 * - it triggers only on completed runs of the ci workflow;
 * - it checks out NOTHING — the workspace stays empty, so no step can execute
 *   code from the pull request (the artifact is parsed as data only);
 * - it holds exactly the permissions the comment needs and nothing more;
 * - the artifact is downloaded from the triggering run's id, not the latest;
 * - every untrusted triggering-event value reaches the shell through env,
 *   never through ${{ }} interpolation into a run block;
 * - the destination PR is resolved from the event's head branch only;
 * - the comment is identified by one HTML-comment marker, updated in place;
 * - a body over the API's 65536-character limit is refused, never truncated;
 * - the check run reporting the outcome is named exactly "coverage comment".
 *
 * Assertions are made on the parsed YAML data (step.run / step.env / with),
 * never on the raw bytes, so reformatting the file does not disturb them and
 * a dropped step or rewired input fails loudly here instead of silently
 * changing what the job trusts.
 */
type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  if?: unknown;
  shell?: string;
  "continue-on-error"?: unknown;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
};

describe("the coverage comment workflow", () => {
  let workflow: Workflow = {};
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(
      resolve(".github/workflows/coverage-comment.yml"),
      "utf8",
    );
    workflow = parse(source) as Workflow;
    steps = workflow.jobs?.comment?.steps ?? [];
  });

  it("triggers only on completed runs of the ci workflow", () => {
    expect(workflow.on).toEqual({
      workflow_run: { workflows: ["ci"], types: ["completed"] },
    });
  });

  it("holds exactly the permissions the comment needs, nothing more", () => {
    expect(workflow.permissions).toEqual({
      "pull-requests": "write",
      checks: "write",
      actions: "read",
    });
  });

  it("serializes runs per head branch so one comment is never duplicated", () => {
    expect(workflow.concurrency).toEqual({
      group: "coverage-comment-${{ github.event.workflow_run.head_branch }}",
      "cancel-in-progress": false,
    });
  });

  it("checks out nothing — no checkout action, no git fetch or clone in any run block", () => {
    expect(
      steps.filter((step) => step.uses?.startsWith("actions/checkout@")),
      "no step may run actions/checkout — a checkout would put pull-request-controlled code in reach of a PR-writing token",
    ).toHaveLength(0);
    const runSteps = steps.filter((step) => step.run !== undefined);
    expect(runSteps.length).toBeGreaterThan(0);
    for (const step of runSteps) {
      expect(
        step.run,
        `the ${step.name} step must not fetch or clone the repository`,
      ).not.toMatch(/git (clone|fetch|checkout)\b/);
    }
  });

  it("interpolates no expression into any run block — untrusted values travel through env", () => {
    const runSteps = steps.filter((step) => step.run !== undefined);
    expect(runSteps.length).toBeGreaterThan(0);
    for (const step of runSteps) {
      expect(
        step.run?.includes("${{"),
        `the ${step.name} step must reference env names, never ${{ }} interpolation — untrusted-input interpolation in run: blocks is exactly what zizmor flags`,
      ).toBe(false);
    }
  });

  it("downloads the patch-coverage artifact from the triggering run only", () => {
    const downloads = steps.filter((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(downloads).toHaveLength(1);
    const [download] = downloads;
    expect(
      download.with,
      "the artifact must come from the triggering run's id with an explicit token — without run-id the job reads the latest run's report and comments one pull request's number on another",
    ).toEqual({
      name: "patch-coverage",
      path: "patch-coverage",
      "run-id": "${{ github.event.workflow_run.id }}",
      "github-token": "${{ github.token }}",
    });
    expect(
      Boolean(download["continue-on-error"]),
      "a missing artifact must reach the not-measured body, not fail the job — docs-only runs legitimately produce none",
    ).toBe(true);
  });

  it("resolves the destination PR from the event's head branch before anything else", () => {
    const [resolve] = steps.filter((step) => step.name === "Resolve the destination pull request");
    expect(resolve, "the resolve step must exist and come first").toBeDefined();
    expect(steps[0]?.name).toBe("Resolve the destination pull request");
    expect(
      resolve.env?.HEAD_BRANCH,
      "the head branch is attacker-controlled and must enter the shell through env",
    ).toBe("${{ github.event.workflow_run.head_branch }}");
  });

  it("wires the not-measured substitution from the triggering run's conclusion", () => {
    const [body] = steps.filter((step) => step.name === "Determine the comment body");
    expect(body, "the body step must exist").toBeDefined();
    expect(body.env).toEqual({
      CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
      HEAD_BRANCH: "${{ github.event.workflow_run.head_branch }}",
      PR_NUMBER: "${{ steps.pr.outputs.pr_number }}",
    });
  });

  it("carries the marker in both body variants and searches comments for that marker", () => {
    const runs = steps.map((step) => step.run ?? "").join("\n");
    expect(
      runs.match(/<!-- overflow:coverage-comment -->/g)?.length,
      "the marker must appear exactly twice: the body assembly writes it into every body variant, and the comment upsert searches for it — fewer means one variant cannot be found again, more means two sources of truth",
    ).toBe(2);
  });

  it("refuses a body over the API's 65536-character comment limit", () => {
    const runs = steps.map((step) => step.run ?? "").join("\n");
    expect(
      runs.match(/chars > \d+/g)?.length,
      "exactly one size comparison must exist",
    ).toBe(1);
    expect(
      runs,
      "the size guard must compare the assembled body against the API's 65536-character limit — pinning the comparison itself, not the constant, because the ::error:: message literal also contains 65536 and would otherwise keep a raised guard green — a truncated percentage would look current",
    ).toContain("chars > 65536");
  });

  it("publishes a check run named exactly 'coverage comment'", () => {
    const [check] = steps.filter((step) => step.name === "Publish the coverage comment check run");
    expect(check, "the check-run step must exist").toBeDefined();
    expect(check.if).toBe("always()");
    expect(
      check.run,
      "the check run's name is what reviewers look for in the checks list",
    ).toContain('name="coverage comment"');
  });
});
