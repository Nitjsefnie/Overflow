import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Workflow = {
  on: unknown;
  permissions: Record<string, string>;
  jobs: Record<string, {
    if?: string;
    environment?: string;
    permissions?: Record<string, string>;
    steps: Step[];
  }>;
};

function readWorkflow(file: string): Workflow {
  return parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
}

describe("the comment-share measurement and privileged handoff", () => {
  // Missing triggers or a job guard can silently skip a required context.
  it("measures every pull request and every main push with read-only permissions", () => {
    const workflow = readWorkflow("comment-share.yml");
    expect(workflow.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["comment-share"]);
    expect(workflow.jobs["comment-share"].if).toBeUndefined();
  });

  // The staged base must bind records to the exact tree that was measured.
  it("stages only a push measurement whose checkout matches the run SHA", () => {
    const stage = readWorkflow("comment-share.yml").jobs["comment-share"].steps
      .find((step) => step.id === "stage");
    expect(stage).toBeDefined();
    expect(stage!.if).toBe("github.event_name == 'push'");
    expect(stage!.env?.BASE_SHA).toBe("${{ github.sha }}");
    expect(stage!.run).toMatch(/if \[ "\$\(git rev-parse HEAD\)" != "\$BASE_SHA" \]; then[\s\S]*?exit 1/);
  });

  // Unchanged records must not start another automated push chain.
  it("uploads only changed records and downloads the same named artifact", () => {
    const producer = readWorkflow("comment-share.yml").jobs["comment-share"];
    const upload = producer.steps.find((step) => step.if?.includes("steps.stage.outputs.changed"));
    expect(upload).toBeDefined();
    expect(upload!.if).toBe("success() && steps.stage.outputs.changed == 'true'");
    const download = readWorkflow("ratchet-push.yml").jobs.push.steps
      .find((step) => step.with?.name === upload!.with?.name);
    expect(upload!.with?.name).toBe("comment-share-ratchet");
    expect(download).toBeDefined();
  });

  // A PR completion must never enter the environment that holds the key.
  it("admits only successful main-push completions to the privileged environment", () => {
    const workflow = readWorkflow("ratchet-push.yml");
    expect(workflow.on).toEqual({ workflow_run: { workflows: ["comment share"], types: ["completed"] } });
    expect(workflow.permissions).toEqual({});
    expect(Object.keys(workflow.jobs)).toEqual(["push"]);
    const job = workflow.jobs.push;
    expect(job.if).toBe("github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.conclusion == 'success'");
    expect(job.environment).toBe("main-push");
    expect(job.permissions).toEqual({ actions: "read" });
  });

  // Privileged code must stay in the workflow, never in a downloaded tree.
  it("checks out no source and fails closed when the deploy key is empty", () => {
    const steps = readWorkflow("ratchet-push.yml").jobs.push.steps;
    expect(steps.some((step) => /^actions\/checkout(?:@|$)/.test(step.uses ?? ""))).toBe(false);
    const push = steps.find((step) => Object.hasOwn(step.env ?? {}, "MASTER_PUSH_DEPLOY_KEY"));
    expect(push).toBeDefined();
    expect(push!.run).toMatch(/if \[ -z "\$\{MASTER_PUSH_DEPLOY_KEY:-\}" \]; then[\s\S]*?exit 1/);
  });
});
