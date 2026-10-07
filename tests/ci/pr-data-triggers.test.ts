import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * Issue 1090: no job that fetches or reads pull-request data may live in a
 * workflow a PRIVILEGED trigger can start.
 *
 * `workflow_dispatch`, `schedule` and `push` run a workflow from the default
 * branch with the default branch's privileges, so a pull request's content
 * entering one of those jobs is untrusted content running with privileges a
 * contributor does not hold. CodeQL says so out loud: the
 * `actions/cache-poisoning/poisonable-step` and `actions/untrusted-checkout`
 * alerts on ci.yml, actionlint.yml, ratchet-guard.yml and secret-scan.yml are
 * that shape. Step-level `if: github.event_name == 'pull_request_target'`
 * gates made the paths SAFE, not STRUCTURAL — one guard edit reopened the
 * class, which is why the fix is one file per leg and this test.
 *
 * "Reads pull-request data" is decided from the WORKFLOW TEXT, not from a
 * hand-maintained list of steps or files, because a hand-maintained list is
 * the thing this test exists to replace: it goes stale silently and a new
 * pull-request step lands in no list at all. The rule is the one the analysers
 * apply — a step that both performs a checkout/fetch/pull AND names a
 * PR-derived value.
 *
 * WHAT A STEP CAN SEE. A step's effective text is not only its own `run:`, its
 * `env:` and its `with:`. It also inherits, and each of these is a channel a
 * reviewer found carrying a real violation past the first version of this file:
 *
 *  - the WORKFLOW-level `env:`, and the JOB-level `env:`, both of which apply
 *    to every step of the job;
 *  - the needles of every job reachable through `needs:`, because a value one
 *    job computes from the pull request and exports is readable by the next.
 *
 * Reading only a step's own blocks was the uncontrolled limb: a job-level
 * `env: { PR_NUM: ${{ github.event.pull_request.number }} }` plus a step
 * `run: git fetch … "+refs/${PR_NUM}/head:…"` passed this suite, because the
 * needle was one level above where the rule looked. Both channels are now
 * scanned, and `tests the false-positive direction` below plants the exact
 * shapes so neither can silently stop being read.
 *
 * THE TRIGGER SET IS A CLOSED SET — `set(on) === {pull_request_target}` — not a
 * denylist of privileged events. A denylist passes today and re-arms the class
 * the moment someone adds `repository_dispatch`, `issue_comment` or
 * `workflow_call`, none of which anyone would think to add to a list of the
 * three events that happened to be a problem.
 *
 * THE NEEDLE LIST IS BROAD ON PURPOSE, and a match is not always a real
 * violation. `head_sha`, `head_ref`, `head_branch`, `head.sha` and `head.ref`
 * match a push-only workflow comparing against `github.event.before`, where
 * nothing about the value is pull-request-derived. Narrowing them would let
 * genuine cases through and stop matching the analyser, which is the whole
 * point of reading the analysers' rule. So the list stays broad and the
 * FAILURE MESSAGE names the needle and where it was found, and states both
 * ways to satisfy the rule — move the job into a `pull_request_target`-only
 * workflow, or show that the value is not actually pull-request-derived. The
 * message does not assume a pull-request leg exists, because for a benign
 * workflow there is none to split.
 *
 * SCOPE. This suite reads every workflow in `.github/workflows/` except the
 * ones named in `DEFERRED`. The exclusion is a `Record`, not a `Set`, and it is
 * checked in BOTH directions: a deferred entry that no longer covers a
 * violating file fails this suite, and an exclusion widened past a file that
 * still violates it fails the assertion below it.
 *
 * `DEFERRED` is EMPTY, and that is the end state of issue 1090 rather than a
 * hole: ci.yml was the last workflow a privileged trigger could start a
 * pull-request job in, and Task 3 split it. The empty list is the goal here,
 * which is the opposite of the empty-list failure mode the FORWARD_WIRED sweep
 * below guards against — there an empty control silently stopped being a
 * control, here an empty record means there is nothing left to defer. Re-adding
 * an entry is what would need a reason: the two assertions at the bottom of this
 * file then require it to name a file that exists AND still carries a violation,
 * so an entry can only be re-created against a file the rule would otherwise
 * already refuse.
 *
 * WHAT THIS DETECTOR DOES NOT SEE — two limits, and they are not the same kind
 * of boundary. Neither is fixed here, and the reasons are different, so they
 * are stated separately rather than lumped together as "known gaps".
 *
 * 1. A COMPOSITE ACTION is invisible, and that hole is unreachable today. A
 *    step reading `uses: ./.github/actions/<name>` runs steps whose text lives
 *    in ANOTHER file; `stepText` sees only the `uses:` string. So a composite
 *    that fetched a pull request would not be caught. `.github/actions/` does
 *    not exist in this repository and no workflow uses a local `uses: ./`, so
 *    there is nothing to catch, and the change that would close it is scope
 *    expansion into a hazard this task did not introduce: a composite action
 *    has no `on:` of its own, so the right control is a SEPARATE sweep over
 *    `.github/actions/` keyed on the CALLER's `uses:` line, not a widening of a
 *    trigger pin. If a composite is ever added here, that sweep is the thing
 *    to write first.
 *
 * 2. A pull-request read with NO checkout, fetch or pull at all — `gh pr view`,
 *    an HTTP GET of a diff — is outside this rule, and that is FIDELITY rather
 *    than a gap. The rule is the analysers' own: a step is flagged when it both
 *    performs a checkout/fetch/pull AND names a pull-request value, because
 *    that conjunction is what `actions/cache-poisoning/poisonable-step` and
 *    `actions/untrusted-checkout` describe. Detecting more than the analysers do
 *    would report shapes those tools do not, which is a different (and
 *    separately debatable) question from whether this pin tracks them.
 */

type Block = Record<string, unknown>;
type Step = {
  name?: string;
  /** A real Actions step key, and the one a `needs:` producer's `outputs:` refers to. */
  id?: string;
  uses?: string;
  run?: string;
  env?: Block;
  with?: Block;
};
type Job = {
  env?: Block;
  needs?: string | string[];
  steps?: Step[];
};
type Workflow = {
  name?: string;
  on?: unknown;
  env?: Block;
  jobs?: Record<string, Job>;
};

/**
 * A command that brings pull-request-controlled content into a job's
 * filesystem or ref set. Two arms because GitHub spells the same act two
 * ways: a `run:` block invoking git, and the `actions/checkout` step, which is
 * the checkout the `untrusted-checkout` query reads and which no `run:` block
 * names.
 */
const COMMAND_PATTERNS = [
  /\bgit\b[^\n]*\b(fetch|pull|checkout)\b/,
  /\b(gh|hub)\b[^\n]*\bpr\s+checkout\b/,
  /\bactions\/checkout\b/,
] as const;

/**
 * Every spelling of a pull-request-derived value the analysers treat as
 * pull-request data, verbatim. `pr_number` and `pr_id` are the ENV NAME
 * spellings this repository's own fetch steps use; the dotted forms are the
 * event-context spellings; `head.*`, `merge_ref` and the `check_*` families
 * cover the merge-commit and check-suite shapes. Matching is case-insensitive
 * on both sides, so `PR_NUMBER` and `head.sha` match as themselves.
 *
 * Five of these are broad enough to match a non-pull-request value (`head_sha`
 * is an ordinary name for a push's before-SHA). That is kept, deliberately:
 * see the header. What is NOT kept is a message that then tells the maintainer
 * to split a pull-request leg that does not exist.
 */
const PR_NEEDLES = [
  "refs/pull",
  "event.number",
  "issue.number",
  "pull_request.id",
  "pull_request.number",
  "check_suite.pull_requests",
  "check_run.pull_requests",
  "pr_number",
  "pr_id",
  "head.ref",
  "head_ref",
  "head_branch",
  "merge_ref",
  "pr_head_ref",
  "head.sha",
  "head_sha",
  "head_commit",
  "check_suite.after",
  "merge_commit_sha",
  "merge_sha",
  "pr_head_sha",
] as const;

/** The trigger set the rule requires of any workflow holding a pull-request job. */
const ALLOWED_TRIGGERS = new Set(["pull_request_target"]);

/**
 * Workflows this suite does NOT judge, and why. Every entry is a workflow that
 * TODAY violates the rule below and is split by a later task of issue 1090.
 * The assertion "every deferred entry still covers a violation" is what keeps
 * this list honest in both directions, and it is what made Task 3's removal of
 * the ci.yml entry a step the split had to take rather than a cleanup somebody
 * remembered.
 *
 * EMPTY since issue 1090 Task 3 split ci.yml: that was the last of the four
 * workflows CodeQL reported a privileged-trigger path through. The two
 * assertions at the bottom of this file are kept anyway — they are what a
 * future entry has to satisfy, and they cost nothing while the record is empty.
 */
const DEFERRED: Record<string, string> = {};

/** The `on:` block's event names, whatever shape it is written in. */
function triggerKeys(on: unknown): string[] {
  if (Array.isArray(on)) return on.map(String);
  if (typeof on === "string") return [on];
  if (on && typeof on === "object") return Object.keys(on as object);
  return [];
}

/** The NAMES and string values of a mapping, lowercased, as one blob. */
function blockText(block: Block | undefined): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(block ?? {})) {
    parts.push(name);
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
  }
  return parts.join("\n").toLowerCase();
}

/** A step's OWN text: its run, its action reference, and its env/with names and values. */
function stepText(step: Step): string {
  return [step.run ?? "", step.uses ?? "", blockText(step.env), blockText(step.with)]
    .join("\n")
    .toLowerCase();
}

function needlesIn(text: string): string[] {
  return PR_NEEDLES.filter((needle) => text.includes(needle));
}

/** A command the text names, or "" when it names none. */
function commandIn(text: string): string {
  return COMMAND_PATTERNS.find((pattern) => pattern.test(text))?.source ?? "";
}

/** The job ids a job declares a dependency on, whatever shape `needs:` takes. */
function needsOf(job: Job | undefined): string[] {
  const needs = job?.needs;
  if (typeof needs === "string") return [needs];
  if (Array.isArray(needs)) return needs.map(String);
  return [];
}

/**
 * Every needle a job's OWN configuration and steps carry: its inherited
 * `env:` (workflow-level and job-level) plus each of its steps. This is the set
 * a `needs:`-consumer inherits — a job cannot export a value it never held.
 */
function ownNeedles(workflow: Workflow, jobId: string): string[] {
  const job = workflow.jobs?.[jobId];
  if (job === undefined) return [];
  const text = [
    blockText(workflow.env),
    blockText(job.env),
    ...(job.steps ?? []).map(stepText),
  ].join("\n");
  return needlesIn(text);
}

/**
 * The needles a job inherits through `needs:`, following the chain to its
 * producers. `seen` breaks a cycle, because `needs:` is a DAG by GitHub's own
 * rules but nothing stops a fixture from naming one twice, and a cycle must
 * not hang the suite.
 */
function neededNeedles(workflow: Workflow, jobId: string, seen = new Set<string>()): string[] {
  const found: string[] = [];
  for (const dependency of needsOf(workflow.jobs?.[jobId])) {
    if (seen.has(dependency)) continue;
    seen.add(dependency);
    found.push(...ownNeedles(workflow, dependency));
    found.push(...neededNeedles(workflow, dependency, seen));
  }
  return found;
}

/** Where a needle was found, so the failure message can say. */
type Match = { needle: string; where: string };

/** A file and the jobs in it that read pull-request data. */
type Offence = { file: string; job: string; steps: string[]; matches: Match[] };

/**
 * The jobs of one workflow that read pull-request data, and why.
 *
 * A step counts when it names a checkout/fetch/pull command AND its effective
 * text — its own, plus the env blocks that apply to it, plus what its `needs:`
 * producers hold — names a pull-request needle. The command requirement stays
 * PER STEP: a benign workflow whose job holds a `head_sha` env beside an
 * unrelated `actions/checkout` is not a violation, and making the command
 * per-job would flag it.
 */
function judgeWorkflow(file: string, workflow: Workflow): Offence[] {
  const offences: Offence[] = [];
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    const inherited: Match[] = [
      ...needlesIn(blockText(workflow.env)).map((needle) => ({ needle, where: "the workflow's top-level env:" })),
      ...needlesIn(blockText(job.env)).map((needle) => ({ needle, where: "the job's env:" })),
      ...neededNeedles(workflow, jobId).map((needle) => ({ needle, where: "a job it needs:" })),
    ];
    const steps: string[] = [];
    const matches: Match[] = [];
    for (const step of job.steps ?? []) {
      const text = stepText(step);
      const command = commandIn(text);
      if (command === "") continue;
      const own = needlesIn(text).map((needle) => ({ needle, where: "the step" }));
      if (own.length === 0 && inherited.length === 0) continue;
      steps.push(step.name ?? step.uses ?? step.run ?? "(unnamed step)");
      matches.push(...own, ...inherited);
    }
    if (steps.length === 0) continue;
    offences.push({ file, job: jobId, steps, matches: dedupe(matches) });
  }
  return offences;
}

function dedupe(matches: Match[]): Match[] {
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const match of matches) {
    const key = `${match.needle}@${match.where}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

/** The verdict message, which must not assume a pull-request leg exists. */
function verdict(offence: Offence, workflow: Workflow): string {
  const triggers = triggerKeys(workflow.on);
  const found = offence.matches.map((match) => `${match.needle} (in ${match.where})`).join(", ");
  const prLeg = Object.hasOwn(workflow.on ?? {}, "pull_request_target");
  const move = prLeg
    ? "move this job out of the privileged-trigger workflow and into one whose `on:` is exactly " +
      "{pull_request_target}, which is what issue 1090's split did for the three gates it covered"
    : "move this job into a workflow whose `on:` is exactly {pull_request_target}";
  return (
    `${offence.file}#${offence.job} runs a checkout/fetch/pull in step(s) ` +
    `${offence.steps.join(", ")} and its effective text carries the pull-request-derived ` +
    `needle(s) ${found}, while this file's whole \`on:\` set is ${JSON.stringify(triggers)}. ` +
    `A privileged trigger here runs the workflow from the default branch with the default ` +
    `branch's privileges, so that step is untrusted content entering a privileged job — the ` +
    `shape CodeQL's actions/cache-poisoning/poisonable-step and actions/untrusted-checkout ` +
    `alerts report. There are two ways to satisfy this, and which one is right depends on ` +
    `whether the matched value really is pull-request data: (1) ${move}; or (2) if the value is ` +
    `NOT pull-request-derived — a push-only workflow's github.event.before legitimately reads as ` +
    `head_sha, and the needle list is deliberately broad to match the analysers — then say so ` +
    `in the step's own comment and rename the value so the next reader is not misled. Do not ` +
    `narrow the needle list to make this green.`
  );
}

let files: string[] = [];
let workflows = new Map<string, Workflow>();
let offences: Offence[] = [];

beforeAll(async () => {
  const directory = resolve(".github/workflows");
  files = (await readdir(directory)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml")).sort();
  workflows = new Map();
  offences = [];
  for (const file of files) {
    const workflow = parse(await readFile(resolve(directory, file), "utf8")) as Workflow;
    workflows.set(file, workflow);
    if (Object.hasOwn(DEFERRED, file)) continue;
    offences.push(...judgeWorkflow(file, workflow));
  }
});

describe("the workflow directory this suite reads", () => {
  it("is not empty, so a broken read cannot make every assertion vacuous", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(workflows.size).toBe(files.length);
  });
});

describe("every job that reads pull-request data", () => {
  it("is found — the rule below has something to rule on", () => {
    // The anti-vacuity control. This suite decides "reads pull-request data"
    // from workflow text, so a needle list or a command pattern that stopped
    // matching would make it find nothing and every assertion above it would
    // pass without having checked a thing. A green run of a rule that never
    // fires is the failure mode this exists to catch.
    expect(
      offences.map((offence) => `${offence.file}#${offence.job}`),
      "no workflow in scope carries a step that both runs a checkout/fetch/pull and names a " +
        "pull-request-derived value. Either the split landed and this suite has been left " +
        "pointing at nothing, or the detector has stopped recognising the shape it exists to " +
        "find — and a rule that never fires is not a rule.",
    ).not.toEqual([]);
  });

  it("lives in a workflow whose only trigger is pull_request_target", () => {
    const offenders = offences
      .filter((offence) => {
        const keys = new Set(triggerKeys(workflows.get(offence.file)?.on));
        return keys.size !== ALLOWED_TRIGGERS.size || [...keys].some((key) => !ALLOWED_TRIGGERS.has(key));
      })
      .map((offence) => verdict(offence, workflows.get(offence.file)!));
    expect(offenders.join("\n\n") || "(none)", offenders.length === 0 ? "(none)" : "").toBe("(none)");
  });
});

describe("the detector's own reading scope", () => {
  // Each case below is a violation that a NARROWER reading of the workflow
  // text would miss. They are here because the detector's reading scope is
  // itself a limb: a channel it stops reading is a hole nothing else covers,
  // and this suite is the only thing that would notice it going quiet.
  const judged = (workflow: Workflow) => judgeWorkflow("fixture.yml", workflow);

  it("reads the JOB's own env:, not only each step's", () => {
    // The exact shape that passed the first version of this file: the needle is
    // one level ABOVE the step, in the job's env:, and the step that uses it
    // carries neither. A rule that looked only at `step.env` sees a `git fetch`
    // with no pull-request data beside it and passes.
    const found = judged({
      on: { push: { branches: ["main"] } },
      jobs: {
        "secret-scan": {
          env: { PR_NUM: "${{ github.event.pull_request.number }}" },
          steps: [{ name: "Sync the review ref", run: 'git fetch --no-tags origin "+refs/${PR_NUM}/head:x"' }],
        },
      },
    });
    expect(
      found.map((offence) => `${offence.file}#${offence.job}`),
      "a pull-request number in the job's own env: arms a git fetch in any of its steps",
    ).toEqual(["fixture.yml#secret-scan"]);
    expect(
      found[0]!.matches.map((match) => match.needle),
      "the match must be attributed to the job's env:, which is where it was planted",
    ).toContain("pull_request.number");
  });

  it("reads the WORKFLOW's top-level env:, which applies to every step of every job", () => {
    const found = judged({
      on: { push: { branches: ["main"] } },
      env: { PR_REF: "${{ github.event.pull_request.head.ref }}" },
      jobs: {
        probe: { steps: [{ name: "Fetch", run: 'git fetch --no-tags origin "$PR_REF"' }] },
      },
    });
    expect(found.map((offence) => offence.job)).toEqual(["probe"]);
    expect(found[0]!.matches.map((match) => match.where)).toContain("the workflow's top-level env:");
  });

  it("reads what a job INHERITS through needs:, following the chain", () => {
    // The cross-job shape: one job computes a pull-request ref from the event
    // and exports it; the next fetches it. Neither job's step text mentions
    // `pull_request`, so a per-step rule with no `needs:` edge passes both.
    const found = judged({
      on: { push: { branches: ["main"] } },
      jobs: {
        "resolve-ref": {
          env: { N: "${{ github.event.pull_request.number }}" },
          steps: [{ id: "emit", run: 'echo "ref=refs/pull/$N/head" >> "$GITHUB_OUTPUT"' }],
        },
        probe: {
          needs: ["resolve-ref"],
          steps: [{ name: "Fetch", env: { TARGET: "${{ needs.resolve-ref.outputs.ref }}" }, run: 'git fetch --no-tags origin "$TARGET"' }],
        },
      },
    });
    // The producer holds a needle but runs no checkout/fetch, so it is not
    // itself an offence; the consumer is, because it fetches what the producer
    // derived from the pull request.
    expect(found.map((offence) => offence.job), "only the fetching job is an offence").toEqual(["probe"]);
    expect(found[0]!.matches.map((match) => match.where)).toContain("a job it needs:");
  });

  it("does not walk a needs: cycle forever", () => {
    const found = judged({
      on: { pull_request_target: { branches: ["main"] } },
      jobs: {
        a: { needs: ["b"], env: { X: "${{ github.event.pull_request.number }}" }, steps: [{ run: "git fetch origin" }] },
        b: { needs: ["a"], env: { Y: "${{ github.event.pull_request.number }}" }, steps: [{ run: "git fetch origin" }] },
      },
    });
    expect(found.map((offence) => offence.job).sort()).toEqual(["a", "b"]);
  });

  it("still requires the COMMAND, so a broad needle alone is not a violation", () => {
    // The per-step conjunction is load-bearing. A push-only workflow whose job
    // holds a `head_sha` env beside an unrelated step is NOT reading pull
    // request data, and making the command requirement per-job would flag it.
    const found = judged({
      on: { push: { branches: ["main"] } },
      jobs: {
        probe: {
          env: { HEAD_SHA: "${{ github.event.before }}" },
          steps: [{ name: "Note", run: "echo nothing to fetch here" }],
        },
      },
    });
    expect(found, "a needle with no checkout/fetch/pull beside it is not a violation").toEqual([]);
  });

  it("reports a benign push-only match WITHOUT telling the reader to split a leg that does not exist", () => {
    // The false-positive direction, stated as a property of the MESSAGE. The
    // needle list stays broad on purpose (matching the analysers is the point),
    // so `head_sha` will keep matching a push-only workflow's before-SHA. What
    // must hold is that the message does not assume a pull-request leg is there
    // to split, and that it offers the second way out — show the value is not
    // pull-request-derived — rather than only the first.
    const workflow: Workflow = {
      on: { push: { branches: ["main"] } },
      jobs: {
        probe: {
          env: { BASE_HEAD_SHA: "${{ github.event.before }}" },
          steps: [{ name: "Fetch main for comparison", run: 'git fetch --no-tags origin "$BASE_HEAD_SHA"' }],
        },
      },
    };
    const found = judged(workflow);
    expect(found, "the broad needle list deliberately still matches this").toHaveLength(1);
    const message = verdict(found[0]!, workflow);
    expect(message).toContain("head_sha");
    expect(message, "the message must name the needle so the reader can see why it matched")
      .toContain("in the job's env:");
    expect(message, "this workflow has no pull-request leg, so the message must not promise one to split")
      .not.toContain("Split the pull-request leg");
    expect(message, "both ways to satisfy the rule must be offered")
      .toContain("NOT pull-request-derived");
    expect(message).toContain("Do not narrow the needle list");

    // And the same message on a workflow that DOES have a pull-request leg
    // names the other remedy, so the fix above is not read as a general licence.
    const pr: Workflow = {
      on: { push: { branches: ["main"] }, pull_request_target: { branches: ["main"] } },
      jobs: {
        probe: {
          env: { BASE_HEAD_SHA: "${{ github.event.before }}" },
          steps: [{ name: "Fetch main for comparison", run: 'git fetch --no-tags origin "$BASE_HEAD_SHA"' }],
        },
      },
    };
    expect(verdict(judgeWorkflow("fixture.yml", pr)[0]!, pr)).toContain("move this job out of the privileged-trigger workflow");
  });

  it("still refuses a GENUINE violation — a fixed message does not silence the rule", () => {
    // The other direction of the same pair. A message that explained benign
    // matches away too well could stop describing real ones; this is the
    // positive control on the message change, and it is why the two cases above
    // are worth having together.
    const workflow: Workflow = {
      on: { push: { branches: ["main"] } },
      jobs: {
        probe: {
          steps: [
            {
              name: "Fetch the pull request head",
              env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
              run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
            },
          ],
        },
      },
    };
    const found = judged(workflow);
    expect(found).toHaveLength(1);
    const keys = new Set(triggerKeys(workflow.on));
    const passes = keys.size === ALLOWED_TRIGGERS.size && [...keys].every((key) => ALLOWED_TRIGGERS.has(key));
    expect(passes, "a push-triggered workflow holding a refs/pull fetch must NOT pass the rule").toBe(false);
    expect(verdict(found[0]!, workflow)).toContain("refs/pull");
  });
});

describe("the ledger relay's producer filter", () => {
  // The relay's `workflows:` filter matches the workflow `name:` FIELD, not the
  // filename, so a producer file whose `name:` is missing from it is NEVER
  // relayed — and nothing else notices, because the file exists, parses,
  // lints, and produces its check context perfectly well. The only symptom is
  // a required check that stops arriving on pull-request heads.
  //
  // This sweep reads the producers rather than listing names, because a list is
  // exactly what a fourth producer would skip: the first version of this
  // assertion lived in secret-scan-workflow.test.ts and covered the two
  // secret-scan legs, and deleting `actionlint pull request` and
  // `ratchet guard pull request` from the filter left every suite green.
  //
  // WHAT COUNTS AS A PRODUCER, and why it is two sets rather than one.
  //
  // The first version of this sweep derived its producers from
  // .github/required-checks.json alone, and its header claimed it covered "the
  // forward wiring for unpinned producers like secret scan". It did not: nothing
  // in the pin map names secret-scan, so deleting `secret scan pull request`
  // from the filter left every suite green. The claim was aspirational, and a
  // doc that overstates a guard's reach is the same defect as a guard with a
  // hole — it tells the next reader they are covered when they are not.
  //
  // So the producer set is the UNION of two explicit sets, and neither is
  // inferred:
  //
  //  - PINNED: every workflow the pin map names (every path of every pin).
  //  - FORWARD_WIRED: named here, explicitly, with the reason it is relayed at
  //    all. A forward-wired producer is one nothing waits on today; the relay
  //    runs for it so that the day its context IS pinned nothing else has to
  //    change. The entry self-heals then — the name arrives through PINNED and
  //    the declaration becomes redundant rather than wrong.
  //
  // BOTH DIRECTIONS ARE ASSERTED, and the second is inverted on purpose. The
  // obvious form — "every declaration ships, and the filter names every
  // declaration" — leaves the control removable by one coherent edit. So the
  // second direction asserts over the FILTER as the enumerated surface: every
  // name the relay lists that is not a PINNED producer must be DECLARED here.
  // That is what makes the list a control rather than a record of what was once
  // true — a new producer added to the filter with no declaration fails, which
  // is the quiet direction, and the one that was open.
  //
  // WHAT THIS STILL DOES NOT CATCH, stated rather than implied. Dropping a
  // declaration AND its filter line together still passes, leaving a workflow
  // that is shipped, unpinned, undeclared and unforwarded. Within {FILTER,
  // PINNED, FORWARD_WIRED} this sweep cannot separate that state from "this was
  // never a producer": once the declaration and its filter line move together,
  // the two sets still agree, and nothing else in the derivation changes.
  //
  // It is NOT true, though, that no derivation could — an earlier version of
  // this paragraph said so, and it was wrong. A RELATIONAL rule separates the
  // two: every SHIPPED workflow whose `name:` is a DECLARED producer plus a
  // space-suffix must itself be declared. Measured, it is empty on today's
  // tree and fires on exactly the coordinated deletion:
  //
  //   today                    -> []
  //   "secret scan pull request" declared and filtered, then BOTH removed
  //                            -> ["secret scan pull request"]
  //
  // because secret-scan-pr.yml still ships under that name while its
  // declaration and its filter line are gone. It is not written here because it
  // is a judgement about the relay's contract — a rule about which workflows
  // MUST be relayed, which is the relay owner's call — not a silent change made
  // by a trigger sweep. The cheap alternative is measurably wrong rather than
  // merely weaker: "every shipped non-pinned workflow must be declared" fails
  // on today's tree, where 11 of the 17 shipped workflows are unpinned and 9 of
  // those are deliberately NOT relayed (claim, pr-suite, pr-gate, scorecard,
  // code-scanning, coverage-comment, dependency-audit, event-policy,
  // ledger-relay), so it would demand a declaration and a filter entry for each.
  //
  // The residual is unchanged from what this sweep replaced, and it is not the
  // silent direction: removing a line from a tracked workflow is a reviewable
  // diff, whereas adding a producer to the filter with no declaration was the
  // quiet case, and that one now dies.
  const FORWARD_WIRED: Record<string, string> = {
    "secret scan pull request": "the pull-request leg of the same workflow (issue 1090). " +
      "Naming only the push leg would relay half of that workflow's runs.",
  };

  const relayNames = async (): Promise<string[]> => {
    const relay = parse(await readFile(resolve(".github/workflows/ledger-relay.yml"), "utf8")) as {
      on: { workflow_run: { workflows: string[] } };
    };
    return relay.on.workflow_run.workflows;
  };

  /** Every workflow the pin map names, by the `name:` field the relay matches on. */
  const pinnedNames = async (): Promise<Set<string>> => {
    const pins = JSON.parse(await readFile(resolve(".github/required-checks.json"), "utf8")) as unknown;
    const paths = Object.values(pins as Record<string, unknown>)
      .flatMap((value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value : []))
      .filter((value): value is string => typeof value === "string");
    const names = new Set<string>();
    for (const file of files) {
      if (!paths.some((path) => path === `.github/workflows/${file}`)) continue;
      const name = workflows.get(file)?.name;
      expect(name, `${file} is pinned as a required-check producer and must carry a readable name`).toBeTruthy();
      names.add(name!);
    }
    return names;
  };

  it("declares at least one forward-wired producer, so the control cannot be emptied unnoticed", () => {
    // Without this, emptying FORWARD_WIRED leaves the union non-empty from
    // PINNED alone, every other assertion passes, and the one edit that removes
    // the control is invisible. The anti-vacuity assertion below checks the
    // UNION; this checks the half of it that has no other source.
    expect(
      Object.keys(FORWARD_WIRED),
      "FORWARD_WIRED is empty, so nothing declares a forward-wired producer and every unpinned " +
        "name in the relay filter is unchecked. That list IS the control, and an empty one " +
        "removes it without failing a single other assertion here.",
    ).not.toEqual([]);
  });

  it("holds exactly the post-1034 shape: one declaration, the pull-request leg's", () => {
    // Issue 1034 pinned secret-scan, which made the push-leg declaration's
    // reason ("is not a required context") false in the tree, so that entry is
    // deleted. Equality, not containment, pins the shape from drifting in
    // either direction: a re-added declaration whose reason the tree
    // contradicts is a doc that overstates or misstates a guard's reach, and a
    // brand-new unpinned producer in the relay filter must be declared here
    // with its own true reason (the directional test below catches that too;
    // this pins the list besides). The one remaining entry names a producer
    // that is also PINNED — the redundant-rather-than-wrong state this file's
    // header sanctions — and its reason stays true: both leg names are needed
    // for both legs' completions to relay.
    expect(Object.keys(FORWARD_WIRED).sort()).toEqual(["secret scan pull request"]);
  });

  it("names every PINNED and every FORWARD-WIRED producer's workflow name", async () => {
    const producerNames = new Set(await pinnedNames());
    for (const name of Object.keys(FORWARD_WIRED)) producerNames.add(name);
    // The anti-vacuity control over the union: a pin map that resolved to
    // nothing, plus an empty forward-wired list, would satisfy the containment
    // assertion below without having checked a name.
    expect(
      [...producerNames].sort(),
      "no producer this suite derived is non-empty, so the relay filter sweep below is checking " +
        "an empty set.",
    ).not.toEqual([]);
    const relayed = await relayNames();
    expect(
      [...producerNames].filter((name) => !relayed.includes(name)),
      "these producers are absent from the ledger relay's `workflows:` filter, so their " +
        "completions are NEVER relayed. For a PINNED producer the required context stops " +
        "arriving on pull-request heads; for a FORWARD_WIRED one it silently stops being " +
        "forwarded, and nothing waits on that today — which is exactly why it needs a control. " +
        "The filter matches the workflow `name:` field, not the filename. Add the name; do not " +
        "delete the producer.",
    ).toEqual([]);
  });

  it("declares every name the relay filter relays that is not a PINNED producer", async () => {
    const pinned = await pinnedNames();
    const declared = new Set(Object.keys(FORWARD_WIRED));
    const undeclared = (await relayNames()).filter((name) => !pinned.has(name) && !declared.has(name));
    expect(
      undeclared,
      "the relay filter relays these names, and they are neither PINNED producers nor declared " +
        "here — so nothing in this file checks that anyone meant to relay them. Declare each in " +
        "FORWARD_WIRED with the reason it is forwarded at all, or remove the name from the filter. " +
        "This is the assertion that makes the declaration list a control rather than a record of " +
        "what was once true: a producer added to the relay without a declaration is invisible to " +
        "every other assertion here.",
    ).toEqual([]);
  });

  it("declares a forward-wired producer only when the directory actually ships it", async () => {
    // The other direction for FORWARD_WIRED. A name left in that list after its
    // workflow is renamed or deleted keeps the containment assertion above
    // green while checking a producer that does not exist — the list would
    // paper over exactly the absence the second assertion below is there to
    // catch.
    const shipped = new Set([...workflows.values()].map((workflow) => workflow.name));
    expect(
      Object.keys(FORWARD_WIRED).filter((name) => !shipped.has(name)),
      "these FORWARD_WIRED entries name workflows the directory does not ship. Remove the entry: " +
        "keeping it makes the sweep assert the relay names something that no longer exists, which " +
        "hides a renamed or deleted producer from the assertion below.",
    ).toEqual([]);
  });

  it("names no workflow that does not exist, so a deleted file cannot leave a name that never fires", async () => {
    const shipped = new Set([...workflows.values()].map((workflow) => workflow.name));
    expect(
      (await relayNames()).filter((name) => !shipped.has(name)),
      "the relay filter names workflows this directory does not ship. A name left behind by a " +
        "renamed or deleted workflow matches nothing, so the relay's coverage silently shrinks " +
        "with no red anywhere.",
    ).toEqual([]);
  });
});

describe("the workflows deferred to a later task of issue 1090", () => {
  it("names a file that exists — a stale exclusion is a silent hole", () => {
    expect(
      [...Object.keys(DEFERRED)].sort(),
      "every deferred workflow must exist in .github/workflows, or this exclusion judges nothing " +
        "and reads as coverage it does not provide.",
    ).toEqual([...Object.keys(DEFERRED)].filter((file) => files.includes(file)).sort());
  });

  it("still covers a violation — a split must remove its own exclusion", () => {
    // The other direction. When Task 3 splits ci.yml, its pull-request job
    // moves to a pull_request_target-only file and this exclusion would go on
    // exempting a workflow that now satisfies the rule — quietly narrowing the
    // suite's reach without any assertion changing. Requiring the exclusion to
    // be still load-bearing is what makes that removal a step the split has to
    // take, rather than a cleanup somebody remembers.
    const idle = [...Object.keys(DEFERRED)].filter((file) => {
      const workflow = workflows.get(file);
      if (workflow === undefined) return false;
      return judgeWorkflow(file, workflow).length === 0;
    });
    expect(
      idle,
      "these deferred workflows no longer carry a pull-request job, so their exclusion is dead " +
        "weight that exempts a workflow the rule would already pass. Remove the entry so the " +
        "suite judges the file.",
    ).toEqual([]);
  });
});
