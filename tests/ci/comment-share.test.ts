import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

function listArtifacts(step: Step, artifactNames: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "overflow-comment-share-list-"));
  try {
    const output = join(root, "output");
    writeFileSync(output, "");
    writeFileSync(join(root, "artifacts.json"), JSON.stringify({
      artifacts: artifactNames.map((name) => ({ name, expired: false })),
    }));
    writeFileSync(join(root, "gh"), [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const args = process.argv.slice(2);',
      'const query = args[args.indexOf("--jq") + 1];',
      'const endpoint = `repos/${process.env.REPO}/actions/runs/${process.env.RUN_ID}/artifacts`;',
      'if (args[0] !== "api" || !args.includes(endpoint) || !args.includes("--paginate")',
      '  || !args.includes("Cache-Control: no-cache")',
      '  || query !== ".artifacts[] | select(.expired != true) | .name") process.exit(2);',
      'const response = JSON.parse(fs.readFileSync(process.env.ARTIFACT_LIST, "utf8"));',
      'for (const artifact of response.artifacts) {',
      '  if (!artifact.expired) console.log(artifact.name);',
      '}',
      "",
    ].join("\n"));
    chmodSync(join(root, "gh"), 0o755);
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", step.run!], {
      env: { ...process.env, NODE_ENV: "test", PATH: `${root}:${process.env.PATH}`,
        REPO: "fixture/project", RUN_ID: "42", ARTIFACT_LIST: join(root, "artifacts.json"), GITHUB_OUTPUT: output },
      encoding: "utf8", timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return readFileSync(output, "utf8");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    const artifactName = upload!.with?.name;
    expect(artifactName).toBeTypeOf("string");
    expect(artifactName).not.toBe("");
    const steps = readWorkflow("ratchet-push.yml").jobs.push.steps;
    const download = steps.find((step) =>
      /^actions\/download-artifact(?:@|$)/.test(step.uses ?? "") && step.with?.name === artifactName);
    expect(download).toBeDefined();
    const listing = steps.find((step) => step.id === "list");
    expect(listing?.run).toBeDefined();
    const runId = download!.with?.["run-id"];
    expect(runId).toBeTypeOf("string");
    expect(runId).toBe(listing!.env?.RUN_ID);
    expect(runId).toMatch(/\bgithub\.event\.workflow_run\.id\b/);
    expect(listArtifacts(listing!, [artifactName as string])).toBe("records=true\n");
    expect(listArtifacts(listing!, [])).toBe("records=false\n");
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
    // Execute only this guard: a later artifact failure must not stand in
    // for rejecting an empty key, and no privileged side effect may run.
    const guard = push!.run!.match(/^if \[ -z "\$\{MASTER_PUSH_DEPLOY_KEY:-\}" \]; then\n[\s\S]*?^fi$/m);
    expect(guard, "the empty-key guard must be present as a complete block").not.toBeNull();
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", guard![0]], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", MASTER_PUSH_DEPLOY_KEY: "" },
      encoding: "utf8",
      timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, "an empty deploy key must fail in its own guard").toBe(1);
  });
});
