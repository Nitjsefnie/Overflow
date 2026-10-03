import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

type WorkflowStep = {
  env?: Record<string, string | undefined>;
  run?: string;
};
type WorkflowJob = {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};
type ParsedWorkflow = {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
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
});
