import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * pr-suite.yml is where a pull request's own code runs: its install, its
 * migrations, its tests, lint, typecheck, build and page geometry. It runs
 * under `pull_request`, so the definition is the pull request's own and the
 * token is the read-only one GitHub gives an untrusted run. Nothing about it
 * is trusted: ci-pr.yml's verify job reads its outcome as data through the base
 * branch's scripts/await-pr-suite.ts, and it produces no required context.
 *
 * These pins hold the properties that make running untrusted code there
 * harmless: the single trigger, no secret, no environment, no write
 * permission, no persisted credential, and no job whose name is a required
 * context a check-run could be confused with.
 */

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};

type Job = {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: unknown;
  environment?: unknown;
  services?: Record<string, { image?: string }>;
  env?: Record<string, string>;
  steps: Step[];
};

type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const PATH = ".github/workflows/pr-suite.yml";
let source = "";
let workflow: Workflow;
let suite: Job;

beforeAll(async () => {
  source = await readFile(resolve(PATH), "utf8");
  workflow = parse(source) as Workflow;
  suite = workflow.jobs.suite!;
});

function runs(): string[] {
  return suite.steps.flatMap((step) => (step.run ? [step.run] : []));
}

function stepRunning(command: string): Step {
  const matching = suite.steps.filter((step) => (step.run ?? "").includes(command));
  expect(matching.map((step) => step.name), `exactly one step runs ${command}`).toHaveLength(1);
  return matching[0]!;
}

describe("the pull request suite workflow", () => {
  it("is named `pr suite`, the name the coverage comment keys on", async () => {
    expect(workflow.name).toBe("pr suite");
    const comment = parse(
      await readFile(resolve(".github/workflows/coverage-comment.yml"), "utf8"),
    ) as { on: { workflow_run: { workflows: string[] } } };
    expect(comment.on.workflow_run.workflows).toEqual([workflow.name]);
  });

  it("declares only the pull_request trigger, for main, on the three code-changing actions", () => {
    expect(workflow.on).toEqual({
      pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
  });

  it("holds a read-only token and no secret, environment or write permission anywhere", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/^\s*environment\s*:/m);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions, "a job-level block could widen the token").toBeUndefined();
      expect(job.environment).toBeUndefined();
    }
    expect(source).not.toMatch(/:\s*write\b/);
  });

  it("names no job after a required context", async () => {
    const required = Object.keys(
      JSON.parse(await readFile(resolve(".github/required-checks.json"), "utf8")) as Record<string, string>,
    );
    expect(required.sort()).toEqual(["actionlint", "ratchet-guard", "verify"]);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(required).not.toContain(id);
      expect(required).not.toContain(job.name ?? id);
    }
    expect(Object.keys(workflow.jobs)).toEqual(["suite"]);
  });

  it("is superseded only by the same pull request's newer push", () => {
    expect(workflow.concurrency).toEqual({
      group: "pr-suite-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  it("checks out the default pull_request merge commit with no persisted credential", () => {
    const checkouts = suite.steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toEqual({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false, "fetch-depth": 2 },
    });
    expect(suite["timeout-minutes"]).toBe(45);
    for (const step of suite.steps) {
      expect(step.uses ?? "@0000000000000000000000000000000000000000").toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("runs every code check verify ran for a pull request, in order", () => {
    const order = [
      "corepack install --global pnpm@10.33.0",
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "node scripts/docs-only.ts HEAD^1",
      "pnpm test --run --coverage",
      "node scripts/patch-coverage.ts",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
      "node scripts/check-page-geometry.mjs",
    ];
    const indices = order.map((command) => suite.steps.indexOf(stepRunning(command)));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(suite.services?.postgres?.image).toBe(
      "postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675",
    );
    expect(suite.env).toEqual(expect.objectContaining({
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      npm_config_registry: "https://registry.npmjs.org/",
      DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
    }));
  });

  it("measures coverage unless its own detection says docs-only, and plain-tests otherwise", () => {
    const detect = stepRunning("scripts/docs-only.ts");
    expect(detect.id).toBe("detect-docs");
    expect(detect.if).toBeUndefined();
    const tests = suite.steps.filter((step) => (step.run ?? "").startsWith("pnpm test --run"));
    expect(tests.map((step) => [step.if, step.run])).toEqual([
      [
        "${{ steps.detect-docs.outputs.docs_only != 'true' }}",
        "pnpm test --run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=cobertura --coverage.include='src/**'",
      ],
      ["${{ steps.detect-docs.outputs.docs_only == 'true' }}", "pnpm test --run"],
    ]);
  });

  // Seven days, not one: verify downloads coverage-summary from this run
  // cross-run, and a verify re-run or a relay heal can come days after the
  // suite finished; an expired artifact would fail that download.
  it("uploads both coverage artifacts under the names and retention their readers expect", () => {
    const uploads = suite.steps.filter((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(uploads.map((step) => [step.if, step.uses, step.with])).toEqual([
      [
        "${{ steps.detect-docs.outputs.docs_only != 'true' }}",
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        { name: "patch-coverage", path: "coverage/patch-coverage.json", "if-no-files-found": "error", "retention-days": 7 },
      ],
      [
        "${{ steps.detect-docs.outputs.docs_only != 'true' }}",
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        { name: "coverage-summary", path: "coverage/coverage-summary.json", "if-no-files-found": "error", "retention-days": 7 },
      ],
    ]);
  });

  it("judges nothing: no gate script whose verdict verify owns runs here", () => {
    for (const gate of [
      "check-coverage-floor.ts",
      "check-module-size.ts",
      "check-ratchets.ts",
      "check-migration-edits.ts",
      "check-legal-revisions.ts",
      "commit_scopes.py",
      "ci-base-freshness.sh",
      "await-pr-suite.ts",
    ]) {
      expect(runs().join("\n")).not.toContain(gate);
    }
  });

  it("is shipped: the deny-by-default ignore file names it back", () => {
    const result = spawnSync("git", ["check-ignore", "-q", PATH], { encoding: "utf8" });
    expect(result.status).toBe(1);
  });
});
