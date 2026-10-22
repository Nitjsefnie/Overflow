import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv } from "../support/scratch-git";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "docs-only-step-")]);

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, string | undefined>;
};

describe("the verify workflow's docs-only detection step", () => {
  let detectSteps: WorkflowStep[] = [];
  let prStep: WorkflowStep | undefined;
  let pushStep: WorkflowStep | undefined;
  const detectStepsPerFile: { file: string; steps: WorkflowStep[] }[] = [];

  beforeAll(async () => {
    const gate = async (file: string) => {
      const source = await readFile(resolve(file), "utf8");
      const workflow = parse(source) as { jobs?: { verify?: { steps?: WorkflowStep[] } } };
      const found = (workflow.jobs?.verify?.steps ?? []).filter(
        (candidate) => candidate.name === "Detect docs-only change",
      );
      detectStepsPerFile.push({ file, steps: found });
      return found[0];
    };
    prStep = await gate(".github/workflows/ci-pr.yml");
    pushStep = await gate(".github/workflows/ci.yml");
    detectSteps = detectStepsPerFile.flatMap((entry) => entry.steps);
  });

  it("exists exactly once in each leg, under the id that leg's gated steps read", () => {
    expect(
      detectStepsPerFile.map((entry) => `${entry.file}:${entry.steps.length}`),
      "each of the two legs must carry exactly one Detect docs-only change step; a file carrying " +
        "none leaves the steps gated on its output reading an output nothing writes, and a file " +
        "carrying two makes that output ambiguous",
    ).toEqual([".github/workflows/ci-pr.yml:1", ".github/workflows/ci.yml:1"]);
    expect(detectSteps).toHaveLength(2);
    for (const found of detectSteps) {
      expect(
        found.id,
        "both steps must carry the id `detect-docs` — the test and coverage steps in each file " +
          "read its output by that id",
      ).toBe("detect-docs");
      expect(Boolean(found["continue-on-error"])).toBe(false);
    }
    expect(prStep?.if, "only superseded cancellations skip PR docs detection").toBe("${{ steps.pr.outputs.superseded != 'true' }}");
    expect(pushStep?.if, "main docs detection always writes the output its later steps read").toBeUndefined();
  });

  it("takes each leg's inputs through env, never interpolated into run", () => {
    // The push leg measures the checked-out commit against a base that comes
    // from the event or the dispatch input; the pull-request leg measures the
    // materialised merge tree against its first parent, so it names no event
    // value at all.
    expect(pushStep?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      PUSH_BEFORE: "${{ github.event.before }}",
      DISPATCH_BASE: "${{ inputs.base }}",
    });
    expect(prStep?.env).toEqual({ PR_TREE: "${{ steps.pr-tree.outputs.path }}" });
    for (const found of detectSteps) {
      expect(found.run).toBeDefined();
      expect(found.run?.includes("${{")).toBe(false);
    }
  });

  it("runs the base copy over the materialised merge tree in the pull-request leg", () => {
    const run = prStep?.run ?? "";

    // The workspace is the base checkout and the pull request's merge commit
    // is the detached worktree at PR_TREE. The base copy of the script judges
    // it against its first parent; nothing is fetched or deepened here, and
    // there is no event arm to select, because the file receives nothing but
    // workflow_run.
    expect(run).toBe(
      'cd "${PR_TREE:?the pull request tree was not materialised}"\n' +
        'changed=$(node "${GITHUB_WORKSPACE}/scripts/docs-only.ts" HEAD^1)\n' +
        'echo "docs_only=${changed}" >> "$GITHUB_OUTPUT"\n',
    );
    // The push and dispatch logic moved to the other file; this leg must not
    // carry a copy of it, because a second copy is a second thing to keep in
    // step and neither file's runner can reach it.
    expect(run).not.toContain("EVENT_NAME");
    expect(run).not.toContain("refs/pull");
  });

  it("keeps the push and dispatch bases in the other leg, deepening GITHUB_SHA twice", () => {
    const run = pushStep?.run ?? "";

    // The push and workflow_dispatch branches keep their deepening of
    // GITHUB_SHA (the checked-out commit on those events): a leading depth-2
    // fetch first, then two --unshallow lines.
    expect(run.startsWith('git fetch --depth=2 origin "${GITHUB_SHA}"\nbase=""\n')).toBe(true);
    expect(run.match(/git fetch --no-tags --unshallow origin "\$\{GITHUB_SHA\}"/g)).toHaveLength(2);
    expect(run).toContain('if [ "${EVENT_NAME}" = push ]; then');
    expect(run).toContain(
      'elif [ "${EVENT_NAME}" = workflow_dispatch ] && [ -n "${DISPATCH_BASE}" ]; then',
    );
    // And this leg must not carry the pull-request branch: it has no
    // materialise step, so PR_TREE would be an unset variable.
    expect(run).not.toContain("PR_TREE");
    expect(run).not.toContain("workflow_run");
    expect(run).not.toContain("pull_request_target");
  });

  it("hands the base to the docs-only CLI instead of piping a diff into it", () => {
    // One of exactly two base spellings, so the CLI is handed a base rather
    // than a diff on stdin: `${base}` on the push/dispatch leg, and the merge
    // tree's own first parent on the pull-request leg, which has no event
    // value to derive a base from.
    for (const [found, invocation] of [
      [prStep, 'node "${GITHUB_WORKSPACE}/scripts/docs-only.ts" HEAD^1'],
      [pushStep, 'node "${GITHUB_WORKSPACE}/scripts/docs-only.ts" "${base}"'],
    ] as const) {
      expect(found?.run, "the CLI must be handed the base as an argument").toContain(invocation);
      expect(found?.run, "no diff may be piped into the CLI").not.toMatch(/\|\s*node /);
    }
  });

  describe("run in a shallow checkout", () => {
    const zeroSha = "0000000000000000000000000000000000000000";
    let root = "";
    let counter = 0;

    beforeAll(async () => {
      root = await tempDirectories.createAsync(join(tmpdir(), "docs-only-step-"));
    });

    afterAll(async () => {
      await tempDirectories.disposeAsync(root);
    });

    async function upstream(): Promise<string> {
      counter += 1;
      const repo = join(root, `upstream-${counter}`);
      await mkdir(repo);
      git(repo, "init", "--quiet", "--initial-branch=main");
      await mkdir(join(repo, "scripts"));
      await copyFile(resolve("scripts/docs-only.ts"), join(repo, "scripts/docs-only.ts"));
      await commitFiles(
        repo,
        { "src/lib/format-signed.ts": "export const formatSigned = 0;\n", "README.md": "# scratch\n" },
        "root",
      );
      return repo;
    }

    async function runStep(
      origin: string,
      sha: string,
      env: { EVENT_NAME: string; PUSH_BEFORE: string; DISPATCH_BASE?: string; PR_NUMBER?: string },
      options?: { githubSha?: string },
    ) {
      counter += 1;
      const checkout = join(root, `checkout-${counter}`);
      await mkdir(checkout);
      git(checkout, "init", "--quiet");
      git(checkout, "remote", "add", "origin", `file://${origin}`);
      // The event picks the file, and therefore the run block: after issue
      // 1090's split the pull-request leg lives in ci-pr.yml and the push and
      // dispatch legs in ci.yml, and no single step answers both any more.
      const leg = env.EVENT_NAME === "workflow_run" ? prStep : pushStep;
      let prTree: Record<string, string> = {};
      if (env.EVENT_NAME === "workflow_run") {
        // The runner state the materialise step leaves: a full-history
        // checkout of the base tip, and the merge commit `sha` as a detached
        // worktree outside it.
        const baseTip = options?.githubSha ?? sha;
        git(checkout, "fetch", "--quiet", "origin", baseTip, `+refs/pull/${env.PR_NUMBER}/merge:refs/remotes/pr/merge`);
        git(checkout, "checkout", "--quiet", "--detach", baseTip);
        const tree = `${checkout}-pr-tree`;
        git(checkout, "worktree", "add", "--quiet", "--detach", tree, sha);
        prTree = { PR_TREE: tree };
      } else {
        git(checkout, "fetch", "--quiet", "--depth=1", "origin", sha);
        git(checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD");
      }

      const scriptPath = join(root, `step-${counter}.sh`);
      const outputPath = join(root, `output-${counter}`);
      await writeFile(scriptPath, leg?.run ?? "exit 99\n");
      await writeFile(outputPath, "");
      const result = spawnSync("bash", ["-e", scriptPath], {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...scratchGitEnv,
          ...env,
          ...prTree,
          GITHUB_WORKSPACE: checkout,
          GITHUB_SHA: options?.githubSha ?? sha,
          GITHUB_OUTPUT: outputPath,
          PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
        },
      });
      return {
        checkout,
        status: result.status,
        stderr: result.stderr,
        output: await readFile(outputPath, "utf8"),
      };
    }

    it("judges a push by every commit since its before SHA", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commitFiles(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code");
      const head = await commitFiles(origin, { "README.md": "# scratch, edited\n" }, "docs");

      const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=false\n");
      // Later steps (the patch coverage report) still diff HEAD^1..HEAD, so
      // fetching the before SHA must not cut the first parent off the history.
      expect(git(result.checkout, "rev-parse", "HEAD^1")).toMatch(/^[0-9a-f]{40}$/);
    });

    it("judges a single-commit push, whose before SHA is the first parent", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      const head = await commitFiles(origin, { "README.md": "# scratch, edited\n" }, "docs");

      const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });

    it("still finds a docs-only push docs-only", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commitFiles(origin, { "README.md": "# scratch, first edit\n" }, "docs one");
      const head = await commitFiles(origin, { "CONTRIBUTING.md": "# contributing\n" }, "docs two");

      const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });

    it("measures a push whose before SHA is empty, all zeros or unfetchable", async () => {
      const origin = await upstream();
      await commitFiles(origin, { "README.md": "# scratch, first edit\n" }, "docs one");
      const head = await commitFiles(origin, { "README.md": "# scratch, second edit\n" }, "docs two");

      // The unfetchable case is a SHA that exists in no repository.
      for (const before of ["", zeroSha, "1234567890abcdef1234567890abcdef12345678"]) {
        const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
        expect(result.status, `before ${JSON.stringify(before)}: ${result.stderr}`).toBe(0);
        expect(result.output, `before ${JSON.stringify(before)}`).toBe("docs_only=false\n");
      }
    });

    async function mergeRef(origin: string, headChange: (repo: string) => Promise<void>): Promise<string> {
      git(origin, "checkout", "--quiet", "-b", "feature");
      await headChange(origin);
      git(origin, "checkout", "--quiet", "main");
      await commitFiles(origin, { "CHANGELOG.md": "# changes\n" }, "base advance");
      git(origin, "merge", "--quiet", "--no-ff", "--no-edit", "feature");
      const merge = git(origin, "rev-parse", "HEAD");
      git(origin, "update-ref", "refs/pull/1/merge", merge);
      return merge;
    }

    it("classifies a workflow_run run's rename by its source path", async () => {
      const origin = await upstream();
      const merge = await mergeRef(origin, async (repo) => {
        git(repo, "mv", "src/lib/format-signed.ts", "src/lib/format-signed.md");
        git(repo, "commit", "--quiet", "--message", "rename");
      });

      const result = await runStep(
        origin,
        merge,
        { EVENT_NAME: "workflow_run", PUSH_BEFORE: "", PR_NUMBER: "1" },
        // The real event's runner state: the checkout is the merge ref while
        // GITHUB_SHA points at the base tip (fix round 1, finding B).
        { githubSha: git(origin, "rev-parse", `${merge}^1`) },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=false\n");
    });

    it("diffs a workflow_run run against its first parent, with GITHUB_SHA at the base tip", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commitFiles(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code on main");
      const merge = await mergeRef(origin, async (repo) => {
        await commitFiles(repo, { "README.md": "# scratch, edited\n" }, "docs");
      });

      const result = await runStep(
        origin,
        merge,
        { EVENT_NAME: "workflow_run", PUSH_BEFORE: before, PR_NUMBER: "1" },
        { githubSha: git(origin, "rev-parse", `${merge}^1`) },
      );
      expect(result.status, result.stderr).toBe(0);
      // The failing witness for finding B: docs_only=true must survive the
      // workflow_run branch when the runner state models the real
      // event (base-tip GITHUB_SHA, merge-ref checkout).
      expect(result.output).toBe("docs_only=true\n");
    });

    it("measures the issue 797 code then docs landing with no dispatch base", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commitFiles(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code");
      const head = await commitFiles(origin, { "README.md": "# scratch, edited\n" }, "docs");

      const result = await runStep(origin, head, { EVENT_NAME: "workflow_dispatch", PUSH_BEFORE: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=false\n");

      const ranged = await runStep(origin, head, { EVENT_NAME: "workflow_dispatch", PUSH_BEFORE: "", DISPATCH_BASE: before });
      expect(ranged.status, ranged.stderr).toBe(0);
      expect(ranged.output).toBe("docs_only=false\n");
    });

    it("classifies a valid docs-only dispatch range as docs-only", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commitFiles(origin, { "README.md": "# scratch, first edit\n" }, "docs one");
      const head = await commitFiles(origin, { "CONTRIBUTING.md": "# contributing\n" }, "docs two");

      const result = await runStep(origin, head, { EVENT_NAME: "workflow_dispatch", PUSH_BEFORE: "", DISPATCH_BASE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });

    it("rejects malformed, equal and non-ancestor dispatch bases visibly", async () => {
      const origin = await upstream();
      const unrelated = git(origin, "rev-parse", "HEAD");
      git(origin, "checkout", "--quiet", "-b", "other");
      const other = await commitFiles(origin, { "README.md": "# other\n" }, "other");
      git(origin, "checkout", "--quiet", "main");
      const head = await commitFiles(origin, { "README.md": "# main\n" }, "main");

      for (const [base, problem] of [
        ["not-a-sha", "format"],
        ["$(touch /tmp/overflow-797-injection)", "format"],
        [head, "differ"],
        [other, "ancestor"],
      ]) {
        const result = await runStep(origin, head, { EVENT_NAME: "workflow_dispatch", PUSH_BEFORE: unrelated, DISPATCH_BASE: base });
        expect(result.status, base).not.toBe(0);
        expect(result.stderr, base).toContain("::error::");
        expect(result.stderr, base).toContain(problem);
      }
    });
  });
});
