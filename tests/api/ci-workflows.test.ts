import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Workflow = {
  on: Record<
    string,
    { branches?: string[]; paths?: string[]; types?: string[] } | Array<{ cron: string }> | null
  >;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean | string };
  jobs: Record<string, {
    if?: string;
    "runs-on"?: string;
    "timeout-minutes"?: number;
    services?: Record<string, { image?: string; options?: string }>;
    env?: Record<string, string>;
    steps: Array<{ uses?: string; run?: string; with?: Record<string, unknown> }>;
  }>;
};

describe("GitHub Actions release gates", () => {
  it("preserves claim policy around the reviewed shared action without input overrides", async () => {
    const workflow = await readWorkflow("claim.yml");
    expect(workflow.on).toEqual({ issue_comment: { types: ["created"] } });
    expect(workflow.permissions).toEqual({ issues: "write" });
    expect(workflow.concurrency).toEqual({
      group: "claim-${{ github.event.issue.number }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs).toEqual({
      claim: {
        if: "github.event.issue.pull_request == null"
          + " && github.event.issue.state == 'open'"
          + " && github.event.comment.user.type != 'Bot'"
          + " && (contains(github.event.comment.body, '/claim')\n"
          + "    || contains(github.event.comment.body, '/unclaim')\n"
          + "    || contains(github.event.comment.body, '/release'))",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [{ uses: "Nitjsefnie-Actions/claim@d9976f1f803f7a662eed3be17772800b7925e650" }],
      },
    });
  });

  it("checks admission through the reviewed shared action without a consumer checkout", async () => {
    const workflow = await readWorkflow("pr-gate.yml");
    expect(workflow.on).toEqual({ pull_request_target: { types: ["opened", "edited", "reopened"] } });
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "read" });
    expect(workflow.concurrency).toEqual({
      group: "pr-gate-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs).toEqual({
      gate: {
        if: "github.event.pull_request.user.type != 'Bot'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [{
          uses: "Nitjsefnie-Actions/pr-gate@679744b0807472d5fd681e42759f081494f2f562",
          with: {
            "github-token": "${{ github.token }}",
            repository: "${{ github.repository }}",
            "pull-request-number": "${{ github.event.pull_request.number }}",
            "pull-request-author": "${{ github.event.pull_request.user.login }}",
          },
        }],
      },
    });
  });

  it("parses a complete PostgreSQL 17 gate with pinned actions and every release command", async () => {
    const workflow = await readWorkflow("ci.yml");
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      packageManager?: string;
      engines?: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      packageManager: "pnpm@10.33.0",
      engines: { node: "24.17.0", pnpm: "10.33.0" },
    });
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
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    const verify = workflow.jobs.verify!;
    expect(verify.services?.postgres?.image).toBe("postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675");
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
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
    const steps = workflow.jobs.actionlint!.steps;
    expect(steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with)
      .toEqual(expect.objectContaining({ "persist-credentials": false }));
    expect(steps.some((step) => step.run === "./actionlint -color .github/workflows/*.yml")).toBe(true);
    expect(steps.some((step) => step.run === "zizmor --no-progress .github/workflows/")).toBe(true);
  });

  it("parses a scheduled lockfile audit whose gate is the bare audit command's exit code", async () => {
    const workflow = await readWorkflow("dependency-audit.yml");
    expect(workflow.on).toEqual({
      schedule: [{ cron: "37 6 * * 1" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "dependency-audit-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    // The whole job, exactly, in the claim/pr-gate style: any extra key — a
    // step-level continue-on-error tolerating a red audit, or a job-level
    // permissions override — fails this equality. The gate is the audit
    // command's own exit code, exactly as verified against pnpm 10.33.0:
    // bare `pnpm audit` exits 1 iff advisories exist. No install and no
    // build precede it — pnpm audit reads pnpm-lock.yaml directly.
    expect(workflow.jobs.audit).toEqual({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0" },
        },
        {
          name: "Enable the pinned package manager",
          run: "corepack enable\ncorepack install --global pnpm@10.33.0\npnpm --version\n",
        },
        {
          name: "Audit lockfile advisories",
          run: "pnpm audit",
        },
      ],
    });
  });

  it("keeps the dependabot update policy excluding the locally patched postgres", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      version: number;
      updates: Array<{
        "package-ecosystem": string;
        directory: string;
        schedule: { interval: string };
        "open-pull-requests-limit": number;
        ignore?: Array<{ "dependency-name": string }>;
      }>;
    };

    expect(config.version).toBe(2);
    expect(config.updates).toHaveLength(1);
    const [update] = config.updates;
    expect(update["package-ecosystem"]).toBe("npm");
    expect(update.directory).toBe("/");
    expect(update.schedule).toEqual({ interval: "weekly" });
    expect(update["open-pull-requests-limit"]).toBe(5);
    // An automated postgres bump invalidates patches/postgres@3.4.9.patch and
    // its pnpm-lock.yaml patchedDependencies hash, breaking
    // `pnpm install --frozen-lockfile` — bumps stay by-hand.
    expect(update.ignore).toEqual([{ "dependency-name": "postgres" }]);
  });

  it("reopens only shipped yml workflows in the deny-by-default ignore policy", () => {
    expect(checkIgnore(".github/workflows/ci.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/actionlint.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/dependency-audit.yml")).toBe(1);
    expect(checkIgnore(".github/dependabot.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/unshipped.yaml")).toBe(0);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
  });

  it("parses a source-only CodeQL scan that installs and builds nothing", async () => {
    const workflow = await readWorkflow("code-scanning.yml") as Workflow & { name: string };
    expect(workflow.name).toBe("code scanning");
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      schedule: [{ cron: "43 5 * * 3" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "code-scanning-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    const analyze = workflow.jobs.analyze! as typeof workflow.jobs.analyze & {
      permissions: Record<string, string>;
    };
    expect(analyze.steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);

    // The whole job, exactly, in the dependency-audit style: the job-level
    // permissions object is the least privilege uploading SARIF needs, and
    // any extra key — a tolerated failure, a checkout without
    // persist-credentials disabled — fails this equality.
    expect(analyze).toEqual({
      permissions: { contents: "read", "security-events": "write" },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          uses: "github/codeql-action/init@b96794f015dfd88f77b49b1c93e0fa7110f94c63",
          with: { languages: "javascript-typescript" },
        },
        {
          uses: "github/codeql-action/analyze@b96794f015dfd88f77b49b1c93e0fa7110f94c63",
          with: { category: "/language:javascript-typescript" },
        },
      ],
    } satisfies typeof analyze);

    // The no-build principle as its own named assertion, so a "helpful"
    // install or build step fails a pin that says so rather than only a
    // shape diff: CodeQL for JS/TS extracts from source.
    for (const command of analyze.steps.map((step) => step.run).filter(Boolean)) {
      expect(command).not.toMatch(/pnpm (install|build)/);
    }
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
