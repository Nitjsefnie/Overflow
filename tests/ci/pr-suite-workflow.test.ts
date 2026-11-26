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

type Step = { name?: string; id?: string; if?: string; uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> };

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

beforeAll(async () => { source = await readFile(resolve(PATH), "utf8"); workflow = parse(source) as Workflow; suite = workflow.jobs.suite!; });

function runs(): string[] { return suite.steps.flatMap((step) => (step.run ? [step.run] : [])); }

function stepRunning(command: string): Step {
  const matching = suite.steps.filter((step) => (step.run ?? "").includes(command));
  expect(matching.map((step) => step.name), `exactly one step runs ${command}`).toHaveLength(1);
  return matching[0]!;
}

/**
 * What a step IS, for the purpose of pinning an ordered list of them: the
 * pinned action, or the whole run block on one line. Deliberately the full
 * text rather than its first word — an identity a rename can satisfy is not an
 * identity, which is the defect the step-list assertion below exists to catch.
 */
function stepIdentity(step: Step): string {
  return step.uses ?? `run ${(step.run ?? "").trim().replace(/\s+/g, " ")}`;
}

/**
 * Join a `\`+newline line CONTINUATION, keeping the literal backslashes of an
 * even run.
 *
 * POSIX reads a backslash run before a newline as a continuation only when its
 * length is ODD: the last backslash escapes the newline, and an even run leaves
 * an escaped backslash with a REAL newline separator still in play. Matching the
 * last backslash of the run cannot see that difference — `/\\\r?\n/g` happily
 * joins `\\`+newline, so a block the shell runs as two commands parses as one.
 * Counting the run is the whole of the fix; what is left of an odd run (its even
 * prefix) is what the shell would carry as a literal backslash.
 */
function joinContinuations(block: string): string {
  return block.replace(/\\+\r?\n/g, (run) => {
    const backslashes = run.replace(/\r?\n$/, "");
    // An odd run is pairs (one literal backslash each) plus the one that eats
    // the newline; those pairs are what the shell carries into the argument.
    return backslashes.length % 2 === 1
      ? `${"\\".repeat((backslashes.length - 1) / 2)} `
      : run;
  });
}

/**
 * Split a `run:` block into the shell commands it would execute.
 *
 * The operator set is closed rather than denylisted, which is the whole point:
 * in POSIX sh a command list is separated only by `;`, `&`, `&&`, `||`, `|`,
 * `|&`, and newline. Every one of those starts a second command, so a block that
 * yields a single segment cannot have had its exit status diverted by any of
 * them. A `\`+newline is a line CONTINUATION, not a separator, so it is joined
 * first (by `joinContinuations`, which is where the parity lives) — that is what
 * keeps the committed three-line block one command rather than three.
 *
 * Deliberately not a shell parser: it does not expand variables, honour
 * subshells, or resolve quoting rules beyond not splitting inside quotes and not
 * mistaking a redirection's `&` for a separator. It answers one question — is
 * there anything here but the one command — and a block that needed more than
 * that to pass would not be one this repository should be running untrusted.
 */
function shellCommands(block: string): string[] {
  const joined = joinContinuations(block);
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
    // guard reds on a legitimate, harmless line.
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

/**
 * Split one command into the argument words the shell would pass to it.
 *
 * Quoting and backslash escapes are honoured and then removed, because the
 * assertion this feeds compares the words a command IS against the words it is
 * supposed to be — so `--dest "x"` and `--dest x` are the same invocation, and
 * `$(rm -rf .github)` is not a word at all but three. Not a shell parser: no
 * expansion, so `${RUNNER_TEMP}` is carried as written, which is the correct
 * granularity here — the assertion is about the command's SHAPE on the page, not
 * about what the environment turns it into.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && char === "\\") {
        // Inside double quotes POSIX treats `\` as an escape for exactly FIVE
        // characters — `$`, a backtick, `"`, `\` and newline — and as a literal
        // backslash for anything else. Honouring it for every character is how
        // this helper came to agree with a spelling bash does not: it read
        // `--dest "…hash\-check"` as the committed path while bash passes a name
        // with a backslash in it. Measured: bash delivers
        // `</zizmor-hash\-check>` where the word list expected
        // `${RUNNER_TEMP}/zizmor-hash-check`.
        const next = command[index + 1];
        if (next !== undefined && "$`\"\\\n".includes(next)) {
          // An escaped newline is a line continuation: it contributes nothing.
          // In the guard's own call path this case is already consumed upstream
          // by `joinContinuations`, which is quote-blind; the divergence it
          // leaves is a space where bash has none, so it reds the word equality
          // rather than passing it — the fail-closed direction.
          if (next !== "\n") word += next;
          index += 1;
        } else {
          word += "\\";
        }
        started = true;
        continue;
      }
      word += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === "\\") {
      index += 1;
      word += command[index] ?? "";
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
      continue;
    }
    word += char;
    started = true;
  }
  if (started) words.push(word);
  return words;
}

describe("the shell parser the hash-binding case reads", () => {
  /**
   * A backslash run of `slashes` before a newline, then `tail` on its own line.
   * Built by repetition because the whole point is the run's PARITY, and a
   * literal spelled by hand is exactly where that parity goes wrong.
   */
  const continued = (slashes: number, tail: string): string =>
    `pip download --no-deps --require-hashes${"\\".repeat(slashes)}\n${tail}`;

  // [block, how many commands the shell runs it as]
  const OPERATOR_TABLE: ReadonlyArray<readonly [string, number]> = [
    // Continuations. Odd runs join, even runs are an escaped backslash plus a
    // REAL separator — the second half of this pair, the real separator, is the case under test.
    [continued(1, "  --no-deps"), 1],
    [continued(2, "exit 0"), 2],
    [continued(3, "  --no-deps"), 1],
    [continued(4, "exit 0"), 2],
    ["pip download \\\r\n  --no-deps", 1],
    // The separators. Every one of these starts a second command, which is why
    // "exactly one segment" is a property rather than a denylist.
    ["pip download; exit 0", 2],
    ["pip download && exit 0", 2],
    ["pip download || exit 0", 2],
    ["pip download | tee log", 2],
    ["pip download |& tee log", 2],
    ["pip download &\nexit 0", 2],
    ["pip download\nexit 0", 2],
    ["set +e\npip download", 2],
    // Not separators: a redirection's `&`, and anything inside quotes.
    ["pip download 2>&1", 1],
    ["pip download &> log", 1],
    ['pip download --dest "a; b"', 1],
    ['pip download --dest "a b" --no-deps', 1],
    ["pip\\ download --no-deps", 1],
  ];

  for (const [block, expected] of OPERATOR_TABLE) {
    it(`reads ${JSON.stringify(block)} as ${expected} command${expected === 1 ? "" : "s"}`, () => {
      expect(shellCommands(block)).toHaveLength(expected);
    });
  }

  // An odd run of three is `\` (a literal backslash the shell carries into the
  // argument) plus a continuation, and the join must preserve the first half —
  // replacing the whole run with a space would hide a stray `\` argument. The
  // tail carries no indent here so the expected segment has one space in it.
  it("carries the literal backslash of an odd run longer than one", () => {
    expect(shellCommands(continued(3, "--no-deps"))).toEqual([
      "pip download --no-deps --require-hashes\\ --no-deps",
    ]);
  });

  it("reads the committed block as the one command it is", () => {
    expect(shellCommands(stepRunning("--require-hashes").run!)).toHaveLength(1);
  });

  // The normalising half of the word comparison, pinned. Its whole value is
  // agreeing with the shell about which spellings are the SAME invocation, so
  // the boundary of each rule is the thing to test — not its happy path. Both
  // rows below marked `bash` were measured against
  // `bash --noprofile --norc -eo pipefail -c 'printf "<%s>\n" …'` rather than
  // read out of the manual, and the second pair is a spelling the helper must
  // not read as the committed word, because the shell does not deliver it.
  const WORD_TABLE: ReadonlyArray<readonly [string, string[], string]> = [
    ['pip download --no-deps', ["pip", "download", "--no-deps"], "plain"],
    ['pip "download" --no-deps', ["pip", "download", "--no-deps"], "quoted word"],
    ["pip 'download' --no-deps", ["pip", "download", "--no-deps"], "single quotes"],
    ['pip download --dest "a b"', ["pip", "download", "--dest", "a b"], "quoted space"],
    ['pip download --dest "a;b"', ["pip", "download", "--dest", "a;b"], "quoted separator"],
    ["pip\\ download --no-deps", ["pip download", "--no-deps"], "escaped space"],
    ['pip download --dest "a"b', ["pip", "download", "--dest", "ab"], "empty quotes join"],
    ['pip download --dest "$HOME"', ["pip", "download", "--dest", "$HOME"], "not expanded"],
    ['pip download --dest "\\$HOME"', ["pip", "download", "--dest", "$HOME"], 'escape "$"'],
    ['pip download --dest "\\"q\\""', ["pip", "download", "--dest", '"q"'], 'escape `"`'],
    ["pip download --dest '\\$'", ["pip", "download", "--dest", "\\$"], "single quotes literal"],
    // The five escapes inside double quotes, and one that is not one.
    ['pip download "a\\$b"', ["pip", "download", "a$b"], 'escape `$`'],
    ['pip download "a\\`b"', ["pip", "download", "a`b"], "escape backtick"],
    ['pip download "a\\\\b"', ["pip", "download", "a\\b"], "escape `\\`"],
    ['pip download "a\\\nb"', ["pip", "download", "ab"], "escape newline"],
    ['pip download "a\\tb"', ["pip", "download", "a\\tb"], "bash: `\\t` keeps both"],
    ['pip download "a\\-b"', ["pip", "download", "a\\-b"], "bash: `\\-` keeps both"],
  ];

  for (const [command, words, note] of WORD_TABLE) {
    it(`reads ${JSON.stringify(command)} as ${words.length} word(s) — ${note}`, () => {
      expect(shellWords(command)).toEqual(words);
    });
  }
});

describe("the pull request suite workflow", () => {
  it("is named `pr suite`, the name ci-pr.yml keys on", async () => {
    expect(workflow.name).toBe("pr suite");
    const verify = parse(
      await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8"),
    ) as { on: { workflow_run: { workflows: string[] } } };
    expect(verify.on.workflow_run.workflows).toEqual([workflow.name]);
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
      for (const grant of Object.values(job.permissions ?? {})) {
        expect(grant, "a job-level block may only read").toBe("read");
      }
      expect(job.environment).toBeUndefined();
    }
    expect(source).not.toMatch(/:\s*write\b/);
  });

  it("names no job after a required context", async () => {
    // A pin may name several files, so the value type is the accurate one: a
    // `Record<string, string>` annotation would misstate that.
    const requiredChecks: Record<string, string | string[]> = JSON.parse(
      await readFile(resolve(".github/required-checks.json"), "utf8"),
    );
    const required = Object.keys(requiredChecks);
    expect(required.sort()).toEqual([
      "actionlint",
      "comment-share",
      "dependency-audit",
      "ratchet-guard",
      "secret-scan",
      "size-baseline",
      "verify",
    ]);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      expect(required).not.toContain(id);
      expect(required).not.toContain(job.name ?? id);
    }
    expect(Object.keys(workflow.jobs)).toEqual(["postgres-image", "plan", "test", "report", "suite"]);
  });

  it("is superseded only by the same pull request's newer push", () => {
    expect(workflow.concurrency).toEqual({
      group: "pr-suite-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
  });

  it("checks out exactly once", () => {
    const checkouts = suite.steps.filter((step) => (step.uses ?? "").startsWith("actions/checkout@"));
    expect(checkouts).toHaveLength(1);
    expect(suite["timeout-minutes"]).toBe(45);
  });

  it("runs the SQL statement budget gate beside geometry after database migration", () => {
    const checks = suite.steps.filter((step) => step.name === "SQL statement budget check");
    expect(checks).toHaveLength(1);
    const step = checks[0]!;
    expect(step.run).toBe("node scripts/check-perf-budget.ts");
    const migration = suite.steps.findIndex((entry) => entry.name === "Apply PostgreSQL migrations");
    expect(migration).toBeGreaterThan(-1);
    expect(suite.steps.indexOf(step)).toBeGreaterThan(migration);
    expect(Math.abs(suite.steps.indexOf(step) - suite.steps.findIndex((entry) => entry.name === "Page geometry check"))).toBe(1);
    expect(step.if).toBeUndefined();
    expect((step as { "continue-on-error"?: unknown })["continue-on-error"]).toBeFalsy();
  });

  it("runs the prerender check after the production build, beside geometry, as a required gate", () => {
    const checks = suite.steps.filter((step) => step.name === "Prerendered routes check");
    expect(checks).toHaveLength(1);
    const step = checks[0]!;
    expect(step.run).toBe("node scripts/check-prerendered-routes.ts");
    const build = suite.steps.findIndex((entry) => entry.name === "Production build");
    expect(build).toBeGreaterThan(-1);
    expect(suite.steps.indexOf(step)).toBeGreaterThan(build);
    expect(Math.abs(suite.steps.indexOf(step) - suite.steps.findIndex((entry) => entry.name === "Page geometry check"))).toBe(1);
    expect(step.if).toBeUndefined();
    expect((step as { "continue-on-error"?: unknown })["continue-on-error"]).toBeFalsy();
  });

  it("runs page geometry unconditionally and propagates its failure", () => {
    const checks = suite.steps.filter((step) => step.name === "Page geometry check");
    expect(checks).toHaveLength(1);
    const step = checks[0]!;
    expect(step.run).toBe("node scripts/check-page-geometry.mjs");
    expect(step.if).toBeUndefined();
    expect((step as { "continue-on-error"?: unknown })["continue-on-error"]).toBeFalsy();
  });

  it("runs every code check verify ran for a pull request, in order", () => {
    const order = [
      "corepack install --global pnpm@",
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
      "node scripts/check-prerendered-routes.ts",
      "node scripts/check-page-geometry.mjs",
      "node scripts/check-perf-budget.ts",
    ];
    const indices = order.map((command) => suite.steps.indexOf(stepRunning(command)));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(suite.env).toEqual(expect.objectContaining({
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      npm_config_registry: "https://registry.npmjs.org/",
      OVERFLOW_DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
    }));
    // The job's environment is an exact SET, for the same reason the step's keys
    // and the job's keys are: an environment every step inherits is an input to
    // every step, and one arbitrary key there was measured defeating the hash
    // binding outright. `PIP_NO_INDEX=1` plus `PIP_FIND_LINKS=<a directory in
    // the pull request>` moves pip off the index, and the run then passes against
    // a manifest whose digest is that directory's wheel and nothing to do with
    // PyPI's record — measured, rc=0, `Successfully downloaded zizmor`, with the
    // manifest carrying a hash pip had never seen. `objectContaining` above
    // fixes the values that must be present and says nothing about the ones
    // that may be, so on its own it lets such a key through.
    //
    // The check's whole value is that the hashes come from OUTSIDE the pull
    // request. An environment the pull request can steer is another way to put
    // them back inside it, so the job's `env` is held to an exact set like the
    // shell and `defaults` at job scope.
    expect(
      Object.keys(suite.env ?? {}).sort(),
      "the suite job's environment is an input to every step, so its key set is pinned " +
        "exactly: a pip-resolving key (`PIP_FIND_LINKS`, `PIP_NO_INDEX`, `PIP_INDEX_URL`, " +
        "`PIP_CONFIG_FILE`) there lets the pull request supply the artifact the hashes are " +
        "checked against. Add a key here deliberately, with its reason.",
    ).toEqual([
      "AUTH_GITHUB_ID",
      "AUTH_GITHUB_SECRET",
      "AUTH_SECRET",
      "COREPACK_ENABLE_PROJECT_SPEC",
      "OVERFLOW_APP_URL",
      "OVERFLOW_DATABASE_URL",
      "OVERFLOW_GITHUB_WEBHOOK_URL",
      "OVERFLOW_MODERATOR_GITHUB_USER_IDS",
      "OVERFLOW_TOKEN_ENCRYPTION_KEY",
      "npm_config_registry",
    ]);
  });

  it("judges nothing: no gate script whose verdict verify owns runs here", () => {
    for (const gate of [
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
  // has no other home. actionlint.yml is the only other place it runs, and that leg is
  // pull_request_target with no `ref:`, so it installs MAIN's manifest, never
  // the pull request's. Without this step a Dependabot bump carrying the previous
  // release's hashes passes every other pull-request check and goes red only on
  // the push to main. This step is the pre-merge home, and it is here
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
    // Asserting `if` alone is not enough: it pins the absence of ONE
    // suppression key and leaves its siblings unpinned, so `continue-on-error:
    // true` — or a `|| true` appended to the command — would leave this case
    // green while the run concludes `success`, `await-pr-suite.ts` returns 0
    // and the merge goes through with the check inert. That is the same
    // failure this case exists to prevent, reached by a different key, so the
    // assertion is over the whole key set: anything not in the allow-list
    // below has to be added here deliberately, with its reason, rather than
    // slipped in beside the command.
    //
    // `shell` is NOT allow-listed, and its absence is the point rather than an
    // oversight. `shell: bash` and `shell: sh` are inert (GitHub maps both to
    // a `-e` form), but any custom string is not: GitHub runs it verbatim with
    // no `-e`. Allow-listed, it pairs with a bare `exit 0` — which no
    // forbidden-token assertion sees — to make the suppression live, so two
    // individually defensible entries compose into the defect.
    // `timeout-minutes` stays: a timed-out step FAILS the job, so it cannot
    // green-wash (verified — `timeout-minutes: 0.0001` fails, which is the
    // point of allow-listing it).
    //
    // `working-directory` is NOT allow-listed either, and its absence is pinned
    // by name below. The step's `-r` path is relative, so the key decides
    // WHICH requirements file pip reads. Pointed at a directory carrying a
    // committed, self-consistent shadow `.github/requirements-zizmor.txt`, the
    // step resolves and checksums bytes the pull request authored while the
    // tree's pinned manifest is never read — every property this case pins
    // stays green against it (measured: the key planted alone passed this file
    // 51/51) — and the check reports success without having bound anything.
    // Dependabot cannot emit the key, but the guard is not written against one
    // sender.
    const inert = new Set(["name", "run", "id", "timeout-minutes", "env"]);
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
    expect(
      (step as { "working-directory"?: unknown })["working-directory"],
      "the -r path is relative, so working-directory chooses which requirements " +
        "file pip reads; a shadow manifest under it greens this step without the " +
        "pinned manifest ever being read",
    ).toBeUndefined();
    // Unconditional: the manifest is not application code, so no condition on
    // the change may skip it.
    expect(step.if, "the hash binding must hold on every pull request").toBeUndefined();
    // The `run:` block is EXACTLY the one pip invocation: a `pip download`
    // line, its continuation lines, and nothing else. Asserting the shape
    // rather than a list of forbidden tokens is what closes the shell routes,
    // because every one of them adds a line or a suffix — `set +e` above it,
    // `exit 0` below it, `|| true` on it, a trailing `&`. A denylist of
    // status-masking spellings is a guess about a language; "nothing but the
    // command" is a property of the command.
    //
    // `set +e` is the one that makes any of this necessary rather than merely
    // tidy: Actions runs an unset `shell:` as `bash --noprofile --norc -eo
    // pipefail {0}`, and `set +e` switches off the `-e` the runner supplies, so
    // the failing download does not abort the block and the last command's
    // status becomes the step's. Measured: `set +e; false; echo done` exits 0
    // under the default shell, and `false; exit 0` exits 0 under a custom shell
    // string, and both pass a denylist of spellings.
    //
    // The assertion is STRUCTURAL: the block is split on shell control
    // operators and must be exactly one command. A denylist over spellings is
    // defeated by any operator it has not enumerated, `;` among them, so the
    // set here is closed instead. In POSIX sh a command sequence is joined
    // only by `;`, `&`, `&&`, `||`, `|`, `|&`, and newline; there is nothing
    // else, so a block whose segments number one cannot have had its exit
    // status diverted by any of them — including ones nobody thought to list,
    // and including `2>&1`, which needs no sanctioned escape because it is not
    // an operator that starts a second command. The flag lines are
    // line-continuations of that one command, so they are joined before
    // splitting rather than counted as commands of their own — and only an ODD
    // backslash run is a continuation at all, which is why `joinContinuations`
    // counts the run rather than matching its last backslash. An even run is an
    // escaped backslash with a REAL newline after it, and joining that calls a
    // two-command block one command (measured); `pip download` happens to
    // reject the stray `\` argument it leaves behind, but a guarantee that rests
    // on another program's argument parser is not this assertion's, so the
    // parity is fixed here.
    //
    // What this does NOT settle, and is not claimed to: the shell the block runs
    // under. That is the other half of the composition, and it is a KEY
    // (`shell:`, or a `defaults.run.shell` at job or workflow level) rather
    // than anything inside the block — which is why `shell` is not allow-listed
    // on the step and why the job case below bans `defaults`. Two individually
    // defensible halves, each green on its own, compose into a live
    // suppression; the guard constrains both.
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
    // ...and its CONTENT, structurally, by the same standard. "One command" is
    // a claim about how many commands run; it says nothing about WHICH, and a
    // structural assertion constrains only the axes it measures.
    //
    // So this asserts what the command IS rather than enumerating what it must
    // not contain: the argument words, in order, by equality against the one
    // invocation this step exists to run. A second `-r`, a `--hash=` that would
    // forgive a stale manifest outright, a `-c`, a `--version`, a `$(…)` — none
    // is named here and none survives, because a word that is not in the list
    // fails the comparison whether or not anyone thought of it. That is the
    // operator set's argument applied to the argument list: enumerate the
    // ATTACKS and the list is always short one; enumerate the COMMAND and it is
    // finite on the first try.
    //
    // Strictly stronger than a line rule accepting ANY `--anything` on any
    // continuation line — which would admit a second `--require-hashes`
    // argument and any `--hash=` — so adding that rule as well would only add a
    // weaker duplicate. The comparison is only as sound as the word split it
    // compares: `--dest "…hash\-check"` must be split the way the shell delivers
    // it (`\` inside double quotes is an escape in POSIX for five characters,
    // not for any). `shellWords` does that, pinned by its table.
    //
    // The words are compared with quoting and escaping already resolved
    // (`shellWords`), so `--dest x` and `--dest "x"` are the same invocation
    // and do not each need their own assertion. `${RUNNER_TEMP}` is compared as
    // written: the assertion is about the command on the page, and expanding it
    // here would assert against a runner's environment rather than the workflow.
    expect(
      shellWords(segments[0]!),
      "the one command must be exactly the pip download this step exists to run — " +
        "no extra argument of any kind, on any line. `--hash=` would forgive a stale " +
        "manifest outright, a second `-r` or a `-c` re-points what is checked, and a " +
        "`$(…)` runs before pip does. Add an argument only here, with its reason.",
    ).toEqual([
      "pip",
      "download",
      "--no-deps",
      "--require-hashes",
      "--dest",
      "${RUNNER_TEMP}/zizmor-hash-check",
      "-r",
      ".github/requirements-zizmor.txt",
    ]);
    // After the checkout, so it reads the request's tree rather than an empty
    // workspace: this is the whole property actionlint.yml lacks.
    const checkout = suite.steps.findIndex((s) => (s.uses ?? "").startsWith("actions/checkout@"));
    expect(suite.steps.indexOf(step)).toBeGreaterThan(checkout);
    // ...and nothing at all runs between the checkout and it. Position alone is
    // not the property; the LIST is. `expect(…).toBeGreaterThan(checkout)` says
    // "somewhere later", which is satisfied by a step inserted anywhere in
    // between — and an earlier step is the cheapest way to stop this check
    // binding. Four spellings, each planted on this workflow and each green
    // against everything else in this file and in a 440-test CI-workflow sweep:
    //
    //   * `pip config set global.no-index true` + `global.find-links <dir>`
    //   * `echo "PIP_NO_INDEX=1" >> $GITHUB_ENV` (and the same for find-links)
    //   * `sed -i` rewriting the manifest the step reads
    //   * `run: echo hello` — nothing pip-shaped at all, which is what shows the
    //     gap is the step list and not the shape of a step
    //
    // The first is LIVE, measured: with a manifest carrying 1.29.0's eleven real
    // hashes plus one hash of a wheel the pull request ships in its own tree,
    // the control run is rc=1 and the primed run is rc=0 —
    // `Successfully downloaded zizmor`, resolved from the request's directory.
    // Pinned zizmor and the pinned actionlint report nothing on any of them.
    //
    // So the job's prefix is pinned as an ordered list of identities: the three
    // actions, by identity — the normaliser folds any revision to `@`, so a
    // same-family bump alone does not red this. Insert a step, reorder, remove
    // one, or swap an action, and this reds with the diff of the list.
    expect(
      suite.steps.slice(0, suite.steps.indexOf(step))
        .map((s) => stepIdentity(s).replace(/@[0-9a-f]{40}$/, "@")),
      "nothing may run between the checkout and the hash binding: an earlier step can prime " +
        "pip's resolver (`pip config set`, `>> $GITHUB_ENV`) or rewrite the manifest itself, " +
        "and then the check reports success whatever PyPI's record says. Add a step here " +
        "deliberately, with its reason.",
    ).toEqual([
      "actions/checkout@",
      "actions/setup-node@",
      "actions/setup-python@",
    ]);
    // No secret and no environment: `pip download` against PyPI needs neither,
    // and this workflow's read-only-token, no-secret property is what makes
    // running the request's own bytes here acceptable at all.
    expect(step.env, "the step must not need a token").toBeUndefined();
  });

  // The step-level case above cannot see the job it sits in, and a job-level
  // suppression is the cheapest possible greenwash of the same check:
  // `continue-on-error: true` on the job makes a failed job green, and
  // `if: github.event_name == 'push'` skips the whole suite on pull requests.
  // Both are live and both pass every other assertion in this file, and a
  // 419-test sweep of the CI-workflow suites sees neither. The premise this
  // file's other case asserts is about the WORKFLOW — "the hash binding must
  // hold on every pull request" — so it has to hold of the job too.
  //
  // Carried to the job as the SAME whole-key-set allow-list the step case uses,
  // rather than as a third and fourth named key. That generalization is the
  // point: this repository already holds a top-level allow-list in
  // `tests/ci/concurrency.test.ts`, which demonstrably reds on a WORKFLOW-level
  // `defaults:`, so the JOB-level spelling needs the same coverage: a
  // `defaults.run.shell` with a one-line `run: …; exit 0` is a live suppression
  // that passes the guard file without this case, a 420-test sweep, actionlint
  // and zizmor. An allow-list at the outer scope is the most dangerous
  // evidence of coverage at the inner one: it shows the key is policed
  // SOMEWHERE, and the somewhere is rarely where the next reader looks.
  //
  // `needs` is allowed: the postgres-image job's output feeds the service
  // image, and the reason it is safe is woven into the assertion's failure
  // message below — `needs` is an ordering key, the suite still runs
  // unconditionally (no `if`), and the hazard of a `needs` naming a nonexistent
  // job is closed by the jobs key-set pin plus actionlint's needs-reference
  // validation.
  it("carries no job-level suppression on the suite job", () => {
    const jobInert = new Set([
      "name",
      "runs-on",
      "timeout-minutes",
      "env",
      "services",
      "steps",
      // Ordering key, not a suppression — the failure message carries the reason.
      "needs",
    ]);
    expect(
      Object.keys(suite).filter((key) => !jobInert.has(key)),
      "the suite job carries a key that can suppress or skip the whole job — a " +
        "`defaults.run.shell` reinterprets how every step's run block executes, and " +
        "`if`/`continue-on-error` skip or excuse it. `needs` is an ordering key, not a " +
        "suppression: the suite still runs unconditionally (the `if` assertion below holds " +
        "that), and the nonexistent-job hazard the original ban guarded against is closed by " +
        "the jobs key-set pin plus actionlint's needs-reference validation. If the key " +
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

  it("verifies the manifest with a Python the workflow installs, ordered before the hash-binding step", () => {
    const setups = suite.steps.filter((s) => (s.uses ?? "").startsWith("actions/setup-python@"));
    expect(setups).toHaveLength(1);
    // The hash-binding step must run on the interpreter this step installs,
    // so the setup step is ordered before it.
    expect(suite.steps.indexOf(setups[0]!)).toBeLessThan(
      suite.steps.indexOf(stepRunning("--require-hashes")),
    );
  });

  it("is shipped: the deny-by-default ignore file names it back", () => {
    const result = spawnSync("git", ["check-ignore", "-q", PATH], { encoding: "utf8" });
    expect(result.status).toBe(1);
  });
});
