import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

type WorkflowStep = {
  env?: Record<string, string | undefined>;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};
type ParsedWorkflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, WorkflowJob>;
};

describe("the event-policy workflow", () => {
  let workflow: ParsedWorkflow = {};

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/event-policy.yml"), "utf8");
    workflow = parse(source) as ParsedWorkflow;
  });

  it("has an object-valued on block with the required triggers", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { types: ["opened", "synchronize", "reopened"] },
      schedule: [{ cron: "37 6 * * *" }],
    });
  });

  it("grants only contents read at workflow scope", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("bounds concurrency using the repository event-class convention", () => {
    expect(workflow.concurrency).toEqual({
      group:
        "event-policy-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
  });

  it("has one bounded event-policy job that runs the script with the workflow token", () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual(["event-policy"]);
    const job = workflow.jobs?.["event-policy"];

    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    expect(job?.["timeout-minutes"]).toBe(5);
    expect(job?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: "node scripts/check-actions-event-policy.ts",
          env: { GH_TOKEN: "${{ github.token }}" },
        }),
      ]),
    );
  });

  it("does not persist checkout credentials", () => {
    const checkout = workflow.jobs?.["event-policy"]?.steps?.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});
