import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/ci-pr.yml", "utf8");
const workflow = parse(source);
const verify = workflow.jobs.verify;

describe("the required verify suite chain", () => {
  it("runs only after a pr suite completion", () => {
    expect(workflow.on).toEqual({ workflow_run: { workflows: ["pr suite"], types: ["completed"] } });
  });

  it("cannot satisfy branch protection by skipping the job", () => {
    expect(verify.if).toBeUndefined();
  });

  it("skips every step after the resolver when it reports superseded", () => {
    const resolverIndex = verify.steps.findIndex((step: { id?: string }) => step.id === "pr");
    expect(resolverIndex).toBeGreaterThan(-1);
    for (const step of verify.steps.slice(resolverIndex + 1)) {
      expect(step.if, step.name).toMatch(/steps\.pr\.outputs\.superseded != 'true'/);
    }
  });

  it("issues base freshness only after the coverage floor, as the final step", () => {
    const names = verify.steps.map((step: { name?: string }) => step.name);
    expect(names.at(-1)).toBe("Base freshness");
    expect(names.indexOf("Coverage floor over the suite's summary")).toBeGreaterThan(-1);
  });

  it("names its upstream run using the relay's exact display-title contract", () => {
    expect(workflow["run-name"]).toBe("verify for pr suite run ${{ github.event.workflow_run.id }}");
    const title = workflow["run-name"].replace("${{ github.event.workflow_run.id }}", "123");
    expect(title).toMatch(/^verify for pr suite run ([1-9][0-9]*)$/);
  });

  it("reads PR fields from the resolver rather than a missing event payload", () => {
    expect(source).not.toContain("github.event.pull_request");
    const resolver = verify.steps.find((step: { id?: string }) => step.id === "pr");
    expect(resolver?.run).toContain("/scripts/resolve-suite-pull-request.ts");
    expect(resolver?.env?.SUITE_RUN_ID).toBe("${{ github.event.workflow_run.id }}");
    for (const step of verify.steps) expect(step.run ?? "").not.toContain("${{");
    const awaiter = verify.steps.find((step: { id?: string }) => step.id === "suite");
    expect(awaiter.env.SUITE_RUN_ID).toBe("${{ github.event.workflow_run.id }}");
    expect(awaiter.env.SUITE_RUN_ATTEMPT).toBe("${{ github.event.workflow_run.run_attempt }}");
    expect(awaiter.env.HEAD_SHA).toBe("${{ steps.pr.outputs.head_sha }}");
  });
});
