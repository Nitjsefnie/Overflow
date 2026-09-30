import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Every metered, pull-request-reachable workflow in this repository used to
 * key its concurrency group on `github.event.pull_request.number ||
 * github.ref`. That bounds ONE contributor's parallelism and nothing else: N
 * open pull requests produce N concurrent runs, so the repository's aggregate
 * Actions spend scaled with the number of open pull requests rather than with
 * any budget. Measured over the 4.24 days ending 2026-09-30 that was ~470 runs
 * a day and ~13 runner-hours a day, and nothing in the repository capped it.
 *
 * The bound is a per-workflow split by EVENT CLASS in one expression: a pull
 * request lands in a single repository-level group, so at most one run of that
 * workflow is in flight repository-wide and the aggregate stops tracking the
 * open-pull-request count; every other leg keys on its own `github.sha`, so a
 * push to main, a schedule tick and a dispatch each get a private group and
 * nothing the deploy gate reads is ever cancelled by a later event.
 *
 * Assertions are made on the parsed YAML data, never on the raw bytes, so
 * reformatting the block does not disturb them while a change to either key
 * fails loudly here.
 */

type Workflow = {
  on: unknown;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
};

/**
 * The metered workflows this repository bounds, with the exact group and
 * cancel-in-progress each carries. Written out per workflow rather than
 * generated from one template so the literal that ships is the literal this
 * suite reads.
 *
 * The parentheses around the event-name test are load-bearing and the shape
 * assertion below enforces them: GitHub's `&&` binds tighter than `||`, so
 * without them `a || b && 'repo-wide' || github.sha` reads as
 * `a || (b && 'repo-wide') || github.sha` and every `pull_request` run gets its
 * own SHA group — the exact unbounded shape this suite exists to deny.
 */
const BOUNDED: Record<string, { group: string; "cancel-in-progress": string }> = {
  "ci.yml": {
    group: "ci-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request_target' }}",
  },
  "actionlint.yml": {
    group: "actionlint-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request_target' }}",
  },
  "ratchet-guard.yml": {
    group: "ratchet-guard-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request_target' }}",
  },
  "code-scanning.yml": {
    group: "code-scanning-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
  },
};

/**
 * Every workflow that is deliberately NOT repository-bounded, and why keeping
 * it that way is correct rather than merely convenient. The reason is the value
 * and not a comment, so a blanked or stubbed justification fails the
 * non-blank-reason test below instead of passing unnoticed.
 *
 * GitHub keeps only one PENDING run per concurrency group and cancels the
 * older pending one even at `cancel-in-progress: false`, so sharing a group
 * would drop work for all four of these. That is why the bound is applied only
 * to the metered CI workflows, each of whose runs is reproducible from the next
 * push.
 */
const UNBOUNDED_BY_CHOICE = new Map<string, string>([
  [
    "claim.yml",
    "Two racers commenting /claim on one issue must both get an answer. A shared group keeps only the newest PENDING run and cancels the older even at cancel-in-progress false, so one racer would silently never be answered.",
  ],
  [
    "pr-gate.yml",
    "A cancelled run may already have closed the pull request; the queued run is what reads that and repairs it. Cancelling it leaves the pull request closed with no repair.",
  ],
  [
    "ledger-relay.yml",
    "The relay posts the check-runs branch protection requires. A cancelled relay posts none, and a missing check-run blocks every open pull request.",
  ],
  [
    "coverage-comment.yml",
    "The report posts a comment the author reads. Cancelling a queued run loses the report for that head commit, and the next run may not come.",
  ],
  [
    "dependency-audit.yml",
    "No pull_request trigger at all: schedule and workflow_dispatch only, so both the pull_request arm of its group and its cancel-in-progress test are dead. The group is already per-ref on a schedule tick, and it never receives the events that would make a repository-level group contend.",
  ],
]);

/** The two events that make a workflow reachable from a fork pull request. */
const PR_EVENTS = ["pull_request", "pull_request_target"];

/** Group keys that scope a run to one pull request or one ref, not to the repository. */
const UNBOUNDED_GROUP_KEYS = ["github.event.pull_request.number", "github.ref"];

const workflows = new Map<string, Workflow>();

beforeAll(async () => {
  const directory = resolve(".github/workflows");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"));
  for (const file of files.sort()) {
    workflows.set(file, parse(await readFile(resolve(directory, file), "utf8")) as Workflow);
  }
});

describe("the workflow directory", () => {
  it("is enumerated dynamically, and the enumeration is not empty", () => {
    // Without this a broken read or a relocated directory would make every
    // assertion below vacuously pass, which is the failure mode a
    // dynamically-enumerated contract suite has to guard explicitly.
    expect(workflows.size).toBeGreaterThanOrEqual(Object.keys(BOUNDED).length);
    for (const name of Object.keys(BOUNDED)) {
      expect(workflows.has(name), `${name} must be enumerated from .github/workflows`).toBe(true);
    }
  });
});

describe("every workflow's concurrency block", () => {
  it("declares both a group and a cancel-in-progress", () => {
    for (const [name, workflow] of workflows) {
      expect(workflow.concurrency, `${name} must declare a concurrency block`).toBeDefined();
      expect(
        typeof workflow.concurrency?.group,
        `${name}'s concurrency.group must be present and a string`,
      ).toBe("string");
      const cancelInProgress = workflow.concurrency?.["cancel-in-progress"];
      expect(
        typeof cancelInProgress === "string" || typeof cancelInProgress === "boolean",
        `${name}'s concurrency.cancel-in-progress must be present, and be a string expression or a ` +
          `boolean — got ${JSON.stringify(cancelInProgress) ?? "nothing"}`,
      ).toBe(true);
    }
  });

  it("does not key a pull-request-reachable workflow on its pull request or ref", () => {
    // The default is deny. A workflow lands in UNBOUNDED_BY_CHOICE with a
    // written reason or it does not ship; there is no third option.
    for (const [name, workflow] of workflows) {
      if (!isPullRequestReachable(workflow.on)) continue;
      if (UNBOUNDED_BY_CHOICE.has(name)) continue;
      const group = String(workflow.concurrency?.group ?? "");
      for (const key of UNBOUNDED_GROUP_KEYS) {
        expect(
          group.includes(key),
          `${name} is reachable from a pull request and keys its concurrency group on ${key}, ` +
            "so the repository's Actions minutes scale with the number of open pull requests. " +
            "Key a pull request into one repository-level group, or add it to UNBOUNDED_BY_CHOICE " +
            "with the reason it may stay unbounded.",
        ).toBe(false);
      }
    }
  });

  it("is classified — bounded, or an exception carrying its reason", () => {
    // Every workflow in the directory is decided. A workflow added later is
    // red here until it is either added to BOUNDED or justified in
    // UNBOUNDED_BY_CHOICE, and a workflow deleted here leaves a stale key that
    // this same equality fails. Neither direction passes silently.
    const classified = [...Object.keys(BOUNDED), ...UNBOUNDED_BY_CHOICE.keys()].sort();
    expect([...workflows.keys()].sort()).toEqual(classified);
  });
});

describe("the bounded workflows", () => {
  it("carry the exact event-class group and cancel-in-progress", () => {
    for (const [name, expected] of Object.entries(BOUNDED)) {
      const workflow = workflows.get(name)!;
      expect(workflow.concurrency?.group, `${name}'s group`).toBe(expected.group);
      expect(workflow.concurrency?.["cancel-in-progress"], `${name}'s cancel-in-progress`).toBe(
        expected["cancel-in-progress"],
      );
    }
  });

  it("parenthesise the event test so operator precedence cannot unbind the bound", () => {
    for (const [name, expected] of Object.entries(BOUNDED)) {
      expect(
        expected.group,
        `${name}'s group must parenthesise the event-name test: && binds tighter than || in a ` +
          "GitHub expression, and the unparenthesised form reads as `a || (b && 'repo-wide') || " +
          "github.sha`, which gives every pull_request run its own SHA group and bounds nothing.",
      ).toMatch(/^\S+-\$\{\{ \(github\.event_name == 'pull_request' \|\| github\.event_name == 'pull_request_target'\) && 'repo-wide' \|\| github\.sha \}\}$/);
    }
  });

  it("are actually reachable from a pull request, or the bound is vacuous", () => {
    for (const name of Object.keys(BOUNDED)) {
      expect(
        isPullRequestReachable(workflows.get(name)!.on),
        `${name} is listed as bounded but receives no pull_request or pull_request_target event, ` +
          "so its repository-level leg can never be entered",
      ).toBe(true);
    }
  });

  it("keep the non-pull-request leg cancellable only by a pull request", () => {
    // The deploy gate in scripts/deploy-revision.sh reads the check conclusion
    // for the SHA it deploys and refuses `cancelled` (issue 474), so a push to
    // main must never evaluate cancel-in-progress true. Every bounded workflow
    // expresses the cancellation as a string event test for exactly that reason;
    // a literal `true` fails these.
    for (const [name, expected] of Object.entries(BOUNDED)) {
      expect(
        expected["cancel-in-progress"],
        `${name}'s cancel-in-progress must stay a string event test`,
      ).toMatch(/^\$\{\{ github\.event_name == '(?:pull_request|pull_request_target)' \}\}$/);
      expect(workflows.get(name)!.concurrency?.["cancel-in-progress"]).toBe(
        expected["cancel-in-progress"],
      );
    }
  });
});

describe("the workflows left unbounded", () => {
  it("each carry a written reason", () => {
    for (const [name, reason] of UNBOUNDED_BY_CHOICE) {
      expect(workflows.has(name), `${name} is listed as unbounded but is not in the workflow directory`).toBe(true);
      expect(
        reason.trim().length,
        `${name} is in UNBOUNDED_BY_CHOICE without a reason, so the default-deny above is disabled for it`,
      ).toBeGreaterThan(0);
      expect(reason.length, `${name}'s reason must be a justification, not a stub`).toBeGreaterThan(80);
    }
  });

  it("keeps the premise each reason names", () => {
    // Every reason above that names a pull request names it for one reason: the
    // pending run that GitHub would cancel is work that is lost, not work
    // somebody re-runs. That premise is `cancel-in-progress: false`, so it is
    // asserted rather than trusted — flipping a justified workflow to cancel
    // makes the justification false and fails here.
    for (const [name, reason] of UNBOUNDED_BY_CHOICE) {
      if (!isPullRequestReachable(workflows.get(name)!.on)) continue;
      expect(
        workflows.get(name)!.concurrency?.["cancel-in-progress"],
        `${name} is left unbounded on the stated ground that cancelling loses work, but its ` +
          "cancel-in-progress is not the literal false that ground depends on",
      ).toBe(false);
      expect(reason).toMatch(/cancel/i);
    }
  });

  it("are never one of the bounded workflows", () => {
    for (const name of UNBOUNDED_BY_CHOICE.keys()) {
      expect(Object.hasOwn(BOUNDED, name), `${name} is both bounded and left unbounded`).toBe(false);
    }
  });
});

/** True when any of the two fork-reachable events appears in a workflow's `on` block. */
function isPullRequestReachable(on: unknown): boolean {
  const keys = Array.isArray(on) ? on : typeof on === "string" ? [on] : Object.keys((on ?? {}) as object);
  return keys.some((key) => PR_EVENTS.includes(String(key)));
}
