import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv } from "../support/scratch-git";
/**
 * Issue 1035: the audit suppression list is load-bearing data and it moves
 * only through a maintainer-reviewed merge. The dependency audit honours
 * `pnpm.auditConfig` from the pull request's own package.json, so a pull
 * request that adds a vulnerable dependency together with an `ignoreGhsas`
 * entry for it gets a clean audit — and once merged, the scheduled audit on
 * main is silenced too.
 *
 * The load-bearing guard is the BASE-defined step in ci-pr.yml's verify job
 * ("Refuse a pull request that changes the audit suppression list"): verify is
 * required and its definition is the base branch's, so a hostile pull request
 * cannot delete it. This suite EXECUTES that step's real `run:` text the way
 * the runner does — bash with the runner's flags, BASE_SHA and MERGE_SHA
 * resolved from the case, cwd a scratch repository holding both commits —
 * mirroring how tests/ci/verify-zizmor-step.test.ts executes the zizmor pin
 * gate. There is NO NETWORK: the step shells out only to git and python3.
 *
 * Two fixtures matter per case: the BASE commit (the acceptance's home) and
 * the MERGE commit (what the pull request would land). The step refuses
 * whenever the two trees carry different `pnpm.auditConfig` values, read from
 * git objects on both sides — never from the filesystem — and every refusal
 * prints a FIXED constant that carries no pull-request bytes.
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

/** Every refusal the step can print, as exact constants. */
const REFUSALS = {
  entry:
    "::error::package.json must be exactly one mode-100644 blob entry in a tree; refusing. " +
    "The suppression list is read from git objects, never from the filesystem, so a symlink " +
    "leaf, a wrong mode, a non-blob type and an absent file are all refused.",
  size: "::error::package.json is larger than the 65536-byte cap; refusing",
  nul: "::error::package.json carries a NUL byte, which is invalid content wherever it sits; refusing",
  utf8: "::error::package.json is not valid UTF-8; refusing",
  json: "::error::package.json does not parse as JSON; refusing",
  divergence:
    "::error::this pull request changes pnpm.auditConfig; a pull request cannot change the " +
    "audit suppression list — the list moves only through a maintainer-reviewed merge",
} as const;

/** Planted where a redirected read or a leaked refusal would print it; must never reach output. */
const MARKER = "GHSA-ATTACKER-SUPPRESSION-MARKER";

const BASE_PACKAGE_JSON = (config: unknown): string =>
  `${JSON.stringify({ name: "scratch", version: "0.0.0", pnpm: config }, null, 2)}\n`;

let steps: Step[] = [];
let root = "";
let counter = 0;

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8")) as {
    jobs: { verify: { steps: Step[] } };
  };
  steps = workflow.jobs.verify.steps;
  root = await mkdtemp(join(tmpdir(), "verify-suppression-step-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function theStep(): Step {
  const matching = steps.filter((step) => step.name === STEP_NAME);
  expect(matching, `exactly one ci-pr.yml verify step is named ${STEP_NAME}`).toHaveLength(1);
  return matching[0]!;
}

/**
 * A scratch repository whose base commit carries `basePackage` as package.json
 * (or no package.json at all when `null`), plus a merge commit whose tree
 * carries `mergePackage`. Modes are set by index surgery over plumbing, so a
 * 120000 symlink, a 100755 file and a 160000 gitlink ride the same code as the
 * ordinary 100644 cases.
 */
async function fixture(
  basePackage: string | null,
  mergePackage: string | { mode: string; content: string } | null,
): Promise<{ repo: string; base: string; merge: string }> {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");

  async function blob(content: string): Promise<string> {
    const file = join(root, `blob-${counter}`);
    await writeFile(file, content);
    return git(repo, "hash-object", "-w", file);
  }

  const files: Record<string, string> = { "README.md": "# scratch\n" };
  if (basePackage !== null) files["package.json"] = basePackage;
  const base = await commitFiles(repo, files, "base");

  if (typeof mergePackage === "string") {
    const id = await blob(mergePackage);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${id},package.json`);
  } else if (mergePackage && typeof mergePackage === "object") {
    const id = mergePackage.mode === "160000" ? base : await blob(mergePackage.content);
    git(repo, "update-index", "--add", "--cacheinfo", `${mergePackage.mode},${id},package.json`);
  } else if (mergePackage === null && basePackage !== null) {
    git(repo, "update-index", "--force-remove", "package.json");
  }
  const tree = git(repo, "write-tree");
  const merge = git(repo, "commit-tree", tree, "-p", base, "-m", "merge case");
  return { repo, base, merge };
}

type StepResult = { status: number | null; stdout: string; stderr: string };

/** Runs the step's real `run:` text the way the runner does. */
async function runStep(fx: { repo: string; base: string; merge: string }): Promise<StepResult> {
  counter += 1;
  const script = join(root, `step-${counter}.sh`);
  await writeFile(script, theStep().run ?? "exit 99\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: fx.repo,
    encoding: "utf8",
    env: {
      ...scratchGitEnv,
      BASE_SHA: fx.base,
      MERGE_SHA: fx.merge,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe(`the ${STEP_NAME} step of ci-pr.yml`, () => {
  it("is wired as the guard requires: base-defined event values, gated on the event, silent on success", () => {
    const step = theStep();
    expect(step.env, "the step maps the merge SHA and the event's base SHA and nothing else").toEqual({
      MERGE_SHA: "${{ steps.pr-tree.outputs.merge_sha }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    });
    expect(step.if, "the step is gated on the pull_request_target event").toBe(
      "github.event_name == 'pull_request_target'",
    );
    expect(step["continue-on-error"], "the gate must not tolerate its own failure").toBeFalsy();
    const names = steps.map((entry) => entry.name);
    expect(names.indexOf(STEP_NAME)).toBeGreaterThan(
      names.indexOf("Materialise the pull request's merge tree as data"),
    );
    expect(names.indexOf(STEP_NAME)).toBeLessThan(names.indexOf("Base freshness"));
    expect(step.run, "the read is from git objects").toContain("git ls-tree");
    expect(step.run).toContain("git cat-file blob");
    expect(step.run, "no shell interpolation of event values — they arrive through env:").not.toContain(
      "${{",
    );
    for (const forbidden of ["GH_TOKEN", "GITHUB_TOKEN", "PR_TREE"]) {
      expect(step.run, `the run block must not touch ${forbidden}`).not.toContain(forbidden);
    }
    expect(step.run, "the step must not run pip").not.toMatch(/(?<![\w./-])pip3?(?![\w-])/);
    expect(step.run, "the step must not run a package manager").not.toMatch(
      /\b(pnpm|npm|npx|yarn|corepack)\s+(audit|install|ci|i|add|update|remove|run|exec|dlx|config)\b/,
    );
  });

  it("prints only the fixed refusal constants — no interpolated, pull-request-controlled bytes", () => {
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
  });

  it("passes when the merge tree repeats the base's suppression list exactly", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(BASE_PACKAGE_JSON(config), BASE_PACKAGE_JSON(config));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe("");
  });

  it("passes when the two package.json files differ in every way but the auditConfig value", async () => {
    // Structural, not textual: key order, indentation and JSON escaping are
    // package.json formatting; the canonical dump of the parsed auditConfig is
    // what is compared.
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const mergePackage =
      `{\n  "pnpm": {\n    "auditConfig": {\n      "ignoreGhsas": ["GHSA-vfj7-8cjw-p6xm"]\n    }\n  },\n  "name": "\\u0073cratch"\n}\n`;
    const fx = await fixture(BASE_PACKAGE_JSON(config), mergePackage);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe("");
  });

  it("passes when neither side carries an audit suppression list", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(`${result.stdout}${result.stderr}`).toBe("");
  });

  it("refuses a pull request that adds a suppression the base does not carry", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const attack = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm", MARKER] } };
    const fx = await fixture(BASE_PACKAGE_JSON(config), BASE_PACKAGE_JSON(attack));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.divergence);
    expect(`${result.stdout}${result.stderr}`, "no pull-request bytes may reach the log").not.toContain(
      MARKER,
    );
  });

  it("refuses a pull request that removes the suppression list entirely", async () => {
    // Issue 1035's reproduction: `del(.pnpm.auditConfig)` must go red.
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(BASE_PACKAGE_JSON(config), BASE_PACKAGE_JSON(undefined));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.divergence);
  });

  it("refuses a pull request that reorders the accepted advisory ids", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const attack = { auditConfig: { ignoreGhsas: [MARKER, "GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(BASE_PACKAGE_JSON(config), BASE_PACKAGE_JSON(attack));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a pull request that nulls the suppression list", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(
      BASE_PACKAGE_JSON(config),
      `${JSON.stringify({ name: "scratch", pnpm: { auditConfig: null } })}\n`,
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.divergence);
  });

  it("refuses a pull request that adds a suppression list to an unlisted base", async () => {
    const attack = { auditConfig: { ignoreGhsas: [MARKER] } };
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(attack));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.divergence);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a package.json committed as a symlink, and never prints the planted target", async () => {
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      { mode: "120000", content: `../../evil-package.json ${MARKER}` },
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.entry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a BASE whose package.json is a symlink, even when the merge side is clean", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const baseRepo = join(root, `base-symlink-${counter}`);
    await mkdir(baseRepo, { recursive: true });
    git(baseRepo, "init", "--quiet", "--initial-branch=main");
    await commitFiles(baseRepo, { "README.md": "# scratch\n" }, "root");
    const target = await blobFile(baseRepo, `planted ${MARKER}`);
    git(baseRepo, "update-index", "--add", "--cacheinfo", `120000,${target},package.json`);
    const baseTree = git(baseRepo, "write-tree");
    const symlinkBase = git(baseRepo, "commit-tree", baseTree, "-m", "symlink base");
    const mergeId = await blobFile(baseRepo, BASE_PACKAGE_JSON(config));
    git(baseRepo, "update-index", "--add", "--cacheinfo", `100644,${mergeId},package.json`);
    const mergeTree = git(baseRepo, "write-tree");
    const merge = git(baseRepo, "commit-tree", mergeTree, "-p", symlinkBase, "-m", "merge");
    const result = await runStep({ repo: baseRepo, base: symlinkBase, merge });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.entry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it.each([
    ["mode 100755", "100755"],
    ["a gitlink (mode 160000)", "160000"],
  ])("refuses a package.json committed as %s", async (_label, mode) => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), { mode, content: BASE_PACKAGE_JSON(config) });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.entry);
  });

  it("refuses a merge tree with no package.json at all", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(BASE_PACKAGE_JSON(config), null);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.entry);
  });

  it("refuses a NUL byte anywhere in the file", async () => {
    const content = `{"name":"scratch\u0000${MARKER}","pnpm":{"auditConfig":{"ignoreGhsas":["GHSA-vfj7-8cjw-p6xm"]}}}`;
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), content);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.nul);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a package.json that is not valid UTF-8", async () => {
    counter += 1;
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const repo = join(root, `utf8-${counter}`);
    await mkdir(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    const basePackage = Buffer.from(
      `${JSON.stringify({ name: "scratch", pnpm: config })}\n`,
      "utf8",
    );
    const baseBlobFile = join(root, `blob-utf8-base-${counter}`);
    await writeFile(baseBlobFile, basePackage);
    const baseBlobId = git(repo, "hash-object", "-w", baseBlobFile);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${baseBlobId},package.json`);
    const base = git(repo, "commit-tree", git(repo, "write-tree"), "-m", "base with package.json");
    const raw = Buffer.from(
      `${JSON.stringify({ name: "scratch", pnpm: config })} \xff\xfe\n`,
      "latin1",
    );
    const file = join(root, `blob-utf8-${counter}`);
    await writeFile(file, raw);
    const id = git(repo, "hash-object", "-w", file);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${id},package.json`);
    const merge = git(repo, "commit-tree", git(repo, "write-tree"), "-p", base, "-m", "utf8");
    const result = await runStep({ repo, base, merge });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.utf8);
  });

  it("refuses a package.json that does not parse as JSON", async () => {
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      `{"name": "scratch", "pnpm": { BROKEN\n`,
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.json);
  });

  it("refuses a package.json over the 65536-byte cap", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const padded = `${JSON.stringify({ name: "scratch", description: "x".repeat(70_000), pnpm: config })}\n`;
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), padded);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.size);
  });

  /** Writes `content` as a loose blob in `repo`; returns its object id. */
  async function blobFile(repo: string, content: string): Promise<string> {
    const file = join(root, `blobfile-${counter}`);
    await writeFile(file, content);
    return git(repo, "hash-object", "-w", file);
  }
});
