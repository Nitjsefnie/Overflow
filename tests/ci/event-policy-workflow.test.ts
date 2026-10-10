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
  environment?: string;
  if?: string;
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

/**
 * The named job's raw YAML lines, sliced from the file text between its
 * two-space-indented key and the next key at the same indent, or undefined
 * when the file carries no such job. Some properties are properties of the
 * SOURCE, not of the parsed object — a reference that appears nowhere in a
 * block — and the parsed object cannot prove an absence: `undefined` is
 * indistinguishable from a key the parser dropped or a document that was
 * never read. Those are asserted here, on the raw text.
 */
function rawJobBlock(source: string, jobName: string): string | undefined {
  const lines = source.split("\n");
  const start = lines.indexOf(`  ${jobName}:`);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

/** The raw `on:` block's lines, from its key to the next top-level key. */
function rawTriggerBlock(source: string): string {
  const lines = source.split("\n");
  const start = lines.indexOf("on:");
  const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
  return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

describe("the event-policy workflow", () => {
  let source = "";
  let workflow: ParsedWorkflow = {};
  let requiredCheckNames: string[] = [];
  let mainJob: WorkflowJob | undefined;
  let pullRequestJob: WorkflowJob | undefined;
  let mainBlock: string | undefined;
  let pullRequestBlock: string | undefined;

  beforeAll(async () => {
    source = await readFile(resolve(".github/workflows/event-policy.yml"), "utf8");
    workflow = parse(source) as ParsedWorkflow;
    requiredCheckNames = Object.keys(
      JSON.parse(await readFile(resolve(".github/required-checks.json"), "utf8")) as Record<
        string,
        string
      >,
    );
    mainJob = workflow.jobs?.["event-policy"];
    pullRequestJob = workflow.jobs?.["event-policy-pull-request"];
    mainBlock = rawJobBlock(source, "event-policy");
    pullRequestBlock = rawJobBlock(source, "event-policy-pull-request");
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

  it("splits the legs across exactly two jobs", () => {
    expect(Object.keys(workflow.jobs ?? {})).toEqual([
      "event-policy",
      "event-policy-pull-request",
    ]);
  });

  it("collides with no required check context", () => {
    for (const jobName of Object.keys(workflow.jobs ?? {})) {
      expect(
        requiredCheckNames,
        `${jobName} must not share its check-run name with a required context; ` +
          "a same-named job in a second workflow makes the required context's producer ambiguous",
      ).not.toContain(jobName);
    }
  });

  it("runs the ledger job only on push to main and the schedule", () => {
    expect(mainJob?.if).toBe(
      "github.event_name == 'push' || github.event_name == 'schedule'",
    );
  });

  it("enters the overflow-ledger environment that holds the App credential", () => {
    expect(mainJob?.environment).toBe("overflow-ledger");
  });

  it("keeps the bounded runner shape on the ledger job", () => {
    expect(mainJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(mainJob?.["timeout-minutes"]).toBe(5);
  });

  it("runs the ledger job's check with the workflow token and the App credentials", () => {
    expect(mainJob?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: "node scripts/check-actions-event-policy.ts",
          env: {
            GH_TOKEN: "${{ github.token }}",
            LEDGER_APP_ID: "5118623",
            LEDGER_INSTALLATION_ID: "166057493",
            LEDGER_APP_KEY: "${{ secrets.LEDGER_APP_KEY }}",
          },
        }),
      ]),
    );
  });

  it("keeps the two jobs' tool steps identical", () => {
    const toolSteps = (job: WorkflowJob | undefined) => ({
      checkout: job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@")),
      setupNode: job?.steps?.find((step) => step.uses?.startsWith("actions/setup-node@")),
    });
    // Object equality compares the pinned `uses` refs too, so a pin that moved
    // in only one job fails here rather than drifting apart silently.
    expect(toolSteps(pullRequestJob)).toEqual(toolSteps(mainJob));
    expect(toolSteps(mainJob)?.checkout?.with).toEqual({ "persist-credentials": false });
    expect(toolSteps(mainJob)?.setupNode?.with).toEqual({ "node-version": expect.any(String) });
  });

  it("runs the pull-request job only on pull_request", () => {
    expect(pullRequestJob?.if).toBe("github.event_name == 'pull_request'");
  });

  it("enters no environment on the pull-request job", () => {
    expect(pullRequestJob?.environment).toBeUndefined();
  });

  it("keeps the same bounded runner shape on the pull-request job", () => {
    expect(pullRequestJob?.["runs-on"]).toBe("ubuntu-latest");
    expect(pullRequestJob?.["timeout-minutes"]).toBe(5);
  });

  it("runs the pull-request job's check with the workflow token alone", () => {
    expect(pullRequestJob?.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          run: "node scripts/check-actions-event-policy.ts",
          env: { GH_TOKEN: "${{ github.token }}" },
        }),
      ]),
    );
  });

  it("carries the environment and the secret only in the ledger job's raw block", () => {
    // The positive half proves the slices found real job blocks: without it a
    // missing job would make the negative half below pass vacuously.
    expect(mainBlock).toContain("environment: overflow-ledger");
    expect(mainBlock).toContain("secrets.LEDGER_APP_KEY");
    expect(pullRequestBlock).toBeDefined();
    expect(pullRequestBlock).toContain("runs-on:");
    expect(pullRequestBlock).not.toContain("secrets.");
  });

  it("keeps pull_request_target out of the triggers and the pull-request job", () => {
    // `on:` parses to a trigger set whose equality is pinned above; this reads
    // the raw text so the same fact holds for a document the parser would
    // accept differently, and so the pull-request job itself — the leg whose
    // code a fork controls — carries no reference to the target trigger, the
    // environment, or the App secret.
    expect(rawTriggerBlock(source)).toContain("pull_request:");
    expect(rawTriggerBlock(source)).not.toContain("pull_request_target");
    expect(pullRequestBlock).toBeDefined();
    expect(pullRequestBlock).not.toContain("pull_request_target");
    expect(pullRequestBlock).not.toContain("environment");
  });
});
