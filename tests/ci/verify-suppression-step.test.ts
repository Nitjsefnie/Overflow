import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  sharedEntry:
    "::error::pnpm-workspace.yaml and .npmrc must be absent or exactly one mode-100644 blob " +
    "entry in a tree; refusing. These files are read from git objects, never from the " +
    "filesystem — pnpm reads the checkout on disk, where a symlink leaf redirects the read " +
    "outside the tree, so a symlink leaf, a wrong mode and a non-blob type are all refused.",
  sharedSize: "::error::pnpm-workspace.yaml and .npmrc are larger than the 65536-byte cap; refusing",
  sharedNul:
    "::error::pnpm-workspace.yaml and .npmrc carry a NUL byte, which is invalid content " +
    "wherever it sits; refusing",
  sharedUtf8: "::error::pnpm-workspace.yaml and .npmrc are not valid UTF-8; refusing",
  wsParse:
    "::error::pnpm-workspace.yaml does not parse as a mapping of settings; refusing to judge " +
    "the audit-affecting settings without a parse",
  wsModule:
    "::error::python3 has no yaml module; refusing to judge pnpm-workspace.yaml without it — " +
    "the hash-pinned install above provides it, so a missing module means the install failed " +
    "and is a red run, never a silent pass",
  wsDump:
    "::error::pnpm-workspace.yaml carries audit-affecting settings that do not serialize to " +
    "JSON; refusing",
  wsDivergence:
    "::error::this pull request changes audit-affecting settings in pnpm-workspace.yaml; a " +
    "pull request cannot change the audit suppression list — the list moves only through a " +
    "maintainer-reviewed merge",
  npmrcParse:
    "::error::.npmrc carries a line that is neither blank, a comment, nor key=value; refusing " +
    "to judge its audit-affecting keys without a parse",
  npmrcDivergence:
    "::error::this pull request changes audit-affecting keys in .npmrc; a pull request cannot " +
    "change the audit suppression list — the list moves only through a maintainer-reviewed merge",
  manifestMissing:
    "::error::.github/requirements-pyyaml.txt is missing from the base; the workspace gate " +
    "judges pnpm-workspace.yaml with a hash-pinned PyYAML install and refuses without it — the " +
    "manifest moves only through a maintainer-reviewed merge, like the list it installs for",
  manifestEntry:
    "::error::.github/requirements-pyyaml.txt must be exactly one mode-100644 blob entry in " +
    "the base; refusing. The manifest is read from git objects, never from the filesystem — a " +
    "pull request can neither substitute it nor hide it — so a symlink leaf, a wrong mode, a " +
    "non-blob type and an absent file are all refused.",
  manifestSize: "::error::the PyYAML manifest is larger than the 65536-byte cap; refusing",
  manifestNul: "::error::the PyYAML manifest carries a NUL byte, which is invalid content wherever it sits; refusing",
  manifestUtf8: "::error::the PyYAML manifest is not valid UTF-8; refusing",
  manifestNoLine: "::error::the PyYAML manifest carries no requirement line; refusing",
  manifestGrammar: "refused by the pin grammar",
  manifestSecondLine: "the PyYAML manifest carries a second requirement line; exactly one is allowed",
  manifestSanitized:
    "already exists; refusing to write the sanitized pin into a directory this run did not create",
} as const;

/** Planted where a redirected read or a leaked refusal would print it; must never reach output. */
const MARKER = "GHSA-ATTACKER-SUPPRESSION-MARKER";

const BASE_PACKAGE_JSON = (config: unknown): string =>
  `${JSON.stringify({ name: "scratch", version: "0.0.0", pnpm: config }, null, 2)}\n`;

let steps: Step[] = [];
let root = "";
let counter = 0;
let pyyamlManifest = "";

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8")) as {
    jobs: { verify: { steps: Step[] } };
  };
  steps = workflow.jobs.verify.steps;
  root = await mkdtemp(join(tmpdir(), "verify-suppression-step-"));
  pyyamlManifest = await readFile(resolve(".github/requirements-pyyaml.txt"), "utf8");
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
 * ordinary 100644 cases. The base carries the committed PyYAML manifest unless
 * `noManifest` says otherwise — the manifest is what main pins, so the ordinary
 * fixture state is "present on the base".
 */
async function fixture(
  basePackage: string | null,
  mergePackage: string | { mode: string; content: string } | null,
  extra: { base?: Record<string, string>; merge?: Record<string, string> } = {},
  opts: { noManifest?: boolean } = {},
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
  if (!opts.noManifest) files[".github/requirements-pyyaml.txt"] = pyyamlManifest;
  Object.assign(files, extra.base ?? {});
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
  for (const [path, content] of Object.entries(extra.merge ?? {})) {
    const id = await blob(content);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${id},${path}`);
  }
  const tree = git(repo, "write-tree");
  const merge = git(repo, "commit-tree", tree, "-p", base, "-m", "merge case");
  return { repo, base, merge };
}

type StepResult = { status: number | null; stdout: string; stderr: string };

/**
 * A wrapper `pip`, first on PATH: appends its full argv (space-joined) as one
 * line to `PYYAML_PIP_LOG`, then execs the REAL pip — the wrapper exists to
 * record the argv the step pinned and to inject a failure, never to fake the
 * install. The workspace-parse cases therefore exercise the actual
 * hash-gated download and the module it produced, on this interpreter.
 */
const PIP_WRAPPER = [
  "#!/usr/bin/env bash",
  'printf \'%s\\n\' "$*" >> "${PYYAML_PIP_LOG}"',
  "if [ -n \"${PYYAML_PIP_STUB_EXIT:-}\" ]; then",
  '  exit "${PYYAML_PIP_STUB_EXIT}"',
  "fi",
  'exec "$(command -v pip3 || command -v pip)" "$@"',
  "",
].join("\n");

/** Runs the step's real `run:` text the way the runner does. */
async function runStep(
  fx: { repo: string; base: string; merge: string },
  options: { failPip?: boolean } = {},
): Promise<StepResult & { runnerTemp: string; argvLog: string }> {
  counter += 1;
  const runnerTemp = join(root, `runner-temp-${counter}`);
  await mkdir(runnerTemp);
  const stubBin = join(root, `stub-bin-${counter}`);
  await mkdir(stubBin);
  await writeFile(join(stubBin, "pip"), PIP_WRAPPER);
  await chmod(join(stubBin, "pip"), 0o755);
  const argvLog = join(root, `pip-argv-${counter}`);
  await writeFile(argvLog, "");
  const script = join(root, `step-${counter}.sh`);
  await writeFile(script, theStep().run ?? "exit 99\n");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: fx.repo,
    encoding: "utf8",
    env: {
      ...scratchGitEnv,
      BASE_SHA: fx.base,
      MERGE_SHA: fx.merge,
      RUNNER_TEMP: runnerTemp,
      PYYAML_PIP_LOG: argvLog,
      ...(options.failPip ? { PYYAML_PIP_STUB_EXIT: "1" } : {}),
      PATH: `${stubBin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, runnerTemp, argvLog };
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
    // The workspace parse needs PyYAML, which the runner image does not ship:
    // the step installs it from the BASE's hash-pinned manifest — the zizmor
    // manifest's discipline (base-defined via git objects, --require-hashes,
    // a sanitized copy under RUNNER_TEMP). The exact install shape is pinned;
    // anything else pip-shaped must be added here deliberately.
    expect(step.run, "the step installs PyYAML from a hash-pinned manifest").toContain(
      "pip install --no-deps --require-hashes --disable-pip-version-check",
    );
    expect(step.run, "the install targets a fresh RUNNER_TEMP site").toContain(
      '--target "${sanitized}/site" -r "${sanitized}/requirements.txt"',
    );
    expect(step.run, "the manifest is read from the base side").toContain(
      'install_pyyaml "${BASE_SHA:?}"',
    );
    expect(step.run, "no pip download — the hash-gated install is the only channel").not.toContain(
      "pip download",
    );
    expect(step.run, "the step must not run a package manager").not.toMatch(
      /\b(pnpm|npm|npx|yarn|corepack)\s+(audit|install|ci|i|add|update|remove|run|exec|dlx|config)\b/,
    );
    // The workspace and .npmrc files are the two channels the adversary proved
    // (issue 1035 fix round 3): pnpm 10.33.0 reads auditConfig, auditLevel and
    // the registries mapping from pnpm-workspace.yaml, and audit-level,
    // registry, strict-ssl, cafile, proxy and https-proxy from .npmrc. The step
    // must name both files and project both projections' settings.
    expect(step.run, "the step must read the workspace file's audit-affecting settings").toContain(
      "pnpm-workspace.yaml",
    );
    expect(step.run, "the step must read .npmrc's audit-affecting keys").toContain(".npmrc");
    expect(step.run, "the projection must name the measured workspace settings").toMatch(
      /"auditConfig", "auditLevel", "registries"/,
    );
    expect(step.run, "the projection must name the measured .npmrc keys").toMatch(
      /"audit-level", "registry", "strict-ssl", "cafile", "proxy", "https-proxy"/,
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
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
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
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("passes when neither side carries an audit suppression list", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
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

  // ---------------------------------------------------------------------------
  // The workspace and .npmrc comparisons (issue 1035, fix round 3). pnpm
  // 10.33.0 reads audit-affecting settings from pnpm-workspace.yaml
  // (auditConfig, auditLevel and the registries mapping — all measured with a
  // real advisory carrying github_advisory_id) and from .npmrc (audit-level,
  // registry, strict-ssl, cafile, proxy, https-proxy). Absence of a file is
  // legitimate: absent compares equal to a file carrying none of the audited
  // keys. Every refusal below is one of the fixed constants, and no case's
  // planted marker may reach the step's output.
  // ---------------------------------------------------------------------------

  it("passes when pnpm-workspace.yaml is byte-identical on both sides", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const ws = "auditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\npackages:\n  - \"x\"\n";
    const fx = await fixture(BASE_PACKAGE_JSON(config), BASE_PACKAGE_JSON(config), {
      base: { "pnpm-workspace.yaml": ws },
      merge: { "pnpm-workspace.yaml": ws },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("passes when the merge adds pnpm-workspace.yaml carrying no audit-affecting setting", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { "pnpm-workspace.yaml": "packages:\n  - \"a\"\n  - \"b\"\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it.each([
    ["a packages entry added", "packages:\n  - \"x\"\n", "packages:\n  - \"x\"\n  - \"y\"\n"],
    [
      "patchedDependencies added",
      "packages:\n  - \"x\"\n",
      "packages:\n  - \"x\"\npatchedDependencies:\n  postgres@3.4.9: patches/postgres@3.4.9.patch\n",
    ],
    [
      "a comment and whitespace moved",
      "packages:\n  - \"x\"\n",
      "# where the packages live\npackages:\n    - \"x\"\n",
    ],
  ])("passes a benign pnpm-workspace.yaml change: %s", async (_label, base, merge) => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      base: { "pnpm-workspace.yaml": base },
      merge: { "pnpm-workspace.yaml": merge },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("refuses a suppression list moved into pnpm-workspace.yaml", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: {
        "pnpm-workspace.yaml": `auditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n    - ${MARKER}\n`,
      },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
    expect(`${result.stdout}${result.stderr}`, "no pull-request bytes may reach the log").not.toContain(
      MARKER,
    );
  });

  it("refuses an auditLevel moved into pnpm-workspace.yaml", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { "pnpm-workspace.yaml": "auditLevel: critical\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
  });

  it("refuses a registries mapping moved into pnpm-workspace.yaml", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { "pnpm-workspace.yaml": "registries:\n  default: https://attacker.invalid/\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
  });

  it("refuses a suppression list added to pnpm-workspace.yaml that the base lacks", async () => {
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      BASE_PACKAGE_JSON(undefined),
      {
        base: { "pnpm-workspace.yaml": "packages:\n  - \"x\"\n" },
        merge: {
          "pnpm-workspace.yaml": "packages:\n  - \"x\"\nauditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n",
        },
      },
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
  });

  it("refuses an unparseable pnpm-workspace.yaml whose bytes differ from the base", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      base: { "pnpm-workspace.yaml": "packages:\n  - \"x\"\n" },
      merge: { "pnpm-workspace.yaml": "auditConfig:\n\tignoreGhsas: [oops\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsParse);
  });

  it("refuses pnpm-workspace.yaml committed as a symlink, and never prints the target", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: {},
    });
    // Swap the merge-side workspace entry for a 120000 symlink leaf via the
    // same index surgery the fixture uses for package.json.
    const id = await blobFile(fx.repo, `../../evil-workspace.yaml ${MARKER}`);
    git(fx.repo, "update-index", "--add", "--cacheinfo", `120000,${id},pnpm-workspace.yaml`);
    const tree = git(fx.repo, "write-tree");
    const merge = git(fx.repo, "commit-tree", tree, "-p", fx.base, "-m", "ws symlink");
    const result = await runStep({ repo: fx.repo, base: fx.base, merge });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.sharedEntry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it.each([
    ["a NUL byte", "nul"],
    ["invalid UTF-8", "utf8"],
    ["an oversize body", "size"],
  ])("refuses %s in pnpm-workspace.yaml", async (label, kind) => {
    counter += 1;
    const repo = join(root, `ws-${kind}-${counter}`);
    await mkdir(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    // A benign package.json on both sides: the guard checks it first, and an
    // absent one would refuse before the workspace file is ever read.
    const base = await commitFiles(
      repo,
      {
        "README.md": "# scratch\n",
        "package.json": `${JSON.stringify({ name: "scratch" })}\n`,
        ".github/requirements-pyyaml.txt": pyyamlManifest,
      },
      "base",
    );
    let raw: Buffer;
    if (kind === "nul") {
      raw = Buffer.from(`auditConfig:\n  ignoreGhsas:\n    - a\u0000${MARKER}\n`, "utf8");
    } else if (kind === "utf8") {
      raw = Buffer.from(`auditConfig:\n  ignoreGhsas:\n    - ok\njunk: \xff\xfe\n`, "latin1");
    } else {
      raw = Buffer.from(`packages:\n  - ${"\"x".repeat(40_000)}\n`, "utf8");
    }
    const file = join(root, `ws-${kind}-blob-${counter}`);
    await writeFile(file, raw);
    const id = git(repo, "hash-object", "-w", file);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${id},pnpm-workspace.yaml`);
    const tree = git(repo, "write-tree");
    const merge = git(repo, "commit-tree", tree, "-p", base, "-m", `ws ${label}`);
    const result = await runStep({ repo, base, merge });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain(
      kind === "nul" ? REFUSALS.sharedNul : kind === "utf8" ? REFUSALS.sharedUtf8 : REFUSALS.sharedSize,
    );
    expect(output).not.toContain(MARKER);
  });

  it("passes when .npmrc is byte-identical on both sides", async () => {
    const npmrc = "registry=http://127.0.0.1:4873/\nsave-exact=true\n";
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      base: { ".npmrc": npmrc },
      merge: { ".npmrc": npmrc },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("passes when the merge adds .npmrc carrying none of the audited keys", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { ".npmrc": "save-exact=true\nfund=false\n# a comment\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("refuses an audit-level bar added in .npmrc", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { ".npmrc": `audit-level=critical ${MARKER}\n` },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcDivergence);
    expect(`${result.stdout}${result.stderr}`, "no pull-request bytes may reach the log").not.toContain(
      MARKER,
    );
  });

  it("refuses a registry redirect changed in .npmrc", async () => {
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      BASE_PACKAGE_JSON(undefined),
      {
        base: { ".npmrc": "registry=https://registry.npmjs.org/\n" },
        merge: { ".npmrc": `registry=https://${MARKER}.invalid/\n` },
      },
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcDivergence);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses strict-ssl, cafile or a proxy added in .npmrc", async () => {
    for (const line of ["strict-ssl=false", "cafile=/etc/attacker.pem", "https-proxy=http://127.0.0.1:1"]) {
      const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
        merge: { ".npmrc": `${line}\n` },
      });
      const result = await runStep(fx);
      expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcDivergence);
    }
  });

  it("passes when .npmrc carries only a scoped registry key", async () => {
    // Measured on pnpm 10.33.0 (probe leg n4b, real advisory with
    // github_advisory_id): the audit's advisory POST goes to the DEFAULT
    // registry; @scope:registry does not redirect it. The allowlist therefore
    // excludes scoped keys, and this case pins that exclusion.
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { ".npmrc": "@attk:registry=https://attacker.invalid/\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("refuses an unparseable .npmrc whose bytes differ from the base", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      base: { ".npmrc": "save-exact=true\n" },
      merge: { ".npmrc": "save-exact=true\n[attacker]\nregistry=x\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcParse);
  });

  it("refuses .npmrc committed as a symlink", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: {},
    });
    const id = await blobFile(fx.repo, `../../evil-npmrc ${MARKER}`);
    git(fx.repo, "update-index", "--add", "--cacheinfo", `120000,${id},.npmrc`);
    const tree = git(fx.repo, "write-tree");
    const merge = git(fx.repo, "commit-tree", tree, "-p", fx.base, "-m", "npmrc symlink");
    const result = await runStep({ repo: fx.repo, base: fx.base, merge });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.sharedEntry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it.each([
    ["a NUL byte", "nul"],
    ["invalid UTF-8", "utf8"],
    ["an oversize body", "size"],
  ])("refuses %s in .npmrc", async (label, kind) => {
    counter += 1;
    const repo = join(root, `npmrc-${kind}-${counter}`);
    await mkdir(repo, { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    const base = await commitFiles(
      repo,
      { "README.md": "# scratch\n", "package.json": `${JSON.stringify({ name: "scratch" })}\n` },
      "base",
    );
    let raw: Buffer;
    if (kind === "nul") {
      raw = Buffer.from(`registry=http://127.0.0.1\u0000${MARKER}/\n`, "utf8");
    } else if (kind === "utf8") {
      raw = Buffer.from(`registry=http://ok/\njunk: \xff\xfe\n`, "latin1");
    } else {
      raw = Buffer.from(`# pad\n${"x".repeat(70_000)}\n`, "utf8");
    }
    const file = join(root, `npmrc-${kind}-blob-${counter}`);
    await writeFile(file, raw);
    const id = git(repo, "hash-object", "-w", file);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${id},.npmrc`);
    const tree = git(repo, "write-tree");
    const merge = git(repo, "commit-tree", tree, "-p", base, "-m", `npmrc ${label}`);
    const result = await runStep({ repo, base, merge });
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain(
      kind === "nul" ? REFUSALS.sharedNul : kind === "utf8" ? REFUSALS.sharedUtf8 : REFUSALS.sharedSize,
    );
    expect(output).not.toContain(MARKER);
  });

  it("matches .npmrc keys case-insensitively", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      merge: { ".npmrc": "Audit-Level=critical\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcDivergence);
  });

  it("refuses a base that lacks the PyYAML manifest when the workspace file changed", async () => {
    // The manifest is what main pins; until this lands on main every
    // workspace-changing pull request reds here rather than judging with an
    // unpinned module.
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      BASE_PACKAGE_JSON(undefined),
      {
        base: { "pnpm-workspace.yaml": "packages:\n  - \"a\"\n" },
        merge: { "pnpm-workspace.yaml": "packages:\n  - \"b\"\n" },
      },
      { noManifest: true },
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.manifestMissing);
  });

  it("refuses a PyYAML manifest committed as a symlink on the base", async () => {
    const baseRepo = join(root, `manifest-symlink-${counter}`);
    await mkdir(baseRepo, { recursive: true });
    git(baseRepo, "init", "--quiet", "--initial-branch=main");
    await commitFiles(
      baseRepo,
      {
        "README.md": "# scratch\n",
        "package.json": `${JSON.stringify({ name: "scratch" })}\n`,
        "pnpm-workspace.yaml": "packages:\n  - \"a\"\n",
      },
      "root",
    );
    const base = git(baseRepo, "rev-parse", "HEAD");
    const target = await blobFile(baseRepo, `planted ${MARKER}`);
    git(baseRepo, "update-index", "--add", "--cacheinfo", `120000,${target},.github/requirements-pyyaml.txt`);
    const baseTree = git(baseRepo, "write-tree");
    const symlinkBase = git(baseRepo, "commit-tree", baseTree, "-m", "symlink manifest");
    const mergeId = await blobFile(baseRepo, "packages:\n  - \"b\"\n");
    git(baseRepo, "update-index", "--add", "--cacheinfo", `100644,${mergeId},pnpm-workspace.yaml`);
    const mergeTree = git(baseRepo, "write-tree");
    const merge = git(baseRepo, "commit-tree", mergeTree, "-p", symlinkBase, "-m", "merge");
    const result = await runStep({ repo: baseRepo, base: symlinkBase, merge });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.manifestEntry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it.each([
    ["a pin that is not pyyaml", "yaml==6.0.3"],
    ["a comparison operator that is not ==", "pyyaml!=6.0.3"],
    [
      "a stray second requirement line",
      `pyyaml==6.0.3 --hash=sha256:${"a".repeat(64)}\npyyaml==6.0.2 --hash=sha256:${"b".repeat(64)}`,
    ],
  ])("refuses %s in the PyYAML manifest by the pin grammar", async (_label, pinLine) => {
    // The fixture's base manifest is the committed pin; the extra.base entry
    // overrides it with the broken content the grammar gate must refuse.
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      BASE_PACKAGE_JSON(undefined),
      {
        base: { ".github/requirements-pyyaml.txt": pinLine },
        merge: { "pnpm-workspace.yaml": "packages:\n  - \"b\"\n" },
      },
    );
    const result = await runStep(fx);
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    if (pinLine.includes("\n")) {
      expect(output).toContain(REFUSALS.manifestSecondLine);
    } else {
      expect(output).toContain(REFUSALS.manifestGrammar);
    }
  });

  it("fails closed when the hash-pinned install itself fails", async () => {
    const fx = await fixture(BASE_PACKAGE_JSON(undefined), BASE_PACKAGE_JSON(undefined), {
      base: { "pnpm-workspace.yaml": "packages:\n  - \"a\"\n" },
      merge: { "pnpm-workspace.yaml": "packages:\n  - \"b\"\n" },
    });
    const result = await runStep(fx, { failPip: true });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
  });

  it("installs PyYAML with the pinned argv from the sanitized copy, and passes a benign workspace change on the real module", async () => {
    // The runner proof, executed here: the step installs the hash-pinned
    // wheel through the wrapper (which forwards to the real pip — the log
    // records the argv, the install is real), and the workspace parse then
    // runs against the module the install produced. ubuntu-latest's python
    // is the interpreter this case exercises.
    const fx = await fixture(
      BASE_PACKAGE_JSON(undefined),
      BASE_PACKAGE_JSON(undefined),
      {
        base: {
          "pnpm-workspace.yaml": "packages:\n  - \"a\"\nauditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n",
        },
        merge: {
          // Formatting differs, so the blob ids differ and the parse runs;
          // the audit-affecting settings are identical, so the step passes.
          "pnpm-workspace.yaml": "packages: [\"a\"]\nauditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n",
        },
      },
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");

    const invocations = (await readFile(result.argvLog, "utf8")).split("\n").filter((line) => line !== "");
    expect(invocations, "exactly one pip invocation").toHaveLength(1);
    const argv = invocations[0]!.split(" ");
    expect(argv.slice(0, 5)).toEqual(["install", "--no-deps", "--require-hashes", "--disable-pip-version-check", "--no-input"]);
    expect(argv).toContain("--retries");
    expect(argv).toContain("--timeout");
    expect(argv).toContain("--target");
    expect(argv.filter((token) => token === "--require-hashes")).toHaveLength(1);
    const targetIndex = argv.indexOf("--target");
    expect(argv[targetIndex + 1], "the install site lives under this run's RUNNER_TEMP").toContain(
      result.runnerTemp,
    );
    // The sanitized copy pip was handed is exactly the committed pin line.
    const requirementsIndex = argv.indexOf("-r");
    const sanitized = await readFile(argv[requirementsIndex + 1]!, "utf8");
    expect(sanitized).toBe(
      `${(await readFile(resolve(".github/requirements-pyyaml.txt"), "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#"))
        .join("\n")}\n`,
    );
    // The site the parse imported from carries the module.
    const site = argv[targetIndex + 1]!;
    const imported = spawnSync(
      "python3",
      ["-c", "import yaml, sys; sys.stdout.write(yaml.__version__)"],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: site } },
    );
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout, "the installed module reports its version").toMatch(/^\d+\.\d+/);
  });

  /** Writes `content` as a loose blob in `repo`; returns its object id. */
  async function blobFile(repo: string, content: string): Promise<string> {
    const file = join(root, `blobfile-${counter}`);
    await writeFile(file, content);
    return git(repo, "hash-object", "-w", file);
  }
});
