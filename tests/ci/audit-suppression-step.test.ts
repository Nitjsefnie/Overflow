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

/** Planted in pull-request-controlled content; must never reach the step's output. */
const MARKER = "GHSA-ATTACKER-SUPPRESSION-MARKER";

const PACKAGE_JSON = (config: unknown): string =>
  `${JSON.stringify({ name: "scratch", version: "0.0.0", pnpm: config }, null, 2)}\n`;

let steps: Step[] = [];
let root = "";
let counter = 0;
let pyyamlManifest = "";

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/dependency-audit.yml"), "utf8")) as {
    jobs: { audit: { steps: Step[] } };
  };
  steps = workflow.jobs.audit.steps;
  root = await mkdtemp(join(tmpdir(), "audit-suppression-step-"));
  pyyamlManifest = await readFile(resolve(".github/requirements-pyyaml.txt"), "utf8");
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
    // The workspace parse needs PyYAML, which the runner image does not ship:
    // the leg installs it from the FETCHED base's hash-pinned manifest — the
    // zizmor manifest's discipline. The exact install shape is pinned.
    expect(run, "the leg installs PyYAML from a hash-pinned manifest").toContain(
      "pip install --no-deps --require-hashes --disable-pip-version-check",
    );
    expect(run, "the install targets a fresh RUNNER_TEMP site").toContain(
      '--target "${sanitized}/site" -r "${sanitized}/requirements.txt"',
    );
    expect(run, "the manifest is read from the fetched base").toContain(
      "install_pyyaml FETCH_HEAD",
    );
    expect(run, "no pip download — the hash-gated install is the only channel").not.toContain(
      "pip download",
    );
    // Fix round 3: the same workspace and .npmrc comparisons the load-bearing
    // guard in ci-pr.yml implements. pnpm 10.33.0 reads auditConfig,
    // auditLevel and the registries mapping from pnpm-workspace.yaml (all
    // measured with a real advisory carrying github_advisory_id), and
    // audit-level, registry, strict-ssl, cafile, proxy and https-proxy from
    // .npmrc — so the audit must refuse to run on a divergent one.
    expect(run, "the leg must read the workspace file's audit-affecting settings").toContain(
      "pnpm-workspace.yaml",
    );
    expect(run, "the leg must read .npmrc's audit-affecting keys").toContain(".npmrc");
    expect(run, "the projection must name the measured workspace settings").toMatch(
      /"auditConfig", "auditLevel", "registries"/,
    );
    expect(run, "the projection must name the measured .npmrc keys").toMatch(
      /"audit-level", "registry", "strict-ssl", "cafile", "proxy", "https-proxy"/,
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
    extra: { base?: Record<string, string>; merge?: Record<string, string> } = {},
    opts: { noManifest?: boolean } = {},
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
    if (!opts.noManifest) {
      const manifestId = await writeBlob(origin, pyyamlManifest);
      g(origin, "update-index", "--add", "--cacheinfo", `100644,${manifestId},.github/requirements-pyyaml.txt`);
    }
    for (const [path, content] of Object.entries(extra.base ?? {})) {
      const id = await writeBlob(origin, content);
      g(origin, "update-index", "--add", "--cacheinfo", `100644,${id},${path}`);
    }
    g(origin, "commit", "--quiet", "-m", "base");
    const base = g(origin, "rev-parse", "HEAD");

    if (typeof mergePackage === "string") {
      const id = await writeBlob(origin, mergePackage);
      g(origin, "update-index", "--add", "--cacheinfo", `100644,${id},package.json`);
    } else {
      const id = await writeBlob(origin, mergePackage.content);
      g(origin, "update-index", "--add", "--cacheinfo", `${mergePackage.mode},${id},package.json`);
    }
    for (const [path, content] of Object.entries(extra.merge ?? {})) {
      const id = await writeBlob(origin, content);
      g(origin, "update-index", "--add", "--cacheinfo", `100644,${id},${path}`);
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

  /**
   * The pip wrapper (see the sibling suite): logs the argv, then execs the
   * real pip — the install is real, the log pins the argv.
   */
  const PIP_WRAPPER = [
    "#!/usr/bin/env bash",
    "printf '%s\\n' \"$*\" >> \"${PYYAML_PIP_LOG}\"",
    "if [ -n \"${PYYAML_PIP_STUB_EXIT:-}\" ]; then",
    "  exit \"${PYYAML_PIP_STUB_EXIT}\"",
    "fi",
    "exec \"$(command -v pip3 || command -v pip)\" \"$@\"",
    "",
  ].join("\n");

  async function runStep(
    fx: { workspace: string; base: string },
    overrides: { baseSha?: string; failPip?: boolean } = {},
  ): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    runnerTemp: string;
    argvLog: string;
  }> {
    counter += 1;
    const runnerTemp = join(root, `runner-temp-${counter}`);
    await mkdir(runnerTemp);
    const stubBin = join(root, `stub-bin-${counter}`);
    await mkdir(stubBin);
    const pipScript = join(stubBin, "pip");
    await writeFile(pipScript, PIP_WRAPPER);
    const chmodResult = spawnSync("chmod", ["0755", pipScript]);
    if (chmodResult.status !== 0) throw new Error("chmod the pip wrapper failed");
    const argvLog = join(root, `pip-argv-${counter}`);
    await writeFile(argvLog, "");
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
        RUNNER_TEMP: runnerTemp,
        PYYAML_PIP_LOG: argvLog,
        ...(overrides.failPip ? { PYYAML_PIP_STUB_EXIT: "1" } : {}),
        PATH: `${stubBin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, runnerTemp, argvLog };
  }

  it("passes when the merge tree repeats the base's suppression list exactly", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config));
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
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

  // ---------------------------------------------------------------------------
  // The workspace and .npmrc comparisons (issue 1035, fix round 3), mirrored
  // from the load-bearing guard so both layers implement the same comparison.
  // The keys named here are the MEASURED audit-affecting sets on pnpm 10.33.0,
  // every leg carrying a real advisory with its github_advisory_id:
  // pnpm-workspace.yaml auditConfig (suppresses), auditLevel (filters below
  // the bar) and registries (the mapping BEATS the job's npm_config_registry
  // pin, so it redirects the advisory endpoint); .npmrc audit-level, registry,
  // strict-ssl, cafile, proxy and https-proxy. Absence compares equal to a
  // file carrying none of the audited keys; every refusal is a fixed constant.
  // ---------------------------------------------------------------------------

  it("passes when pnpm-workspace.yaml is byte-identical on both sides", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const ws = "auditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\npackages:\n  - \"x\"\n";
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config), {
      base: { "pnpm-workspace.yaml": ws },
      merge: { "pnpm-workspace.yaml": ws },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it.each([
    ["a packages entry added", "packages:\n  - \"x\"\n", "packages:\n  - \"x\"\n  - \"y\"\n"],
    [
      "a comment and whitespace moved",
      "packages:\n  - \"x\"\n",
      "# where the packages live\npackages:\n    - \"x\"\n",
    ],
  ])("passes a benign pnpm-workspace.yaml change: %s", async (_label, base, merge) => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      base: { "pnpm-workspace.yaml": base },
      merge: { "pnpm-workspace.yaml": merge },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("refuses a suppression list moved into pnpm-workspace.yaml", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      merge: {
        "pnpm-workspace.yaml": `auditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n    - ${MARKER}\n`,
      },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses an auditLevel moved into pnpm-workspace.yaml", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      merge: { "pnpm-workspace.yaml": "auditLevel: critical\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
  });

  it("refuses a registries mapping moved into pnpm-workspace.yaml", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      merge: { "pnpm-workspace.yaml": "registries:\n  default: https://attacker.invalid/\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsDivergence);
  });

  it("refuses an unparseable pnpm-workspace.yaml whose bytes differ from the base", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      base: { "pnpm-workspace.yaml": "packages:\n  - \"x\"\n" },
      merge: { "pnpm-workspace.yaml": "auditConfig:\n\tignoreGhsas: [oops\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.wsParse);
  });

  it("refuses pnpm-workspace.yaml committed as a symlink", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config));
    const target = await writeBlobNow(fx.workspace, `../../evil-workspace.yaml ${MARKER}`);
    const g = (args: string[]): string => {
      const result = spawnSync("git", args, { cwd: fx.workspace, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    g(["update-index", "--add", "--cacheinfo", `120000,${target},pnpm-workspace.yaml`]);
    const tree = g(["write-tree"]);
    // The workspace clone is shallow (depth 1 at the merge), so the base commit
    // object must be fetched before it can parent a new commit.
    g(["fetch", "--depth=1", "origin", fx.base]);
    const merge = g(["commit-tree", tree, "-p", fx.base, "-m", "ws symlink"]);
    // The merge commit was built locally in the workspace, so it is checked
    // out directly; only the guard's own base fetch goes through origin.
    g(["checkout", "--detach", merge]);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.sharedEntry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("passes when .npmrc is byte-identical on both sides", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const npmrc = "registry=http://127.0.0.1:4873/\nsave-exact=true\n";
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config), {
      base: { ".npmrc": npmrc },
      merge: { ".npmrc": npmrc },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("passes when the merge adds .npmrc carrying none of the audited keys", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      merge: { ".npmrc": "save-exact=true\nfund=false\n# a comment\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("refuses an audit-level bar added in .npmrc", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      merge: { ".npmrc": `audit-level=critical ${MARKER}\n` },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcDivergence);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("refuses a registry redirect changed in .npmrc", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      base: { ".npmrc": "registry=https://registry.npmjs.org/\n" },
      merge: { ".npmrc": `registry=https://${MARKER}.invalid/\n` },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcDivergence);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  it("passes when .npmrc carries only a scoped registry key", async () => {
    // Measured on pnpm 10.33.0 (probe leg n4b): the audit's advisory POST goes
    // to the default registry; @scope:registry does not redirect it, so the
    // allowlist excludes scoped keys and this case pins that exclusion.
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      merge: { ".npmrc": "@attk:registry=https://attacker.invalid/\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");
    expect(`${result.stdout}${result.stderr}`, "and raises no workflow-command annotation").not.toContain("::error::");
  });

  it("refuses an unparseable .npmrc whose bytes differ from the base", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      base: { ".npmrc": "save-exact=true\n" },
      merge: { ".npmrc": "save-exact=true\n[attacker]\nregistry=x\n" },
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.npmrcParse);
  });

  it("refuses .npmrc committed as a symlink", async () => {
    const config = { auditConfig: { ignoreGhsas: ["GHSA-vfj7-8cjw-p6xm"] } };
    const fx = await fixture(PACKAGE_JSON(config), PACKAGE_JSON(config));
    const target = await writeBlobNow(fx.workspace, `../../evil-npmrc ${MARKER}`);
    const g = (args: string[]): string => {
      const result = spawnSync("git", args, { cwd: fx.workspace, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    g(["update-index", "--add", "--cacheinfo", `120000,${target},.npmrc`]);
    const tree = g(["write-tree"]);
    g(["fetch", "--depth=1", "origin", fx.base]);
    const merge = g(["commit-tree", tree, "-p", fx.base, "-m", "npmrc symlink"]);
    // The merge commit was built locally in the workspace, so it is checked
    // out directly; only the guard's own base fetch goes through origin.
    g(["checkout", "--detach", merge]);
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(REFUSALS.sharedEntry);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
  });

  /**
   * Writes `content` as a loose blob in the given repository; returns its
   * object id. (Module-scope helper for the symlink cases above, which add
   * index surgery on top of an existing fixture.)
   */
  async function writeBlobNow(repo: string, content: string): Promise<string> {
    counter += 1;
    const file = join(root, `blob-${counter}`);
    await writeFile(file, content);
    const result = spawnSync("git", ["hash-object", "-w", file], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    });
    if (result.status !== 0) throw new Error(`git hash-object: ${result.stderr}`);
    return result.stdout.trim();
  }

  /**
   * The two layers must implement the SAME comparison. Extracts the three
   * inline python pre-parse blocks and the fixed refusal constants from this
   * file's guard and from ci-pr.yml's guard and asserts byte-identity (the
   * only permitted differences are the SHA sources and the base fetch, which
   * the two trust domains require).
   */
  it("refuses a base that lacks the PyYAML manifest when the workspace file changed", async () => {
    // The manifest is what main pins; until this lands on main every
    // workspace-changing pull request reds here rather than judging with an
    // unpinned module.
    const fx = await fixture(
      PACKAGE_JSON(undefined),
      PACKAGE_JSON(undefined),
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

  it("fails closed when the hash-pinned install itself fails", async () => {
    const fx = await fixture(PACKAGE_JSON(undefined), PACKAGE_JSON(undefined), {
      base: { "pnpm-workspace.yaml": "packages:\n  - \"a\"\n" },
      merge: { "pnpm-workspace.yaml": "packages:\n  - \"b\"\n" },
    });
    const result = await runStep(fx, { failPip: true });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
  });

  it("installs PyYAML from the fetched base's manifest and passes a benign workspace change on the real module", async () => {
    // The runner proof, executed here: the step installs the hash-pinned
    // wheel through the wrapper (which forwards to the real pip — the log
    // records the argv, the install is real), and the workspace parse then
    // runs against the module the install produced, from the FETCHED base's
    // manifest.
    const fx = await fixture(
      PACKAGE_JSON(undefined),
      PACKAGE_JSON(undefined),
      {
        base: {
          "pnpm-workspace.yaml": "packages:\n  - \"a\"\nauditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n",
        },
        merge: {
          "pnpm-workspace.yaml": "packages: [\"a\"]\nauditConfig:\n  ignoreGhsas:\n    - GHSA-vfj7-8cjw-p6xm\n",
        },
      },
    );
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout, "the silent success prints nothing on stdout").toBe("");

    const invocations = (await readFile(result.argvLog, "utf8")).split("\n").filter((line) => line !== "");
    expect(invocations, "exactly one pip invocation").toHaveLength(1);
    const argv = invocations[0]!.split(" ");
    expect(argv.slice(0, 5)).toEqual([
      "install",
      "--no-deps",
      "--require-hashes",
      "--disable-pip-version-check",
      "--no-input",
    ]);
    expect(argv).toContain("--target");
    const targetIndex = argv.indexOf("--target");
    expect(argv[targetIndex + 1], "the install site lives under this run's RUNNER_TEMP").toContain(
      result.runnerTemp,
    );
    const requirementsIndex = argv.indexOf("-r");
    const sanitized = await readFile(argv[requirementsIndex + 1]!, "utf8");
    expect(sanitized).toBe(
      `${(await readFile(resolve(".github/requirements-pyyaml.txt"), "utf8"))
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.startsWith("#"))
        .join("\n")}\n`,
    );
    const site = argv[targetIndex + 1]!;
    const imported = spawnSync(
      "python3",
      ["-c", "import yaml, sys; sys.stdout.write(yaml.__version__)"],
      { encoding: "utf8", env: { ...process.env, PYTHONPATH: site } },
    );
    expect(imported.status, imported.stderr).toBe(0);
    expect(imported.stdout, "the installed module reports its version").toMatch(/^\d+\.\d+/);
  });

  it("implements the same comparison as the load-bearing guard in ci-pr.yml", async () => {
    const loadBearing = parse(await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8")) as {
      jobs: { verify: { steps: Step[] } };
    };
    const theirStep = loadBearing.jobs.verify.steps.find((step) => step.name === STEP_NAME);
    expect(theirStep, "ci-pr.yml carries the load-bearing guard").toBeTruthy();
    const mine = theStep().run ?? "";
    const theirs = theirStep?.run ?? "";

    // Every fixed refusal constant is identical across the two layers, with
    // the one documented asymmetry: this advisory leg fetches its base by SHA
    // and so carries the fetch refusal, which the ci-pr leg (whose base is
    // materialised by an earlier step) does not.
    const constantsOf = (run: string): string[] =>
      run.split("\n").filter((line) => line.includes("::error::")).map((line) => line.trim());
    expect(constantsOf(theirs).sort()).toEqual(
      constantsOf(mine).filter((line) => !line.includes(REFUSALS.fetch)).sort(),
    );

    // The three inline python pre-parse blocks are byte-identical.
    for (const variable of ["pre_parse", "ws_pre_parse", "npmrc_pre_parse", "pyyaml_manifest_pre_parse"]) {
      const blockOf = (run: string): string => {
        const start = run.indexOf(`${variable}=$(cat <<'PY'`);
        expect(start, `${variable} exists in the guard`).toBeGreaterThanOrEqual(0);
        const end = run.indexOf("\nPY\n", start);
        expect(end, `${variable} heredoc terminates`).toBeGreaterThan(start);
        return run.slice(start, end);
      };
      expect(blockOf(theirs), `${variable} is byte-identical across the two guards`).toBe(
        blockOf(mine),
      );
    }

    // The comparison tail matches once the two trust domains' SHA sources are
    // normalised: the advisory leg reads FETCH_HEAD/HEAD where the ci-pr leg
    // reads the event's SHAs through env.
    const tailOf = (run: string): string =>
      run.slice(run.indexOf("base_blob="))
        .replaceAll("blob_of FETCH_HEAD", `blob_of "\${BASE_SHA:?}"`)
        .replaceAll("optional_entry_of FETCH_HEAD", `optional_entry_of "\${BASE_SHA:?}"`)
        .replaceAll("install_pyyaml FETCH_HEAD", `install_pyyaml "\${BASE_SHA:?}"`)
        .replaceAll("blob_of HEAD", `blob_of "\${MERGE_SHA:?}"`)
        .replaceAll("optional_entry_of HEAD", `optional_entry_of "\${MERGE_SHA:?}"`);
    expect(tailOf(theirs), "the comparison tail is the same logic").toBe(tailOf(mine));
  });
});
