import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv } from "../support/scratch-git";

type WorkflowStep = {
  id?: string;
  name?: string;
  run?: string;
  if?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, string | undefined>;
};

/**
 * The verify job's "Detect docs-only change" step picks the diff base and
 * hands it to scripts/docs-only.ts (issue 646): the merge commit's first
 * parent on pull_request_target runs, the push's `before` SHA on push runs,
 * and an optional validated base on workflow_dispatch runs. A dispatch
 * without a base and every undecidable push must end in docs_only=false.
 *
 * The wiring is pinned on the parsed YAML, and the step's own run script is
 * then executed with bash -e (GitHub's default shell) inside scratch
 * repositories that reproduce the runner's shallow checkout, so the base rule
 * is covered by what the script does rather than by what it says.
 */
describe("the verify workflow's docs-only detection step", () => {
  let step: WorkflowStep | undefined;
  let detectSteps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };
    detectSteps = (workflow.jobs?.verify?.steps ?? []).filter(
      (candidate) => candidate.name === "Detect docs-only change",
    );
    step = detectSteps[0];
  });

  it("exists exactly once, under the id the gated steps read", () => {
    expect(detectSteps).toHaveLength(1);
    expect(step?.id).toBe("detect-docs");
    expect(step?.if).toBeUndefined();
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });

  it("takes the event name and the push base through env, never interpolated into run", () => {
    expect(step?.env).toEqual({
      EVENT_NAME: "${{ github.event_name }}",
      PUSH_BEFORE: "${{ github.event.before }}",
      DISPATCH_BASE: "${{ inputs.base }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
    expect(step?.run).toBeDefined();
    expect(step?.run?.includes("${{")).toBe(false);
  });

  it("deepens the checked-out merge ref, never GITHUB_SHA, on the PR branch", () => {
    const run = step?.run ?? "";

    // GITHUB_SHA is the BASE TIP under pull_request_target (issue 822's event
    // swap): deepening it leaves the checked-out merge commit's graft at depth
    // 1 and HEAD^1 unreadable. The branch must fetch the merge ref itself —
    // the same tip as the checkout, so the shallow graft moves — and the
    // number must arrive through env.
    expect(
      run,
      "the pull_request_target branch must deepen the checked-out merge ref by " +
        'fetching refs/pull/<N>/merge at depth 2 before reading HEAD^1',
    ).toContain(
      'if [ "${EVENT_NAME}" = pull_request_target ]; then\n' +
        '  git fetch --depth=2 origin "+refs/pull/${PR_NUMBER}/merge"\n' +
        "  base=HEAD^1\n",
    );
    // The push and workflow_dispatch branches keep their byte-identical
    // deepening of GITHUB_SHA (the checked-out commit on those events): two
    // --unshallow lines, and the leading depth-2 fetch stays first.
    expect(run.startsWith('git fetch --depth=2 origin "${GITHUB_SHA}"\n')).toBe(true);
    expect(run.match(/git fetch --no-tags --unshallow origin "\$\{GITHUB_SHA\}"/g)).toHaveLength(2);
    expect(run).toContain('elif [ "${EVENT_NAME}" = push ]; then');
    expect(run).toContain(
      'elif [ "${EVENT_NAME}" = workflow_dispatch ] && [ -n "${DISPATCH_BASE}" ]; then',
    );
  });

  it("hands the base to the docs-only CLI instead of piping a diff into it", () => {
    expect(step?.run).toMatch(/node scripts\/docs-only\.ts "\$\{?\w+\}?"/);
    expect(step?.run).not.toMatch(/\|\s*node scripts\/docs-only\.ts/);
  });

  describe("run in a shallow checkout", () => {
    const zeroSha = "0000000000000000000000000000000000000000";
    let root = "";
    let counter = 0;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "docs-only-step-"));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    /**
     * The origin repository. Its root commit carries the real
     * scripts/docs-only.ts, so the step runs the module under test, plus one
     * code file and one doc for later commits to change.
     */
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

    /**
     * Runs the step's run script the way the runner would: a depth-1 checkout
     * of `sha` fetched from the origin, bash -e, and a GITHUB_OUTPUT file.
     * `options.githubSha` overrides the runner's GITHUB_SHA for events where
     * it differs from the checked-out commit (pull_request_target points it
     * at the base tip while the checkout is the merge ref).
     */
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
      git(checkout, "fetch", "--quiet", "--depth=1", "origin", sha);
      git(checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD");

      const scriptPath = join(root, `step-${counter}.sh`);
      const outputPath = join(root, `output-${counter}`);
      await writeFile(scriptPath, step?.run ?? "exit 99\n");
      await writeFile(outputPath, "");
      const result = spawnSync("bash", ["-e", scriptPath], {
        cwd: checkout,
        encoding: "utf8",
        env: {
          ...scratchGitEnv,
          ...env,
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

    /** A merge ref: the base tip as first parent, the pull request head as second.
     * Also plants refs/pull/1/merge on the origin, the way GitHub publishes it. */
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

    it("classifies a pull_request_target run's rename by its source path", async () => {
      const origin = await upstream();
      const merge = await mergeRef(origin, async (repo) => {
        git(repo, "mv", "src/lib/format-signed.ts", "src/lib/format-signed.md");
        git(repo, "commit", "--quiet", "--message", "rename");
      });

      const result = await runStep(
        origin,
        merge,
        { EVENT_NAME: "pull_request_target", PUSH_BEFORE: "", PR_NUMBER: "1" },
        // The real event's runner state: the checkout is the merge ref while
        // GITHUB_SHA points at the base tip (fix round 1, finding B).
        { githubSha: git(origin, "rev-parse", `${merge}^1`) },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=false\n");
    });

    it("diffs a pull_request_target run against its first parent, with GITHUB_SHA at the base tip", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commitFiles(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code on main");
      const merge = await mergeRef(origin, async (repo) => {
        await commitFiles(repo, { "README.md": "# scratch, edited\n" }, "docs");
      });

      const result = await runStep(
        origin,
        merge,
        { EVENT_NAME: "pull_request_target", PUSH_BEFORE: before, PR_NUMBER: "1" },
        { githubSha: git(origin, "rev-parse", `${merge}^1`) },
      );
      expect(result.status, result.stderr).toBe(0);
      // The failing witness for finding B: docs_only=true must survive the
      // pull_request_target branch when the runner state models the real
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
