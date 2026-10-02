import { spawnSync, type SpawnSyncReturns as SpawnResult } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderMarkdown } from "../../scripts/patch-coverage.ts";

/**
 * Issue 656: the coverage comment job holds a PR-writing token, so which pull
 * request it writes to and what it writes there must come from the trusted
 * workflow_run event — its head repository, head branch and head SHA — and
 * never from anything a fork-controlled ci run produced.
 *
 * tests/ci/coverage-comment-workflow.test.ts pins the YAML shape; this suite
 * EXECUTES the real run blocks, extracted from the parsed workflow, under the
 * same bash flags GitHub uses, with a stubbed gh first on PATH. The stub
 * answers the way GitHub does: the REST pulls list with head=owner:branch
 * scopes by head label, while `gh pr list --head <branch>` matches the ref
 * name from any repository. Every recorded gh argv is asserted on, so the
 * query that reaches the API is observed rather than assumed.
 */
type WorkflowStep = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: WorkflowStep[] }> };

const REPO_SLUG = "Nitjsefnie/Overflow";
const BASE_OWNER = "Nitjsefnie";
const FORK_OWNER = "mallory";
const FORK_REPO = "mallory/Overflow";
const BRANCH = "feature/shared-name";
const EVENT_SHA = "1111111111111111111111111111111111111111";
const OTHER_SHA = "2222222222222222222222222222222222222222";
const MARKER = "<!-- overflow:coverage-comment -->";

type IssueComment = { id: number; user: { login: string } | null; body: string };

type Candidate = {
  number: number;
  head: { ref: string; label: string; sha: string; repo: { full_name: string } | null };
};

function candidate(number: number, owner: string, repo: string | null, sha: string): Candidate {
  return {
    number,
    head: {
      ref: BRANCH,
      label: `${owner}:${BRANCH}`,
      sha,
      repo: repo === null ? null : { full_name: repo },
    },
  };
}

describe("the coverage comment workflow's run blocks", () => {
  let resolveRun = "";
  let bodyRun = "";
  let upsertRun = "";
  let checkRunRun = "";
  let tempRoot = "";
  let tempCounter = 0;

  beforeAll(async () => {
    const workflow = parse(
      await readFile(resolve(".github/workflows/coverage-comment.yml"), "utf8"),
    ) as Workflow;
    const steps = workflow.jobs?.comment?.steps ?? [];
    resolveRun = steps.find((step) => step.name === "Resolve the destination pull request")?.run ?? "";
    bodyRun = steps.find((step) => step.name === "Determine the comment body")?.run ?? "";
    upsertRun = steps.find((step) => step.name === "Post or update the marker-identified comment")?.run ?? "";
    checkRunRun = steps.find((step) => step.name === "Publish the coverage comment check run")?.run ?? "";
    expect(resolveRun, "the resolve step's run block must exist").not.toBe("");
    expect(bodyRun, "the body step's run block must exist").not.toBe("");
    expect(upsertRun, "the upsert step's run block must exist").not.toBe("");
    expect(checkRunRun, "the check-run step's run block must exist").not.toBe("");
    tempRoot = join(tmpdir(), `coverage-comment-${process.pid}-${Date.now()}`);
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  type RunOutcome = {
    result: SpawnResult<string>;
    outputs: Record<string, string>;
    argv: string[][];
    body: string | undefined;
  };

  async function runBlock(
    script: string,
    env: Record<string, string>,
    options: { pulls?: Candidate[]; artifact?: unknown; comments?: IssueComment[]; bodyFile?: string } = {},
  ): Promise<RunOutcome> {
    tempCounter += 1;
    const dir = join(tempRoot, `case-${tempCounter}`);
    const stubDir = join(dir, "bin");
    const work = join(dir, "work");
    await mkdir(stubDir, { recursive: true });
    await mkdir(work, { recursive: true });
    const argvLog = join(dir, "gh-argv");
    const outputFile = join(dir, "github-output");
    await writeFile(argvLog, "", "utf8");
    await writeFile(outputFile, "", "utf8");
    await writeFile(join(dir, "pulls.json"), JSON.stringify(options.pulls ?? []), "utf8");
    await writeFile(join(dir, "comments.json"), JSON.stringify(options.comments ?? []), "utf8");
    if (options.bodyFile !== undefined) {
      await writeFile(join(work, "comment-body.md"), options.bodyFile, "utf8");
    }
    if (options.artifact !== undefined) {
      await mkdir(join(work, "patch-coverage"), { recursive: true });
      // A string is written as raw JSON text, for literals JSON.stringify
      // cannot produce (3.0, 1e0, -0).
      await writeFile(
        join(work, "patch-coverage", "patch-coverage.json"),
        typeof options.artifact === "string" ? options.artifact : JSON.stringify(options.artifact),
        "utf8",
      );
    }
    // Records each call's argv (one argument per line, each call closed by a
    // sentinel line) and answers as GitHub would: the two pull-request list
    // shapes, the issue-comment list (applying the caller's --jq to the canned
    // comments, as gh does), and a comment PATCH or POST. Anything else exits
    // 3 so a mis-wired call fails.
    const stub = join(stubDir, "gh");
    await writeFile(
      stub,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'printf \'%s\\n\' "$@" "--end-of-call--" >> "$STUB_ARGV_LOG"',
        'label=""; ref=""; filter=""; method=""; path=""; prev=""',
        'for a in "$@"; do',
        '  case "$a" in head=*) label="${a#head=}" ;; repos/*) path="$a" ;; esac',
        '  if [ "$prev" = "--head" ]; then ref="$a"; fi',
        '  if [ "$prev" = "--jq" ]; then filter="$a"; fi',
        '  if [ "$prev" = "-X" ]; then method="$a"; fi',
        '  prev="$a"',
        "done",
        'if [ "$method" = "PATCH" ] || [ "$method" = "POST" ]; then',
        "  echo '{}'",
        'elif [[ "$path" == */issues/*/comments && -n "$filter" ]]; then',
        '  jq -r "$filter" "$STUB_COMMENTS"',
        'elif [ -n "$label" ]; then',
        '  jq -c --arg l "$label" \'[.[] | select(.head.label == $l)]\' "$STUB_PULLS"',
        'elif [ -n "$ref" ]; then',
        '  jq -c --arg r "$ref" \'[.[] | select(.head.ref == $r) | {number}]\' "$STUB_PULLS"',
        "else",
        '  echo "stub gh: unexpected call: $*" >&2',
        "  exit 3",
        "fi",
      ].join("\n") + "\n",
      "utf8",
    );
    await chmod(stub, 0o755);
    const scriptFile = join(dir, "step.sh");
    await writeFile(scriptFile, script, "utf8");

    // Every variable either step reads is cleared first, so nothing from the
    // runner's own environment can stand in for a value the case omits.
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "GH_TOKEN", "REPO_SLUG", "HEAD_BRANCH", "HEAD_OWNER", "HEAD_REPO", "HEAD_SHA",
      "CONCLUSION", "PR_NUMBER", "SAME_REPO", "RUN_EVENT",
      "PR_FOUND", "PR_OUTCOME", "COMMENT_OUTCOME",
    ]) {
      delete childEnv[key];
    }
    Object.assign(childEnv, {
      GITHUB_OUTPUT: outputFile,
      STUB_ARGV_LOG: argvLog,
      STUB_PULLS: join(dir, "pulls.json"),
      STUB_COMMENTS: join(dir, "comments.json"),
      ...env,
    });
    // The stub answers for gh: its directory goes ahead of PATH so a step can
    // never reach the real binary.
    childEnv.PATH = `${stubDir}:${process.env.PATH ?? ""}`;
    // GitHub runs `shell: bash` steps as `bash --noprofile --norc -eo pipefail {0}`.
    const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", scriptFile], {
      cwd: work,
      env: childEnv,
      encoding: "utf8",
    });

    const outputs: Record<string, string> = {};
    for (const line of (await readFile(outputFile, "utf8")).split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const argv: string[][] = [];
    let call: string[] = [];
    for (const line of (await readFile(argvLog, "utf8")).split("\n")) {
      if (line === "--end-of-call--") {
        argv.push(call);
        call = [];
      } else if (line !== "") {
        call.push(line);
      }
    }
    let body: string | undefined;
    try {
      body = await readFile(join(work, "comment-body.md"), "utf8");
    } catch {
      body = undefined;
    }
    return { result, outputs, argv, body };
  }

  const log = (outcome: RunOutcome): string => `${outcome.result.stdout}\n${outcome.result.stderr}`;

  function resolveEnv(head: { owner: string; repo: string; sha?: string }): Record<string, string> {
    return {
      GH_TOKEN: "stub-token",
      REPO_SLUG,
      HEAD_BRANCH: BRANCH,
      HEAD_OWNER: head.owner,
      HEAD_REPO: head.repo,
      HEAD_SHA: head.sha ?? EVENT_SHA,
      RUN_EVENT: "pull_request",
    };
  }

  describe("resolving the destination pull request", () => {
    it("sends the owner-qualified head query to the pulls API, the branch as a field, never spliced into the path", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), {
        pulls: [candidate(10, BASE_OWNER, REPO_SLUG, EVENT_SHA)],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.argv, "exactly one gh call resolves the destination").toHaveLength(1);
      const [call] = outcome.argv;
      expect(call.slice(0, 1)).toEqual(["api"]);
      expect(call, "the request must be a GET whose fields become URL-encoded query parameters").toEqual(
        expect.arrayContaining(["-X", "GET", `repos/${REPO_SLUG}/pulls`]),
      );
      expect(call, "the head filter must be owner-qualified").toContain(`head=${BASE_OWNER}:${BRANCH}`);
      expect(call).toContain("state=open");
      expect(
        call.filter((arg) => arg.startsWith("repos/")).every((arg) => !arg.includes("?")),
        "the branch must travel as a field — a query string built by hand lets & or # in a branch name inject parameters",
      ).toBe(true);
    });

    it("selects the base repository's pull request, not a fork's open PR with the same branch name", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), {
        pulls: [
          candidate(20, FORK_OWNER, FORK_REPO, EVENT_SHA),
          candidate(21, BASE_OWNER, REPO_SLUG, EVENT_SHA),
        ],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.outputs.found).toBe("true");
      expect(outcome.outputs.pr_number).toBe("21");
      expect(outcome.outputs.same_repo).toBe("true");
    });

    it("selects the fork's pull request for a fork-headed run, not the base repository's PR with the same branch name", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: FORK_OWNER, repo: FORK_REPO }), {
        pulls: [
          candidate(30, BASE_OWNER, REPO_SLUG, EVENT_SHA),
          candidate(31, FORK_OWNER, FORK_REPO, EVENT_SHA),
        ],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.outputs.found).toBe("true");
      expect(outcome.outputs.pr_number).toBe("31");
      expect(outcome.outputs.same_repo).toBe("false");
    });

    it("rejects a candidate the API returned whose head repository differs from the event's", async () => {
      // A candidate carrying the event's label but another repository: the
      // in-job filter, not the API's owner scoping, is what must reject it.
      const impostor = candidate(40, BASE_OWNER, FORK_REPO, EVENT_SHA);
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), {
        pulls: [impostor],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.outputs.found).toBe("false");
      expect(outcome.outputs.pr_number).toBeUndefined();
    });

    it("exits silently when the pull request's head has moved past the event's head SHA", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), {
        pulls: [candidate(50, BASE_OWNER, REPO_SLUG, OTHER_SHA)],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.outputs.found).toBe("false");
      expect(outcome.outputs.pr_number).toBeUndefined();
    });

    it("rejects a candidate whose head repository was deleted (head.repo null) without a jq error", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: FORK_OWNER, repo: FORK_REPO }), {
        pulls: [candidate(60, FORK_OWNER, null, EVENT_SHA)],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.result.stderr).not.toMatch(/jq: error/);
      expect(outcome.outputs.found).toBe("false");
    });

    it("exits silently without querying when the event carries no head repository", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: "", repo: "" }), {
        pulls: [candidate(70, BASE_OWNER, REPO_SLUG, EVENT_SHA)],
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.outputs.found).toBe("false");
      expect(outcome.argv, "no owner means no query can be scoped, so none is sent").toHaveLength(0);
    });

    // An allowlist, not a denylist of today's other triggers, and an empty
    // event is not a pull request's own run either.
    it.each(["workflow_dispatch", "push", "merge_group", ""])(
      "exits silently without querying when the ci run was triggered by %j, not by a pull request event",
      async (event) => {
        const outcome = await runBlock(
          resolveRun,
          { ...resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), RUN_EVENT: event },
          { pulls: [candidate(90, BASE_OWNER, REPO_SLUG, EVENT_SHA)] },
        );

        expect(outcome.result.status, log(outcome)).toBe(0);
        expect(outcome.outputs.found).toBe("false");
        expect(outcome.outputs.pr_number).toBeUndefined();
        expect(outcome.argv, "a run that measured no pull request's diff must not look up a pull request").toHaveLength(0);
      },
    );

    // ci runs on pull_request_target (issue 822), whose run carries the pull
    // request's own head SHA and the BASE repository as head_repository — so
    // the same binding resolves, unchanged, and a fork head falls out of the
    // repository+SHA match as a silent exit.
    it.each(["pull_request", "pull_request_target"])(
      "proceeds for a ci run triggered by %j",
      async (event) => {
        const outcome = await runBlock(
          resolveRun,
          { ...resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), RUN_EVENT: event },
          { pulls: [candidate(91, BASE_OWNER, REPO_SLUG, EVENT_SHA)] },
        );

        expect(outcome.result.status, log(outcome)).toBe(0);
        expect(outcome.outputs.found).toBe("true");
        expect(outcome.outputs.pr_number).toBe("91");
        expect(outcome.outputs.same_repo, "a same-repository head is this repository's own report").toBe("true");
        expect(outcome.argv).toHaveLength(1);
      },
    );

    it("rejects a mismatched-repository candidate on a pull_request_target run too — the binding is event-independent", async () => {
      // Not the fork path: a fork's pull_request_target run reports the FORK
      // as its head repository, so that fork's own pull request matches and
      // is selected (covered above, and its markdown excluded end to end
      // below). This case is the impostor — a same-repository run whose
      // candidate lives in another repository, which the in-job match must
      // reject whichever event delivered it.
      //
      // The candidate is seeded under the BASE owner's head label, so GitHub's
      // own head=owner:branch scoping lets it through and the in-job
      // .head.repo.full_name match is what rejects it. A candidate labelled
      // with the fork owner would be filtered by the API before the jq filter
      // ever ran, which would leave this test green against a filter that
      // rejects nothing.
      const outcome = await runBlock(
        resolveRun,
        {
          ...resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }),
          RUN_EVENT: "pull_request_target",
        },
        { pulls: [candidate(94, BASE_OWNER, FORK_REPO, EVENT_SHA)] },
      );

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(
        outcome.outputs.found,
        "the candidate passed the owner-scoped query carrying another repository, so the .head.repo.full_name match is what rejected it",
      ).toBe("false");
      expect(outcome.outputs.pr_number).toBeUndefined();
    });

    it("compares same_repo by full repository name, so the base owner's second repository takes the untrusted-artifact path and its markdown never reaches the body", async () => {
      const copy = `${BASE_OWNER}/Overflow-copy`;
      const resolved = await runBlock(resolveRun, resolveEnv({ owner: BASE_OWNER, repo: copy }), {
        pulls: [candidate(92, BASE_OWNER, copy, EVENT_SHA)],
      });

      expect(resolved.result.status, log(resolved)).toBe(0);
      expect(resolved.outputs.found).toBe("true");
      expect(resolved.outputs.pr_number).toBe("92");
      expect(
        resolved.outputs.same_repo,
        "same_repo compares full repository names, never owners — an owner's second repository is not this one",
      ).toBe("false");

      const sentinel = "SENTINEL-656-same-owner-copy";
      const body = await runBlock(
        bodyRun,
        { CONCLUSION: "success", HEAD_BRANCH: BRANCH, PR_NUMBER: "92", SAME_REPO: resolved.outputs.same_repo },
        {
          artifact: {
            measured: true,
            total_added: 4,
            total_covered: 1,
            files: [],
            markdown: `@someone ${sentinel}\n`,
          },
        },
      );
      expect(body.result.status, log(body)).toBe(0);
      const rendered = renderMarkdown({ total_added: 4, total_covered: 1, files: [] });
      expect(body.body?.startsWith(`${MARKER}\n\n${rendered}`), body.body).toBe(true);
      expect(body.body).not.toContain(sentinel);
    });

    it("fails loudly when more than one pull request matches the event's head", async () => {
      const outcome = await runBlock(resolveRun, resolveEnv({ owner: BASE_OWNER, repo: REPO_SLUG }), {
        pulls: [candidate(80, BASE_OWNER, REPO_SLUG, EVENT_SHA), candidate(81, BASE_OWNER, REPO_SLUG, EVENT_SHA)],
      });

      expect(outcome.result.status).toBe(1);
      expect(outcome.result.stdout).toContain("::error::");
      expect(outcome.outputs.found).toBeUndefined();
    });
  });

  describe("determining the comment body", () => {
    const SENTINEL = "SENTINEL-656-attacker-controlled";
    const EVIL_PATH = "src/lib/attacker-chosen-path.ts";

    function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        measured: true,
        total_added: 3,
        total_covered: 2,
        files: [{ path: EVIL_PATH, added: 3, covered: 2, missed_ranges: [[4, 4]] }],
        markdown: `## Patch coverage\n\n@someone ${SENTINEL}\n\n| ${EVIL_PATH} | 3 | 2 | 4 |\n`,
        ...overrides,
      };
    }

    function bodyEnv(sameRepo: "true" | "false"): Record<string, string> {
      return { CONCLUSION: "success", HEAD_BRANCH: BRANCH, PR_NUMBER: "21", SAME_REPO: sameRepo };
    }

    // The reference "not measurable" body is whatever the step writes for an
    // artifact that declares itself unmeasured — compared whole, not by prose.
    async function notMeasurableBody(sameRepo: "true" | "false"): Promise<string | undefined> {
      const reference = await runBlock(bodyRun, bodyEnv(sameRepo), { artifact: artifact({ measured: false }) });
      expect(reference.result.status, log(reference)).toBe(0);
      return reference.body;
    }

    it("passes a same-repository artifact's markdown through verbatim", async () => {
      const report = artifact();
      const outcome = await runBlock(bodyRun, bodyEnv("true"), { artifact: report });

      expect(outcome.result.status, log(outcome)).toBe(0);
      // jq -r terminates its output with a newline of its own.
      expect(outcome.body).toBe(`${MARKER}\n\n${String(report.markdown)}\n`);
    });

    it("renders a fork's body from the totals alone, dropping its markdown and file list", async () => {
      const outcome = await runBlock(bodyRun, bodyEnv("false"), { artifact: artifact() });

      expect(outcome.result.status, log(outcome)).toBe(0);
      const rendered = renderMarkdown({ total_added: 3, total_covered: 2, files: [] });
      expect(
        outcome.body?.startsWith(`${MARKER}\n\n${rendered}`),
        `the fork body must open with the marker and the renderer's own totals output; got:\n${outcome.body}`,
      ).toBe(true);
      expect(outcome.body).not.toContain(SENTINEL);
      expect(outcome.body).not.toContain("@someone");
      expect(outcome.body).not.toContain(EVIL_PATH);
      expect(outcome.body).not.toContain("|");
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
    ])("takes the fork path when SAME_REPO is %s, never the verbatim markdown", async (_label, sameRepo) => {
      const env: Record<string, string> = { CONCLUSION: "success", HEAD_BRANCH: BRANCH, PR_NUMBER: "21" };
      if (sameRepo !== undefined) env.SAME_REPO = sameRepo;
      const outcome = await runBlock(bodyRun, env, { artifact: artifact() });

      expect(outcome.result.status, log(outcome)).toBe(0);
      const rendered = renderMarkdown({ total_added: 3, total_covered: 2, files: [] });
      expect(outcome.body?.startsWith(`${MARKER}\n\n${rendered}`), outcome.body).toBe(true);
      expect(outcome.body).not.toContain(SENTINEL);
      expect(outcome.body).not.toContain(EVIL_PATH);
    });

    it("renders a fork's zero-added report the way the renderer does", async () => {
      const outcome = await runBlock(bodyRun, bodyEnv("false"), {
        artifact: artifact({ total_added: 0, total_covered: 0 }),
      });

      expect(outcome.result.status, log(outcome)).toBe(0);
      const rendered = renderMarkdown({ total_added: 0, total_covered: 0, files: [] });
      expect(outcome.body?.startsWith(`${MARKER}\n\n${rendered}`), outcome.body).toBe(true);
      expect(outcome.body).not.toContain(SENTINEL);
    });

    it("renders a fork's integral totals written as 3.0, 1e0 or -0 in plain notation", async () => {
      const raw = `{"measured": true, "total_added": 3.0, "total_covered": 1e0, "files": [], "markdown": "${SENTINEL}"}`;
      const outcome = await runBlock(bodyRun, bodyEnv("false"), { artifact: raw });

      expect(outcome.result.status, log(outcome)).toBe(0);
      const rendered = renderMarkdown({ total_added: 3, total_covered: 1, files: [] });
      expect(outcome.body?.startsWith(`${MARKER}\n\n${rendered}`), outcome.body).toBe(true);

      const zero = `{"measured": true, "total_added": -0, "total_covered": 0.0, "files": [], "markdown": "${SENTINEL}"}`;
      const zeroOutcome = await runBlock(bodyRun, bodyEnv("false"), { artifact: zero });
      expect(zeroOutcome.result.status, log(zeroOutcome)).toBe(0);
      const zeroRendered = renderMarkdown({ total_added: 0, total_covered: 0, files: [] });
      expect(zeroOutcome.body?.startsWith(`${MARKER}\n\n${zeroRendered}`), zeroOutcome.body).toBe(true);
    });

    it.each([
      ["a fractional total", { total_added: 3.5, total_covered: 2 }],
      ["a negative total", { total_added: 3, total_covered: -1 }],
      ["covered above added", { total_added: 2, total_covered: 3 }],
      ["a string total", { total_added: "3", total_covered: 2 }],
      ["a missing total", { total_added: undefined, total_covered: 2 }],
      ["a total beyond the safe-integer range", { total_added: 2 ** 60, total_covered: 2 }],
    ])("substitutes the not-measurable body for a fork artifact with %s", async (_label, totals) => {
      const outcome = await runBlock(bodyRun, bodyEnv("false"), { artifact: artifact(totals) });

      expect(outcome.result.status, log(outcome)).toBe(0);
      const expected = await notMeasurableBody("false");
      expect(expected?.startsWith(`${MARKER}\n\n`)).toBe(true);
      expect(outcome.body).toBe(expected);
    });
  });

  describe("posting or updating the marker-identified comment", () => {
    const BOT = "github-actions[bot]";
    const upsertEnv = { GH_TOKEN: "stub-token", REPO_SLUG, PR_NUMBER: "21" };
    const own: IssueComment = { id: 502, user: { login: BOT }, body: `${MARKER}\n\nold report` };
    // Lookalike authors: another app's bot, the bare name, and a suffixed
    // name — each would pass a cheaper reading of the exact-login predicate.
    const lookalikes = ["someone", "dependabot[bot]", "github-actions", "github-actions[bot]x"];
    const planted = (login: string): IssueComment => ({
      id: 501,
      user: { login },
      body: `quoting ${MARKER} here`,
    });

    const writes = (outcome: RunOutcome): string[][] =>
      outcome.argv.filter((call) => call.includes("PATCH") || call.includes("POST"));

    it.each(lookalikes)(
      "posts a new comment when the only marker-carrying comment is %s's",
      async (login) => {
        const outcome = await runBlock(upsertRun, upsertEnv, {
          comments: [planted(login), { id: 503, user: { login: BOT }, body: "unrelated bot comment" }],
          bodyFile: `${MARKER}\n\nnew report\n`,
        });

        expect(outcome.result.status, log(outcome)).toBe(0);
        expect(writes(outcome), "exactly one write").toHaveLength(1);
        const [write] = writes(outcome);
        expect(write).toEqual(expect.arrayContaining(["-X", "POST", `repos/${REPO_SLUG}/issues/21/comments`]));
        expect(write.some((arg) => arg.includes("/issues/comments/501"))).toBe(false);
      },
    );

    it.each(lookalikes)(
      "updates the bot's own comment in place, never %s's planted marker listed before it",
      async (login) => {
        const outcome = await runBlock(upsertRun, upsertEnv, {
          comments: [planted(login), own],
          bodyFile: `${MARKER}\n\nnew report\n`,
        });

        expect(outcome.result.status, log(outcome)).toBe(0);
        expect(writes(outcome), "exactly one write").toHaveLength(1);
        const [write] = writes(outcome);
        expect(write).toEqual(expect.arrayContaining(["-X", "PATCH", `repos/${REPO_SLUG}/issues/comments/502`]));
      },
    );
  });

  describe("publishing the coverage comment check run", () => {
    // Step outcomes as GitHub reports them: a step skipped by its `if:` has
    // outcome "skipped", and an unset output reads as the empty string.
    const checkEnv = (found: string, prOutcome: string, commentOutcome: string): Record<string, string> => ({
      GH_TOKEN: "stub-token",
      REPO_SLUG,
      HEAD_SHA: EVENT_SHA,
      PR_FOUND: found,
      PR_OUTCOME: prOutcome,
      COMMENT_OUTCOME: commentOutcome,
    });

    const checkRunPosts = (outcome: RunOutcome): string[][] =>
      outcome.argv.filter((call) => call.includes(`repos/${REPO_SLUG}/check-runs`));

    it("publishes nothing after a silent exit of the resolve step", async () => {
      const outcome = await runBlock(checkRunRun, checkEnv("false", "success", "skipped"));

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(outcome.argv, "a silent exit publishes no check run at all").toHaveLength(0);
    });

    it.each([
      ["the comment was posted or updated", "true", "success", "success", "success"],
      ["the comment step failed", "true", "success", "failure", "failure"],
      ["the resolve step failed", "", "failure", "skipped", "failure"],
      ["the body step failed and the comment step was skipped", "true", "success", "skipped", "failure"],
    ])("publishes one check run when %s", async (_label, found, prOutcome, commentOutcome, conclusion) => {
      const outcome = await runBlock(checkRunRun, checkEnv(found, prOutcome, commentOutcome));

      expect(outcome.result.status, log(outcome)).toBe(0);
      expect(checkRunPosts(outcome), "exactly one check run").toHaveLength(1);
      const [post] = checkRunPosts(outcome);
      expect(post).toEqual(
        expect.arrayContaining([
          "-X",
          "POST",
          "name=coverage comment",
          `head_sha=${EVENT_SHA}`,
          "status=completed",
          `conclusion=${conclusion}`,
        ]),
      );
    });
  });
});
