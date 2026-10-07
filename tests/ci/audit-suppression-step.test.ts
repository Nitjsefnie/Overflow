import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Issue 1035, defence in depth: dependency-audit.yml's pull-request leg runs
 * the same suppression-list divergence comparison as the load-bearing gate in
 * ci-pr.yml's verify job, so the audit step itself never runs on a divergent
 * list.
 *
 * The leg is ADVISORY by construction: it is defined by the pull request's own
 * workflow copy (this workflow runs under `pull_request`, so the checkout IS
 * the pull request), and a pull request that wanted to could edit or delete
 * the step. The load-bearing guard is ci-pr.yml's — base-defined, required,
 * un-deletable by the pull request. What this leg buys is that the audit
 * refuses to answer at all on a divergent list instead of reporting the pull
 * request's chosen answer.
 *
 * This suite EXECUTES the leg's real `run:` text the way the runner does —
 * bash with the runner's flags, BASE_SHA from the event, cwd a workspace
 * holding the pull request's checked-out merge commit — against a scratch
 * origin repository. There is NO NETWORK: the origin is a local git remote.
 */

type Step = {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
  if?: unknown;
  "continue-on-error"?: unknown;
};

const STEP_NAME = "Refuse a pull request that changes the audit suppression list";
const AUDIT_STEP_NAME = "Audit lockfile advisories";

/** Every refusal the leg can print, as exact constants — shared with the ci-pr gate. */
const REFUSALS = {
  entry:
    "::error::package.json must be exactly one mode-100644 blob entry in a tree; refusing. " +
    "The suppression list is read from git objects, never from the filesystem, so a symlink " +
    "leaf, a wrong mode, a non-blob type and an absent file are all refused.",
  size: "::error::package.json is larger than the 65536-byte cap; refusing",
  nul: "::error::package.json carries a NUL byte, which is invalid content wherever it sits; refusing",
  utf8: "::error::package.json is not valid UTF-8; refusing",
  json: "::error::package.json does not parse as JSON; refusing",
  fetch:
    "::error::could not fetch the pull request's base commit; refusing to judge the suppression " +
    "list without it",
  divergence:
    "::error::this pull request changes pnpm.auditConfig; a pull request cannot change the " +
    "audit suppression list — the list moves only through a maintainer-reviewed merge",
} as const;

/** Planted in pull-request-controlled content; must never reach the step's output. */
const MARKER = "GHSA-ATTACKER-SUPPRESSION-MARKER";

const PACKAGE_JSON = (config: unknown): string =>
  `${JSON.stringify({ name: "scratch", version: "0.0.0", pnpm: config }, null, 2)}\n`;

let steps: Step[] = [];
let root = "";
let counter = 0;

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/dependency-audit.yml"), "utf8")) as {
    jobs: { audit: { steps: Step[] } };
  };
  steps = workflow.jobs.audit.steps;
  root = await mkdtemp(join(tmpdir(), "audit-suppression-step-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function theStep(): Step {
  const matching = steps.filter((step) => step.name === STEP_NAME);
  expect(matching, `exactly one dependency-audit.yml step is named ${STEP_NAME}`).toHaveLength(1);
  return matching[0]!;
}

describe(`the ${STEP_NAME} step of dependency-audit.yml`, () => {
  it("is wired as defence in depth: event-gated, base SHA through env, before the audit step", () => {
    const step = theStep();
    expect(step.if, "the leg runs on the pull_request event only").toBe(
      "github.event_name == 'pull_request'",
    );
    expect(step.env, "the leg maps the event's base SHA and nothing else").toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(step["continue-on-error"], "the leg must not tolerate its own failure").toBeFalsy();
    const names = steps.map((entry) => entry.name);
    expect(names.indexOf(STEP_NAME), "the guard must run before the audit step").toBeLessThan(
      names.indexOf(AUDIT_STEP_NAME),
    );
    const run = step.run ?? "";
    expect(run, "the base is fetched by its pinned event SHA").toContain(
      'git fetch --quiet --depth=1 origin "${BASE_SHA:?}"',
    );
    expect(run, "no refs/pull refspec anywhere").not.toContain("refs/pull");
    expect(run, "no shell interpolation of event values — they arrive through env:").not.toContain(
      "${{",
    );
    for (const forbidden of ["PR_NUMBER", "PR_ID", "GH_TOKEN", "GITHUB_TOKEN"]) {
      expect(run, `the run block must not touch ${forbidden}`).not.toContain(forbidden);
    }
    expect(run, "the read is from git objects").toContain("git ls-tree");
    expect(run).toContain("git cat-file blob");
    expect(run, "the leg never audits; the audit step does").not.toMatch(
      /\b(pnpm|npm|npx|yarn|corepack)\s+(audit|install|ci|i|add|update|remove|run|exec|dlx|config)\b/,
    );
  });

  it("prints only the fixed refusal constants, and no pull-request bytes", () => {
    const run = theStep().run ?? "";
    const errorLines = run.split("\n").filter((line) => line.includes("::error::"));
    expect(errorLines.length).toBeGreaterThan(0);
    for (const line of errorLines) {
      expect(
        Object.values(REFUSALS).some((constant) => line.includes(constant)),
        `every refusal must be one of the fixed constants; found ${JSON.stringify(line)}`,
      ).toBe(true);
    }
    expect(run).toContain(REFUSALS.divergence);
    // The wire format of the event reaches the shell only through env:.
    expect(run).not.toMatch(/\$\{\{/);
  });

  /**
   * A scratch origin whose main carries `basePackage`, plus a merge commit of
   * a pull request whose tree carries `mergePackage`, and a workspace holding
   * that merge commit checked out — the state actions/checkout leaves on a
   * pull_request event (shallow, HEAD at the merge).
   */
  async function fixture(
    basePackage: string,
    mergePackage: string | { mode: string; content: string },
  ): Promise<{ workspace: string; base: string }> {
    counter += 1;
    const origin = join(root, `origin-${counter}`);
    const workspace = join(root, `workspace-${counter}`);
    await mkdir(origin, { recursive: true });
    const gitEnv: Record<string, string> = {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "scratch repository",
      GIT_AUTHOR_EMAIL: "scratch@example.invalid",
      GIT_COMMITTER_NAME: "scratch repository",
      GIT_COMMITTER_EMAIL: "scratch@example.invalid",
    };
    const g = (repo: string, ...args: string[]): string => {
      const result = spawnSync("git", args, {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, ...gitEnv },
      });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    const writeBlob = async (repo: string, content: string): Promise<string> => {
      const file = join(root, `blob-${counter}`);
      await writeFile(file, content);
      return g(repo, "hash-object", "-w", file);
    };

    g(origin, "init", "--quiet", "--initial-branch=main");
    g(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
    const baseBlob = await writeBlob(origin, basePackage);
    g(origin, "update-index", "--add", "--cacheinfo", `100644,${baseBlob},package.json`);
    g(origin, "commit", "--quiet", "-m", "base");
    const base = g(origin, "rev-parse", "HEAD");

    if (typeof mergePackage === "string") {
      const id = await writeBlob(origin, mergePackage);
      g(origin, "update-index", "--add", "--cacheinfo", `100644,${id},package.json`);
    } else {
      const id = await writeBlob(origin, mergePackage.content);
      g(origin, "update-index", "--add", "--cacheinfo", `${mergePackage.mode},${id},package.json`);
    }
    const tree = g(origin, "write-tree");
    const merge = g(origin, "commit-tree", tree, "-p", base, "-m", "merge");

    await mkdir(workspace, { recursive: true });
    g(workspace, "init", "--quiet");
    g(workspace, "remote", "add", "origin", `file://${origin}`);
    g(workspace, "fetch", "--depth=1", "origin", merge);
    g(workspace, "checkout", "--detach", "FETCH_HEAD");
    return { workspace, base };
  }

  async function runStep(
    fx: { workspace: string; base: string },
    overrides: { baseSha?: string } = {},
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    counter += 1;
    const script = join(root, `step-${counter}.sh`);
    await writeFile(script, theStep().run ?? "exit 99\n");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
      cwd: fx.workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        BASE_SHA: overrides.baseSha ?? fx.base,
        PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("passes when the merge tree repeats the base's suppression list exactly", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe("");
  });

  it("refuses a pull request that adds a suppression the base does not carry", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const attack = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm", MARKER] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(attack));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.divergence);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a pull request that removes the suppression list entirely", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(undefined));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.divergence);
  });

  it("refuses a pull request that commits its package.json as a symlink", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), {
      mode: "120000",
      content: `../../evil-package.json ${MARKER}`,
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.entry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a NUL byte in the pull request's package.json", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const content = `{"name":"scratch\u0000${MARKER}","pnpm":{"auditConfig":{"ignoreGhsas":["GHSA-vfj7-8cjw-p6xm"]}}}`;
    const fx = await fixture(PACKAGE_JSON(config), content);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.nul);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses when the pinned base commit cannot be fetched", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config));
    const result = await runStep(fx, {
      baseSha: "0123456789abcdef0123456789abcdef01234567",
    });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.fetch);
  });
});
