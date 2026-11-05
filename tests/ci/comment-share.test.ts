import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on: unknown;
  permissions: Record<string, string>;
  jobs: Record<string, { if?: string }>;
};

function readWorkflow(file: string): Workflow {
  return parse(readFileSync(resolve(".github/workflows", file), "utf8")) as Workflow;
}

describe("the comment-share measurement and privileged handoff", () => {
  // Missing triggers or a job guard can silently skip a required context.
  it("measures every pull request and every main push with read-only permissions", () => {
    const workflow = readWorkflow("comment-share.yml");
    expect(workflow.on).toMatchObject({ pull_request: null, push: { branches: expect.arrayContaining(["main"]) } });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["comment-share"]);
    expect(workflow.jobs["comment-share"].if).toBeUndefined();
  });
});
