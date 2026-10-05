import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * pr-suite.yml is where a pull request's own code runs: its install, its
 * migrations, its tests, lint, typecheck, build and page geometry. It runs
 * under `pull_request`, so the definition is the pull request's own and the
 * token is the read-only one GitHub gives an untrusted run. Nothing about it
 * is trusted: ci-pr.yml's verify job reads its outcome as data through the base
 * branch's scripts/await-pr-suite.ts, and it produces no required context.
 *
 * These pins hold the properties that make running untrusted code there
 * harmless: the single trigger, no secret, no environment, no write
 * permission, no persisted credential, and no job whose name is a required
 * context a check-run could be confused with.
 */

type Step = {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};

type Job = {
  name?: string;
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: unknown;
  environment?: unknown;
  if?: unknown;
  "continue-on-error"?: unknown;
  services?: Record<string, { image?: string }>;
  env?: Record<string, string>;
  steps: Step[];
};

type Workflow = {
  name: string;
  on: Record<string, unknown>;
  permissions?: unknown;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};

const PATH = ".github/workflows/pr-suite.yml";
let source = "";
let workflow: Workflow;
let suite: Job;

beforeAll(async () => {
  source = await readFile(resolve(PATH), "utf8");
  workflow = parse(source) as Workflow;
  suite = workflow.jobs.suite!;
});

function runs(): string[] {
  return suite.steps.flatMap((step) => (step.run ? [step.run] : []));
}

function stepRunning(command: string): Step {
  const matching = suite.steps.filter((step) => (step.run ?? "").includes(command));
  expect(matching.map((step) => step.name), `exactly one step runs ${command}`).toHaveLength(1);
  return matching[0]!;
}

/**
 * Split a `run:` block into the shell commands it would execute.
 *
 * The operator set is closed rather than denylisted, which is the whole point:
 * in POSIX sh a command list is separated only by `;`, `&`, `&&`, `||`, `|`,
 * `|&`, and newline. Every one of those starts a second command, so a block that
 * yields a single segment cannot have had its exit status diverted by any of
 * them. A `\`+newline is a line CONTINUATION, not a separator, so it is joined
 * first — that is what keeps the committed three-line block one command rather
 * than three.
 *
 * Deliberately not a shell parser: it does not expand variables, honour
 * subshells, or resolve quoting rules beyond not splitting inside quotes and not
 * mistaking a redirection's `&` for a separator. It answers one question — is
 * there anything here but the one command — and a block that needed more than
 * that to pass would not be one this repository should be running untrusted.
 */
function shellCommands(block: string): string[] {
  const joined = block.replace(/\\\r?\n/g, " ");
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < joined.length; index += 1) {
    const char = joined[index]!;
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    // `2>&1` and `&> log`: the `&` belongs to a REDIRECTION, not to a command
    // separator. Without this a plain `2>&1` splits the block in two and the
    // guard reds on a legitimate, harmless line — the same false red as the
    // over-narrow denylist it replaced, which rejected every `&` including this
    // one.
    if (char === "&" && (joined[index + 1] === ">" || joined[index - 1] === ">")) {
      current += char;
      continue;
    }
    // `&&`, `||` and `|&` are two characters but one operator; consume the pair
    // so the second half is not read as a fresh command.
    const pair = joined.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || pair === "|&") {
      segments.push(current);
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === "\n") {
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter((segment) => segment !== "");
}

describe("the pull request suite workflow", () => {
  it("is named `pr suite`, the name the coverage comment keys on", async () => {
    expect(workflow.name).toBe("pr suite");
    const comment = parse(
      await readFile(resolve(".github/workflows/coverage-comment.yml"), "utf8"),
    ) as { on: { workflow_run: { workflows: string[] } } };
    expect(comment.on.workflow_run.workflows).toEqual([workflow.name]);
  });

  it("declares only the pull_request trigger, for main, on the three code-changing actions", () => {
    expect(workflow.on).toEqual({
      pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
  });

  it("holds a read-only token and no secret, environment or write permission anywhere", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/^\s*environment\s*:/m);
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions, "a job-level block could widen the token").toBeUndefined();
      expect(job.environment).toBeUndefined();
    }
    expect(source).not.toMatch(/:\s*write\b/);
  });

  it("names no job after a required context", async () => {
    const required = Object.keys(
      JSON.parse(await readFile(resolve(".github/required-checks.json"), "utf8")) as Record<string, string>,
    );
    expect(required.sort()).toEqual(["actionlint", "ratchet-guard", "verify"]);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(required).not.toContain(id);
      expect(required).not.toContain(job.name ?? id);
    }
    expect(Object.keys(workflow.jobs)).toEqual(["suite"]);
  });

  it("is superseded only by the same pull request's newer push", () => {
    expect(workflow.concurrency).toEqual({
      group: "pr-suite-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  it("checks out the default pull_request merge commit with no persisted credential", () => {
    const checkouts = suite.steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toEqual({
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false, "fetch-depth": 2 },
    });
    expect(suite["timeout-minutes"]).toBe(45);
    for (const step of suite.steps) {
      expect(step.uses ?? "@0000000000000000000000000000000000000000").toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("runs every code check verify ran for a pull request, in order", () => {
    const order = [
      "corepack install --global pnpm@10.33.0",
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "node scripts/docs-only.ts HEAD^1",
      "pnpm test --run --coverage",
      "node scripts/patch-coverage.ts",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
      "node scripts/check-page-geometry.mjs",
    ];
    const indices = order.map((command) => suite.steps.indexOf(stepRunning(command)));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(suite.services?.postgres?.image).toBe(
      "postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675",
    );
    expect(suite.env).toEqual(expect.objectContaining({
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      npm_config_registry: "https://registry.npmjs.org/",
      DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
    }));
  });

  it("measures coverage unless its own detection says docs-only, and plain-tests otherwise", () => {
    const detect = stepRunning("scripts/docs-only.ts");
    expect(detect.id).toBe("detect-docs");
    expect(detect.if).toBeUndefined();
    const tests = suite.steps.filter((step) => (step.run ?? "").startsWith("pnpm test --run"));
    expect(tests.map((step) => [step.if, step.run])).toEqual([
      [
        "${{ steps.detect-docs.outputs.docs_only != 'true' }}",
        "pnpm test --run --coverage --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=cobertura --coverage.include='src/**'",
      ],
      ["${{ steps.detect-docs.outputs.docs_only == 'true' }}", "pnpm test --run"],
    ]);
  });

  // Seven days, not one: verify downloads coverage-summary from this run
  // cross-run, and a verify re-run or a relay heal can come days after the
  // suite finished; an expired artifact would fail that download.
  it("uploads both coverage artifacts under the names and retention their readers expect", () => {
    const uploads = suite.steps.filter((step) => (step.uses ?? "").startsWith("actions/upload-artifact@"));
    expect(uploads.map((step) => [step.if, step.uses, step.with])).toEqual([
      [
        "${{ steps.detect-docs.outputs.docs_only != 'true' }}",
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        { name: "patch-coverage", path: "coverage/patch-coverage.json", "if-no-files-found": "error", "retention-days": 7 },
      ],
      [
        "${{ steps.detect-docs.outputs.docs_only != 'true' }}",
        "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
        { name: "coverage-summary", path: "coverage/coverage-summary.json", "if-no-files-found": "error", "retention-days": 7 },
      ],
    ]);
  });

  it("judges nothing: no gate script whose verdict verify owns runs here", () => {
    for (const gate of [
      "check-coverage-floor.ts",
      "check-module-size.ts",
      "check-ratchets.ts",
      "check-migration-edits.ts",
      "check-legal-revisions.ts",
      "commit_scopes.py",
      "ci-base-freshness.sh",
      "await-pr-suite.ts",
    ]) {
      expect(runs().join("\n")).not.toContain(gate);
    }
  });

  // The zizmor manifest's whole purpose is that `pip install --require-hashes`
  // rejects content matching no allowed hash — but on a PULL REQUEST that check
  // had no home. actionlint.yml is the only other place it runs, and that leg is
  // pull_request_target with no `ref:`, so it installs MAIN's manifest, never
  // the pull request's (issue 1094). A Dependabot bump carrying the previous
  // release's hashes therefore passed every pull-request check and went red
  // only on the push to main. This step is the pre-merge home, and it is here
  // because pr-suite is the one workflow that runs the request's own tree.
  it("binds the zizmor manifest's hashes to its version, on the pull request's own tree", () => {
    const step = stepRunning("--require-hashes");
    // The check is the download against PyPI, not an install: it resolves the
    // named version and refuses any artifact whose sha256 is not allowed. A
    // stale-hash manifest fails here without anything being installed.
    expect(step.run).toContain("pip download");
    expect(step.run).toContain("--no-deps");
    expect(step.run).toContain("--require-hashes");
    expect(step.run).toContain("-r .github/requirements-zizmor.txt");
    // The step may carry no key that can skip it or swallow its exit status.
    // Asserting `if` alone was not enough: it pins the absence of ONE
    // suppression key and leaves its siblings unpinned, so `continue-on-error:
    // true` — or a `|| true` appended to the command — left this case green
    // while the run concluded `success`, `await-pr-suite.ts` returned 0 and the
    // merge went through with the check inert. That is the same failure this
    // case exists to prevent, reached by a different key, so the assertion is
    // over the whole key set: anything not in the allow-list below has to be
    // added here deliberately, with its reason, rather than slipped in beside
    // the command.
    //
    // `shell` is NOT allow-listed, and its absence is the point rather than an
    // oversight. It was allow-listed as inert, which is true of `shell: bash`
    // and `shell: sh` (GitHub maps both to a `-e` form) and false of any custom
    // string, which GitHub runs verbatim with no `-e`. Allow-listed, it paired
    // with a bare `exit 0` — which no forbidden-token assertion sees — to make
    // the suppression live. Two individually defensible entries composed into
    // the defect. `timeout-minutes` stays: a timed-out step FAILS the job, so
    // it cannot green-wash (verified — `timeout-minutes: 0.0001` fails, which is
    // the point of allow-listing it).
    const inert = new Set(["name", "run", "id", "working-directory", "timeout-minutes", "env"]);
    expect(
      Object.keys(step).filter((key) => !inert.has(key)),
      "the hash-binding step carries a key that can suppress or skip it; if that key is " +
        "inert, add it to the allow-list with its reason, and if it is not, the check " +
        "no longer gates and the merge is unblocked with it inert",
    ).toEqual([]);
    expect(
      (step as { "continue-on-error"?: unknown })["continue-on-error"],
      "continue-on-error turns a hash mismatch into a green run",
    ).toBeUndefined();
    // Unconditional. A docs-only pull request must not skip it: the manifest is
    // not application code, and a stale-hash bump reaches this workflow on a
    // change that `docs-only.ts` would call docs-only (the pin line lives in a
    // header-carrying requirements file the docs detector never reads).
    expect(step.if, "the hash binding must hold on every pull request").toBeUndefined();
    // The `run:` block is EXACTLY the one pip invocation: a `pip download`
    // line, its continuation lines, and nothing else. Asserting the shape
    // rather than a list of forbidden tokens is what closes the shell routes,
    // because every one of them adds a line or a suffix — `set +e` above it,
    // `exit 0` below it, `|| true` on it, a trailing `&`. A denylist of
    // status-masking spellings is a guess about a language; "nothing but the
    // command" is a property of the command.
    //
    // `set +e` is the one that made any of this necessary rather than merely
    // tidy: Actions runs an unset `shell:` as `bash --noprofile --norc -eo
    // pipefail {0}`, and `set +e` switches off the `-e` the runner supplies, so
    // the failing download no longer aborts the block and the last command's
    // status becomes the step's. Measured here: `set +e; false; echo done` exits
    // 0 under the default shell, and `false; exit 0` exits 0 under a custom
    // shell string. Both were live, and both were green against a denylist.
    //
    // The assertion is STRUCTURAL: the block is split on shell control
    // operators and must be exactly one command. Two earlier attempts were
    // denylists over spellings — `/\|\||&/`, then a per-line shape check — and
    // each was defeated by an operator it had not enumerated, `;` among them.
    // The set here is closed instead. In POSIX sh a command sequence is joined
    // only by `;`, `&`, `&&`, `||`, `|`, `|&`, and newline; there is nothing
    // else, so a block whose segments number one cannot have had its exit
    // status diverted by any of them — including ones nobody thought to list,
    // and including `2>&1`, which no longer needs a sanctioned escape because
    // it is not an operator that starts a second command. The flag lines are
    // line-continuations of that one command, so they are joined before
    // splitting rather than counted as commands of their own.
    //
    // What this does NOT settle, and is not claimed to: the shell the block runs
    // under. That is the other half of the composition, and it is a KEY
    // (`shell:`, or a `defaults.run.shell` at job or workflow level) rather
    // than anything inside the block — which is why `shell` is not allow-listed
    // on the step and why the job case below bans `defaults`. Two individually
    // defensible halves, each green on its own, composed into a live
    // suppression; the guard now constrains both or neither is claimed.
    const segments = shellCommands(step.run!);
    expect(
      segments,
      "the run block must be exactly one shell command — the pip download with its " +
        "continuation flags. A second command (a leading `set +e`, a trailing `exit 0`, a " +
        "`| tee`) can report success whatever pip returned.",
    ).toHaveLength(1);
    expect(
      segments[0],
      "the one command must be the pip download itself",
    ).toMatch(/^pip download\b/);
    // After the checkout, so it reads the request's tree rather than an empty
    // workspace: this is the whole property actionlint.yml lacks.
    const checkout = suite.steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    expect(suite.steps.indexOf(step)).toBeGreaterThan(checkout);
    // No secret and no environment: `pip download` against PyPI needs neither,
    // and this workflow's read-only-token, no-secret property is what makes
    // running the request's own bytes here acceptable at all.
    expect(step.env, "the step must not need a token").toBeUndefined();
  });

  // The step-level case above cannot see the job it sits in, and a job-level
  // suppression is the cheapest possible greenwash of the same check:
  // `continue-on-error: true` on the job makes a failed job green, and
  // `if: github.event_name == 'push'` skips the whole suite on pull requests.
  // Both were live and both were green against every assertion in this file,
  // and a 419-test sweep of the CI-workflow suites saw neither. The premise
  // this file's other case asserts is about the WORKFLOW — "the hash binding
  // must hold on every pull request" — so it has to hold of the job too.
  //
  // Carried to the job as the SAME whole-key-set allow-list the step case uses,
  // rather than as a third and fourth named key. That generalization is the
  // point: this repository already holds a top-level allow-list in
  // `tests/ci/concurrency.test.ts`, which demonstrably reds on a WORKFLOW-level
  // `defaults:` — so the one spelling nobody read was the JOB-level one, exactly
  // the asymmetry that let `defaults.run.shell` + a one-line `run: …; exit 0`
  // through the guard file, a 420-test sweep, actionlint and zizmor while being a
  // live suppression. An allow-list at the outer scope is the most dangerous
  // evidence of coverage at the inner one: it shows the key is policed SOMEWHERE,
  // and the somewhere is rarely where the next reader looks.
  //
  // `needs` is banned for the same reason and is not hypothetical: a
  // `needs:` naming a job that does not exist is a third job-scope gating key,
  // and it survives the sweep. Its liveness needs a real Actions run to establish,
  // which this file does not have — so it is closed by assertion rather than
  // left as an open question.
  it("carries no job-level suppression on the suite job", () => {
    const jobInert = new Set([
      "name",
      "runs-on",
      "timeout-minutes",
      "env",
      "services",
      "steps",
    ]);
    expect(
      Object.keys(suite).filter((key) => !jobInert.has(key)),
      "the suite job carries a key that can suppress or skip the whole job — a " +
        "`defaults.run.shell` reinterprets how every step's run block executes, a `needs` " +
        "conditions the job at all, `if`/`continue-on-error` skip or excuse it. If the key " +
        "is inert, allow-list it here with its reason; if it is not, the hash binding no " +
        "longer gates anything.",
    ).toEqual([]);
    // Named, as defence in depth: the allow-list stops a key being ADDED, and
    // these stop the two most likely suppressions being allow-listed away later.
    expect(
      (suite as { "continue-on-error"?: unknown })["continue-on-error"],
      "continue-on-error on the suite job makes a failed suite green, so a hash mismatch " +
        "would never reach verify",
    ).toBeUndefined();
    expect(
      suite.if,
      "a conditional on the suite job skips the whole suite on pull requests, which is where " +
        "the hash binding has to hold",
    ).toBeUndefined();
  });

  it("verifies the manifest with a Python pinned by commit SHA, never a floating tag", () => {
    const setups = suite.steps.filter((s) => (s.uses ?? "").startsWith("actions/setup-python@"));
    expect(setups).toHaveLength(1);
    // Same pin actionlint.yml installs zizmor with, so the two legs cannot
    // drift apart in what "the pinned python" means. Full SHA, never a floating
    // tag: a tag would let the pull request's own definition choose the
    // interpreter that judges it. The parsed `uses` carries no comment, so the
    // version comment is asserted against the raw source — which is also what
    // zizmor's ref-version-mismatch audit reads, and what this repository's own
    // pin-annotation case requires.
    expect(setups[0]!.uses).toBe(
      "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    );
    expect(source).toContain(
      "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0",
    );
    expect(setups[0]!.with?.["python-version"]).toBe("3.13");
    // The hash-binding step must run on THIS interpreter, so the pinned python
    // is installed before it.
    expect(suite.steps.indexOf(setups[0]!)).toBeLessThan(
      suite.steps.indexOf(stepRunning("--require-hashes")),
    );
  });

  it("is shipped: the deny-by-default ignore file names it back", () => {
    const result = spawnSync("git", ["check-ignore", "-q", PATH], { encoding: "utf8" });
    expect(result.status).toBe(1);
  });
});
