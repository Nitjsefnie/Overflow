import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv } from "../support/scratch-git";

/**
 * Issue 1099: the base-defined zizmor manifest gate, EXECUTED rather than read.
 *
 * pr-suite.yml's own pin check runs under `pull_request` — the pull request's
 * own definition — so a pull request can delete the check its manifest is
 * subject to. ci-pr.yml's verify job therefore carries the same gate as a
 * BASE-defined step: it reads the pull request's
 * `.github/requirements-zizmor.txt` from GIT OBJECTS of the materialised merge
 * commit, never from the filesystem, so neither a symlinked leaf nor a
 * symlinked `.github` parent can redirect the read; pre-parses it with a strict
 * grammar into a fresh sanitized copy under RUNNER_TEMP; and lets pip resolve
 * only that copy with `--require-hashes`.
 *
 * Every case below builds a scratch repository holding the merge commit under
 * test and executes the step's real `run:` text the way the runner does — bash
 * with the runner's flags, env resolved from the case, cwd the repository that
 * holds the objects. There is NO NETWORK: `pip` is a stub, first on PATH, that
 * records its argv and exits 0 (or an injected non-zero, for the case where
 * pip itself must fail the step).
 */

type Step = {
  name?: string;
  id?: string;
  run?: string;
  env?: Record<string, string>;
  if?: unknown;
  "continue-on-error"?: unknown;
};

const STEP_NAME = "Verify the zizmor pin's hashes match its version";
const MANIFEST_PATH = ".github/requirements-zizmor.txt";
const SANITIZED_DIR = "zizmor-manifest-check";

/** Planted where a redirected read would land; must never reach the step's output. */
const MARKER = "zizmor==9.9.9 --hash=sha256:" + "b".repeat(64) + " # planted redirect target";

let steps: Step[] = [];
let root = "";
let counter = 0;

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8")) as {
    jobs: { verify: { steps: Step[] } };
  };
  steps = workflow.jobs.verify.steps;
  root = await mkdtemp(join(tmpdir(), "verify-zizmor-step-"));
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
 * A scratch repository holding a base commit plus one "merge" commit whose tree
 * carries `.github/requirements-zizmor.txt` exactly as `manifest` describes.
 * Returns { repo, merge } — `merge` is the value MERGE_SHA receives.
 *
 * The manifest path is shaped by INDEX SURGERY over plumbing, uniformly for
 * every case: blobs via `hash-object -w`, entries via
 * `update-index --cacheinfo`, the tree via `write-tree`, the commit via
 * `commit-tree`. That is the only way to commit a 120000 symlink, a 100755 or a
 * 160000 gitlink at a chosen path, and it keeps the normal 100644 cases on the
 * same code as the refused shapes.
 */
type ManifestSpec =
  | { kind: "absent" }
  | { kind: "file"; content: string }
  | { kind: "symlink"; target: string; targetContent: string }
  | { kind: "mode"; mode: string; content: string }
  | { kind: "githubSymlink"; dir: string };

async function fixture(manifest: ManifestSpec): Promise<{ repo: string; merge: string }> {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  await mkdir(repo, { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  const base = await commitFiles(repo, { "README.md": "# scratch\n" }, "base");

  /** Writes `content` as a loose blob; returns its object id. */
  async function blob(content: string): Promise<string> {
    const file = join(root, `blob-${counter}`);
    await writeFile(file, content);
    return git(repo, "hash-object", "-w", file);
  }

  if (manifest.kind === "symlink") {
    // The redirect this design exists to refuse: a symlink LEAF at the pin path,
    // pointing at a planted file carrying the MARKER content.
    await commitFiles(repo, { [manifest.target]: manifest.targetContent }, "plant the target");
  }
  if (manifest.kind === "githubSymlink") {
    // The same redirect one level up: `.github` itself is the symlink, planted
    // dir carrying the MARKER content.
    await commitFiles(repo, { [`${manifest.dir}/requirements-zizmor.txt`]: MARKER }, "plant the dir");
  }

  if (manifest.kind === "file") {
    const id = await blob(manifest.content);
    git(repo, "update-index", "--add", "--cacheinfo", `100644,${id},${MANIFEST_PATH}`);
  } else if (manifest.kind === "symlink") {
    const id = await blob(manifest.target);
    git(repo, "update-index", "--add", "--cacheinfo", `120000,${id},${MANIFEST_PATH}`);
  } else if (manifest.kind === "mode") {
    // A gitlink's cacheinfo id is a COMMIT id, not a blob this repo must hold:
    // the base commit itself plays the submodule target.
    const id = manifest.mode === "160000" ? base : await blob(manifest.content);
    git(repo, "update-index", "--add", "--cacheinfo", `${manifest.mode},${id},${MANIFEST_PATH}`);
  } else if (manifest.kind === "githubSymlink") {
    const id = await blob(manifest.dir);
    git(repo, "update-index", "--add", "--cacheinfo", `120000,${id},.github`);
  }

  const tree = git(repo, "write-tree");
  const merge = git(repo, "commit-tree", tree, "-p", base, "-m", "manifest case");
  return { repo, merge };
}

/**
 * A stub `pip`, first on PATH: appends its full argv (space-joined) as one line
 * to `ZIZMOR_PIP_STUB_LOG` and exits 0 — or `ZIZMOR_PIP_STUB_EXIT`, for the
 * case where pip itself must fail the step. NO NETWORK: nothing here resolves
 * a package.
 *
 * The stub is linear and never self-spawns, so the recursion-safety rule's
 * depth cap and scope wrapper do not apply to it; the cases spawn exactly one
 * bash per run.
 */
const PIP_STUB = [
  "#!/usr/bin/env bash",
  'printf \'%s\\n\' "$*" >> "${ZIZMOR_PIP_STUB_LOG}"',
  'if [ -n "${ZIZMOR_PIP_STUB_EXIT:-}" ]; then',
  '  exit "${ZIZMOR_PIP_STUB_EXIT}"',
  "fi",
  "exit 0",
  "",
].join("\n");

type StepResult = { status: number | null; stdout: string; stderr: string };

/**
 * Executes the pin step's real `run:` text the way the runner does: bash with
 * the runner's flags, MERGE_SHA resolved from the case's merge commit, a fresh
 * RUNNER_TEMP, and cwd the scratch repository that holds the objects — the
 * checkout the runner executes steps in holds the fetched objects too.
 */
async function runStep(
  merge: { repo: string; merge: string },
  options: { stubExit?: string; runnerTemp?: string } = {},
): Promise<StepResult & { runnerTemp: string; log: string }> {
  counter += 1;
  const runnerTemp = options.runnerTemp ?? join(root, `runner-temp-${counter}`);
  await mkdir(runnerTemp, { recursive: true });
  const stubBin = join(root, `stub-bin-${counter}`);
  const log = join(root, `pip-argv-${counter}`);
  await mkdir(stubBin);
  await writeFile(join(stubBin, "pip"), PIP_STUB);
  await chmod(join(stubBin, "pip"), 0o755);
  await writeFile(log, "");
  const script = join(root, `step-${counter}.sh`);
  await writeFile(script, theStep().run ?? "exit 99\n");
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-eo", "pipefail", script],
    {
      cwd: merge.repo,
      encoding: "utf8",
      env: {
        ...scratchGitEnv,
        MERGE_SHA: merge.merge,
        RUNNER_TEMP: runnerTemp,
        ZIZMOR_PIP_STUB_LOG: log,
        ...(options.stubExit !== undefined ? { ZIZMOR_PIP_STUB_EXIT: options.stubExit } : {}),
        PATH: `${stubBin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    runnerTemp,
    log,
  };
}

/** The pip argv log as an array of space-joined argv lines, one per invocation. */
async function pipInvocations(log: string): Promise<string[]> {
  const text = await readFile(log, "utf8");
  return text === "" ? [] : text.split("\n").filter((line) => line !== "");
}

/**
 * 1007's exact bad manifest: `zizmor==1.30.1` carrying 1.29.0's eleven hashes.
 * GRAMMAR-VALID — the version owns a published release and each entry is a
 * 64-hex sha256 — so the pre-parse passes it and only pip can refuse it.
 */
const BAD_MANIFEST_1007 =
  "zizmor==1.30.1 " +
  [
    "ea72f84d610643d57f96430c655a3780d0b874e477d32e14eae8e910f6cce1fd",
    "5aafe617d7b1e0c0c15d58fdf20495f360f74a791dfa136f76630b4cc06c2a34",
    "67644ae8d6d0394204b9a488f7d86f0dd66fe562f4ba85fc53e6105a6bfc7b6a",
    "81e4093fed5c8a41d6ae7bb773085a9d2e6c0b0a0b560d46a9c76d69be0a07ed",
    "587b99c2e1b34575c6c8565c2bfde415ca8bc0310f5589f19bc948c8dea10a20",
    "061600f23c46f2e400bcdef666c236de7e5c0b07dd6ca046daa001eb1514b909",
    "332546480be38aca95c149f835e0dcb7679ab5d74618a90c6ccb3fa6b8c7b99d",
    "a7462b9ab45d72a20ad5ab8193b430df8184c59e2bf46954ddd09496f2f00b45",
    "8c759e68cd866375030ca39e19e2de47a056b7be7288c1620e2d5b4c274f631f",
    "0fb85948ba5ffc7a8116eee36fe9cfc10167225c97bd2810e3378e66a9fd27c4",
    "60e34e83c67064e0036989c7c525d13413e897aa4c4f683f1efb2048cdb28a47",
  ]
    .map((hash) => `--hash=sha256:${hash}`)
    .join(" ") +
  "\n";

describe(`the ${STEP_NAME} step of ci-pr.yml`, () => {
  it("is wired as the brief pins it: base-defined, token-free, between the scope gate and the suite await", () => {
    const step = theStep();
    expect(step.env, "the step maps MERGE_SHA and nothing else — no token, no PR_TREE").toEqual({
      MERGE_SHA: "${{ steps.pr-tree.outputs.merge_sha }}",
    });
    expect(step.if, "the gate must be unconditional").toBeUndefined();
    expect(step["continue-on-error"], "the gate must not tolerate its own failure").toBeFalsy();
    const names = steps.map((entry) => entry.name);
    expect(names.indexOf(STEP_NAME)).toBeGreaterThan(names.indexOf("Refuse a commit whose scope names a workflow outside the ci type"));
    expect(names.indexOf(STEP_NAME)).toBeLessThan(names.indexOf("Await the pull request suite"));
    expect(step.run, "the read is from git objects").toContain("git ls-tree");
    expect(step.run).toContain("git cat-file blob");
    for (const forbidden of ["GH_TOKEN", "GITHUB_TOKEN", "PR_TREE"]) {
      expect(step.run, `the run block must not touch ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("refuses a manifest that is a symlink, and never prints the planted target", async () => {
    const fx = await fixture({
      kind: "symlink",
      target: "evil/requirements.txt",
      targetContent: MARKER,
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("refuses a tree whose .github ITSELF is a symlink, and never prints the planted target", async () => {
    const fx = await fixture({ kind: "githubSymlink", dir: "evil-gh" });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(`${result.stdout}${result.stderr}`).not.toContain(MARKER);
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("refuses an in-file --index-url line before pip runs", async () => {
    const fx = await fixture({
      kind: "file",
      content:
        "# comment\n" +
        "--index-url https://attacker.invalid/simple\n" +
        `zizmor==1.30.1 --hash=sha256:${"a".repeat(64)}\n`,
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("refuses an -r include line before pip runs", async () => {
    const fx = await fixture({
      kind: "file",
      content:
        `zizmor==1.30.1 --hash=sha256:${"a".repeat(64)}\n` +
        "-r extras.txt\n",
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("refuses a zizmor @ file URL line", async () => {
    const fx = await fixture({
      kind: "file",
      content: `zizmor @ file:///tmp/x#sha256=${"a".repeat(64)}\n`,
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("refuses an environment-marker line", async () => {
    const fx = await fixture({
      kind: "file",
      content: "zizmor==1.30.1 ; sys_platform == 'plan9'\n",
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("passes 1007's exact bad manifest to pip, and fails the step when pip refuses it", async () => {
    const fx = await fixture({ kind: "file", content: BAD_MANIFEST_1007 });
    const result = await runStep(fx, { stubExit: "1" });
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);

    // The failure is PIP's, not the pre-parse's: the same manifest with a pip
    // that resolves succeeds, so the refusal above is the hash mismatch.
    const resolves = await runStep(fx, { stubExit: "0" });
    expect(resolves.status, `${resolves.stdout}${resolves.stderr}`).toBe(0);

    // What pip was handed: the sanitized copy, EXACTLY the one grammar-validated
    // line — the only content pip could ever print.
    const invocations = await pipInvocations(result.log);
    expect(invocations).toHaveLength(1);
    const requirements = invocations[0]!.split(" -r ")[1]!;
    expect(await readFile(requirements, "utf8")).toBe(BAD_MANIFEST_1007);
  });

  it.each([
    ["mode 100755", "100755"],
    ["a gitlink (mode 160000)", "160000"],
  ])("refuses the pin committed as %s", async (_label, mode) => {
    const fx = await fixture({ kind: "mode", mode, content: `zizmor==1.30.1 --hash=sha256:${"a".repeat(64)}\n` });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("::error::");
    expect(await pipInvocations(result.log)).toEqual([]);
  });

  it("resolves the sanitized copy with the exact argv the design pins", async () => {
    const fx = await fixture({
      kind: "file",
      content: await readFile(resolve(".github/requirements-zizmor.txt"), "utf8"),
    });
    const result = await runStep(fx);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);

    const invocations = await pipInvocations(result.log);
    expect(invocations).toHaveLength(1);
    const sanitized = join(result.runnerTemp, SANITIZED_DIR);
    expect(invocations[0]).toBe(
      `download --no-deps --only-binary=:all: --require-hashes ` +
        `--index-url https://pypi.org/simple --no-input --disable-pip-version-check ` +
        `--retries 2 --timeout 60 -d ${sanitized}/download -r ${sanitized}/requirements.txt`,
    );
    // The copy is fresh and sanitized: a leftover directory this run did not
    // create is refused (the suite-coverage step's hygiene, mirrored).
    const again = await runStep(fx, { runnerTemp: result.runnerTemp });
    expect(again.status, `${again.stdout}${again.stderr}`).not.toBe(0);
    expect(`${again.stdout}${again.stderr}`).toContain("::error::");
  });

});
