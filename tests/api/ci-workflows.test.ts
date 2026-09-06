import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on: Record<string, { branches?: string[]; paths?: string[] } | null>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, {
    services?: Record<string, { image?: string; options?: string }>;
    env?: Record<string, string>;
    steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
  }>;
};

describe("GitHub Actions release gates", () => {
  it("parses a complete PostgreSQL 17 gate with pinned actions and every release command", async () => {
    const workflow = await readWorkflow("ci.yml");
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      packageManager?: string;
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      packageManager: "pnpm@10.33.0",
      engines: { node: "24.17.0", pnpm: "10.33.0" },
    });
    expect(manifest.scripts?.["db:migrate"]).toBe(
      "node --env-file-if-exists=.env scripts/migrate.ts"
    );
    expect(workflow.on).toEqual(expect.objectContaining({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      workflow_dispatch: null,
    }));
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on.pull_request).not.toHaveProperty("paths");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ci-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    });

    const verify = workflow.jobs.verify!;
    expect(verify.services?.postgres?.image).toBe("postgres:17");
    expect(verify.services?.postgres?.options).toContain("pg_isready");
    expect(verify.steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
      .toEqual(expect.objectContaining({ "persist-credentials": false }));
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with)
      .toEqual(expect.objectContaining({ "node-version": "24.17.0" }));
    expect(verify.steps.map((step) => step.run).filter(Boolean)).toEqual(expect.arrayContaining([
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "pnpm test --run",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
    ]));
    expect(verify.env).toEqual(expect.objectContaining({
      DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
      GITHUB_WEBHOOK_URL: "https://overflow.invalid/api/github/webhooks",
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }));
  });

  it("parses a catalogue-style workflow gate with explicit least privilege and pinned actions", async () => {
    const workflow = await readWorkflow("actionlint.yml");
    expect(workflow.on).toEqual(expect.objectContaining({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      workflow_dispatch: null,
    }));
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on.pull_request).not.toHaveProperty("paths");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "actionlint-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": true,
    });
    const steps = workflow.jobs.actionlint!.steps;
    expect(steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
      .toEqual(expect.objectContaining({ "persist-credentials": false }));
    expect(steps.some((step) => step.run === "./actionlint -color .github/workflows/*.yml")).toBe(true);
    expect(steps.some((step) => step.run === "zizmor --no-progress .github/workflows/")).toBe(true);
  });

  it("reopens only shipped yml workflows in the deny-by-default ignore policy", () => {
    expect(checkIgnore(".github/workflows/ci.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/actionlint.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/unshipped.yaml")).toBe(0);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
  });
});

async function readWorkflow(name: string): Promise<Workflow> {
  return parse(await readFile(resolve(".github/workflows", name), "utf8")) as Workflow;
}

function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
  }).status;
}
