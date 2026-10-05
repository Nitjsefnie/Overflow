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
 * entering one of those jobs is a step from untrusted content running with
 * privileges a contributor does not hold. CodeQL says so out loud: the
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
 * PR-derived value. Env NAMES count as much as env values, because
 * `PR_NUMBER: ${{ github.event.pull_request.number }}` matches on the name
 * alone; reading only values would miss the exact spelling this repository
 * uses in every one of its pull-request fetches.
 *
 * The trigger set is asserted as a CLOSED SET — `set(on) === {pull_request_target}`
 * — rather than as a denylist of privileged events. A denylist passes today
 * and re-arms the class the moment someone adds `repository_dispatch`,
 * `issue_comment` or `workflow_call`, none of which anyone would think to add
 * to a list of the three events that happened to be a problem.
 *
 * SCOPE. This suite reads every workflow in `.github/workflows/` except the
 * ones named in `DEFERRED`, which is issue 1090 Task 3's file. The exclusion is
 * a `Record`, not a `Set`, and it is checked in BOTH directions: a deferred
 * entry that no longer covers a violating file fails this suite, so the split
 * of ci.yml cannot land without the exclusion being removed, and an exclusion
 * widened past a file that still violates it fails the assertion below it.
 */

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type Workflow = {
  name?: string;
  on?: unknown;
  jobs?: Record<string, { steps?: Step[] }>;
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

/**
 * The trigger set the rule requires of any workflow holding a pull-request
 * job. One event, and nothing else.
 */
const ALLOWED_TRIGGERS = new Set(["pull_request_target"]);

/**
 * Workflows this suite does NOT judge, and why. Every entry is a workflow that
 * TODAY violates the rule below and is split by a later task of issue 1090.
 * The assertion "every deferred entry still covers a violation" is what keeps
 * this list honest in both directions.
 */
const DEFERRED: Record<string, string> = {
  "ci.yml":
    "issue 1090 Task 3 splits ci.yml; until it lands, its verify job reads pull-request data " +
    "under push and workflow_dispatch, which is the violation this suite exists to refuse.",
};

let files: string[] = [];
let workflows = new Map<string, Workflow>();

/** The `on:` block's event names, whatever shape it is written in. */
function triggerKeys(on: unknown): string[] {
  if (Array.isArray(on)) return on.map(String);
  if (typeof on === "string") return [on];
  if (on && typeof on === "object") return Object.keys(on as object);
  return [];
}

/** Every name and string value a step carries, lowercased, as one blob. */
function valueText(step: Step): string {
  const parts = [step.run ?? "", step.uses ?? ""];
  for (const source of [step.env ?? {}, step.with ?? {}]) {
    for (const [name, value] of Object.entries(source)) {
      parts.push(name);
      if (typeof value === "string") parts.push(value);
      else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
    }
  }
  return parts.join("\n").toLowerCase();
}

/** The needles a step's text actually carries. */
function needlesIn(step: Step): string[] {
  const text = valueText(step);
  return PR_NEEDLES.filter((needle) => text.includes(needle));
}

/** A command step names, or "" when it names none. */
function commandIn(step: Step): string {
  const text = valueText(step);
  return COMMAND_PATTERNS.find((pattern) => pattern.test(text))?.source ?? "";
}

/** The steps of a job that both run a checkout/fetch/pull and name PR data. */
function pullRequestSteps(job: { steps?: Step[] }): Step[] {
  return (job.steps ?? []).filter((step) => needlesIn(step).length > 0 && commandIn(step) !== "");
}

/** A file and the jobs in it that read pull-request data. */
type Offence = { file: string; job: string; steps: string[] };
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
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      const steps = pullRequestSteps(job);
      if (steps.length === 0) continue;
      offences.push({
        file,
        job: jobId,
        steps: steps.map((step) => step.name ?? step.uses ?? step.run ?? "(unnamed step)"),
      });
    }
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
      .map(
        (offence) =>
          `${offence.file}#${offence.job} (steps: ${offence.steps.join(", ")}) is triggered by ` +
          `${JSON.stringify(triggerKeys(workflows.get(offence.file)?.on))}`,
      );
    expect(
      offenders.join("\n") || "(none)",
      "a job that fetches or reads pull-request data must live in a workflow whose ENTIRE `on:` " +
        "set is {pull_request_target}, and these do not. A privileged trigger (push, schedule, " +
        "workflow_dispatch, repository_dispatch, …) runs the workflow from the default branch " +
        "with the default branch's privileges, so a step like these — a `refs/pull` fetch, a " +
        "`github.event.pull_request.*` value — is untrusted content entering a privileged job. " +
        "Split the pull-request leg into its own pull_request_target-only workflow (issue 1090) " +
        "rather than gating these steps with `if:`, which makes them safe but leaves nothing " +
        "stopping the next privileged trigger from arriving.",
    ).toBe("(none)");
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
      return Object.entries(workflow.jobs ?? {}).every(([, job]) => pullRequestSteps(job).length === 0);
    });
    expect(
      idle,
      "these deferred workflows no longer carry a pull-request job, so their exclusion is dead " +
        "weight that exempts a workflow the rule would already pass. Remove the entry so the " +
        "suite judges the file.",
    ).toEqual([]);
  });
});
