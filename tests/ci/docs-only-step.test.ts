import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

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
 * parent on pull_request and workflow_dispatch runs, the push's `before` SHA
 * on push runs, so a push is judged by every commit it carries rather than by
 * its last one. Every undecidable base must end in docs_only=false.
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
    });
    expect(step?.run).toBeDefined();
    expect(step?.run?.includes("${{")).toBe(false);
  });

  it("hands the base to the docs-only CLI instead of piping a diff into it", () => {
    expect(step?.run).toMatch(/node scripts\/docs-only\.ts "\$\{?\w+\}?"/);
    expect(step?.run).not.toMatch(/\|\s*node scripts\/docs-only\.ts/);
  });

  describe("run in a shallow checkout", () => {
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "docs-only step test",
      GIT_AUTHOR_EMAIL: "docs-only-step@example.invalid",
      GIT_COMMITTER_NAME: "docs-only step test",
      GIT_COMMITTER_EMAIL: "docs-only-step@example.invalid",
    };
    const zeroSha = "0000000000000000000000000000000000000000";
    let root = "";
    let counter = 0;

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "docs-only-step-"));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    function git(repo: string, ...args: string[]): string {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    }

    async function commit(repo: string, files: Record<string, string>, message: string): Promise<string> {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(repo, path)), { recursive: true });
        await writeFile(join(repo, path), content);
      }
      git(repo, "add", "--all");
      git(repo, "commit", "--quiet", "--message", message);
      return git(repo, "rev-parse", "HEAD");
    }

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
      git(repo, "config", "uploadpack.allowReachableSHA1InWant", "true");
      await mkdir(join(repo, "scripts"));
      await copyFile(resolve("scripts/docs-only.ts"), join(repo, "scripts/docs-only.ts"));
      await commit(
        repo,
        { "src/lib/format-signed.ts": "export const formatSigned = 0;\n", "README.md": "# scratch\n" },
        "root",
      );
      return repo;
    }

    /**
     * Runs the step's run script the way the runner would: a depth-1 checkout
     * of `sha` fetched from the origin, bash -e, and a GITHUB_OUTPUT file.
     */
    async function runStep(origin: string, sha: string, env: { EVENT_NAME: string; PUSH_BEFORE: string }) {
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
          ...gitEnv,
          ...env,
          GITHUB_SHA: sha,
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
      await commit(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code");
      const head = await commit(origin, { "README.md": "# scratch, edited\n" }, "docs");

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
      const head = await commit(origin, { "README.md": "# scratch, edited\n" }, "docs");

      const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });

    it("still finds a docs-only push docs-only", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commit(origin, { "README.md": "# scratch, first edit\n" }, "docs one");
      const head = await commit(origin, { "CONTRIBUTING.md": "# contributing\n" }, "docs two");

      const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });

    it("measures a push whose before SHA is empty, all zeros or unfetchable", async () => {
      const origin = await upstream();
      await commit(origin, { "README.md": "# scratch, first edit\n" }, "docs one");
      const head = await commit(origin, { "README.md": "# scratch, second edit\n" }, "docs two");

      for (const before of ["", zeroSha, "1234567890abcdef1234567890abcdef12345678"]) {
        const result = await runStep(origin, head, { EVENT_NAME: "push", PUSH_BEFORE: before });
        expect(result.status, `before ${JSON.stringify(before)}: ${result.stderr}`).toBe(0);
        expect(result.output, `before ${JSON.stringify(before)}`).toBe("docs_only=false\n");
      }
    });

    /** A merge ref: the base tip as first parent, the pull request head as second. */
    async function mergeRef(origin: string, headChange: (repo: string) => Promise<void>): Promise<string> {
      git(origin, "checkout", "--quiet", "-b", "feature");
      await headChange(origin);
      git(origin, "checkout", "--quiet", "main");
      await commit(origin, { "CHANGELOG.md": "# changes\n" }, "base advance");
      git(origin, "merge", "--quiet", "--no-ff", "--no-edit", "feature");
      return git(origin, "rev-parse", "HEAD");
    }

    it("classifies a pull request's rename by its source path", async () => {
      const origin = await upstream();
      const merge = await mergeRef(origin, async (repo) => {
        git(repo, "mv", "src/lib/format-signed.ts", "src/lib/format-signed.md");
        git(repo, "commit", "--quiet", "--message", "rename");
      });

      const result = await runStep(origin, merge, { EVENT_NAME: "pull_request", PUSH_BEFORE: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=false\n");
    });

    it("diffs a pull request against its first parent, ignoring the event's before SHA", async () => {
      const origin = await upstream();
      const before = git(origin, "rev-parse", "HEAD");
      await commit(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code on main");
      const merge = await mergeRef(origin, async (repo) => {
        await commit(repo, { "README.md": "# scratch, edited\n" }, "docs");
      });

      const result = await runStep(origin, merge, { EVENT_NAME: "pull_request", PUSH_BEFORE: before });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });

    it("diffs a workflow_dispatch run against its first parent", async () => {
      const origin = await upstream();
      await commit(origin, { "src/lib/format-signed.ts": "export const formatSigned = 1;\n" }, "code");
      const head = await commit(origin, { "README.md": "# scratch, edited\n" }, "docs");

      const result = await runStep(origin, head, { EVENT_NAME: "workflow_dispatch", PUSH_BEFORE: "" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.output).toBe("docs_only=true\n");
    });
  });
});
