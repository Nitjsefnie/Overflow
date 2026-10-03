import { readFileSync } from "node:fs";
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
 * push to main gets a private group and nothing the deploy gate reads is ever
 * cancelled by a later event. A `schedule` tick and a `workflow_dispatch` land
 * in the same non-PR arm but do NOT get a private group: on a schedule event
 * `github.sha` is the default branch's tip, which is the very SHA a push run for
 * that tip carries, so the two share a group. Harmless at one scheduled tick.
 *
 * The shared group is paired with `cancel-in-progress: false`, and the flag is
 * what a reader is most likely to get wrong in either direction. GitHub's own
 * documentation: "By default, any existing pending job or workflow in the same
 * concurrency group will be canceled and the new queued job or workflow will
 * take its place. To also cancel any currently running job or workflow in the
 * same concurrency group, specify cancel-in-progress: true." The PENDING run is
 * therefore cancelled whatever the flag says, and the group holds at most one
 * running plus one pending job either way — so the flag buys no additional
 * bound, it only decides whether the RUNNING job is destroyed too.
 *
 * What `false` guarantees: no in-flight run is ever cancelled, so no required
 * context concludes `cancelled` because a peer pushed while it was running.
 * `verify`, `actionlint` and `ratchet-guard` are the required contexts in
 * `.github/required-checks.json`, which `ledger-relay` mirrors a run conclusion
 * onto, so that is a peer's blocked pull request.
 *
 * What it does NOT prevent, and what this design cannot remove: the PENDING run
 * is still cancelled when a newer arrival claims the single pending slot. Under
 * a per-pull-request group that run is always the same pull request's superseded
 * head and the push that superseded it created a replacement, so it is
 * self-healing. Here it can be a DIFFERENT pull request's current head with no
 * replacement, and the bounded workflows trigger on opened/synchronize/reopened
 * with no `edited`, so that pull request stays blocked until its author pushes
 * again. `false` is strictly better than `true`, never a cure.
 *
 * The rates. Of the 483 `ci` runs in the 6.13 days ending 2026-09-30, only
 * the 370 pull-request arrivals ever enter `ci-repo-wide`; the 106 `push` and 7
 * `workflow_dispatch` runs key their own `github.sha` and cannot contend with
 * anything, so counting them inflated both the arrival rate and rho. Load is
 * also not steady — per-day all-event arrivals were 5, 0, 215, 122, 78, 17, 46.
 * M/M/1 with one waiting place over the PR arrivals, mean PR-leg service 6.44
 * min, where pending-cancelled is n*pi2 and running-cancelled-if-`true` is
 * n*(pi1+pi2):
 *
 * | date | PR arrivals | rho | pending-cancelled | running-cancelled if `true` |
 * |---|---:|---:|---:|---:|
 * | 2026-09-26 | 171 | 0.76 | ~43/day | ~98/day |
 * | 2026-09-27 | 95 | 0.42 | ~11/day | ~36/day |
 * | 2026-09-28 | 59 | 0.26 | ~3/day | ~15/day |
 * | window mean | 60 | 0.27 | ~3/day | ~15/day |
 *
 * These are a LOWER bound, because a Poisson fit understates a bursty arrival
 * process. Replaying the real arrival timestamps instead produced materially
 * higher figures (97 and 134 pending cancellations per window, depending on
 * which arrival set and service-time treatment was used), and neither replay
 * reproduced stably, so no single replayed number is quoted here. On `main` the
 * mechanism already fires inside per-PR groups: 9 of 482 completed `ci` runs
 * concluded cancelled, every one a same-PR self-supersede.
 *
 * On runner minutes the direction is counter-intuitive and stated here so it is
 * not misremembered: `true` would bill FEWER minutes, because a destroyed run
 * stops accruing. `false` costs minutes relative to `true` and is bought
 * deliberately. The bound is unaffected either way — one running slot per group
 * caps concurrency at 1 — and a run dropped from the pending slot never started,
 * so the cheap kind of cancellation is the one that remains.
 *
 * Assertions are made on the parsed YAML data, never on the raw bytes, so
 * reformatting the block does not disturb them while a change to a key one of
 * the tables below pins fails loudly here: `group` and `cancel-in-progress` for
 * every bounded workflow, and — for each exception — the `queue` recorded beside
 * its reason. The bounded table carries only the first two because none of the
 * bounded workflows ships a `queue`; the key is pinned where one exists.
 */

type Workflow = {
  on: unknown;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown; queue?: unknown };
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
 *
 * `cancel-in-progress` is the literal boolean `false` in all bounded workflows, for every
 * leg, not an event expression. It buys no bound (see the header), and on a
 * group shared by every pull request a `true` destroys a peer's in-flight run.
 * It does not stop GitHub cancelling the group's PENDING run — that happens by
 * default — so read the header before concluding that `false` means nothing is
 * cancelled.
 */
const BOUNDED: Record<string, { group: string; "cancel-in-progress": false }> = {
  "ci.yml": {
    group: "ci-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": false,
  },
  "actionlint.yml": {
    group: "actionlint-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": false,
  },
  "ratchet-guard.yml": {
    group: "ratchet-guard-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": false,
  },
  "code-scanning.yml": {
    group: "code-scanning-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": false,
  },
};

/**
 * Every workflow that is deliberately NOT repository-bounded: why keeping it
 * that way is correct rather than merely convenient, and the exact group and
 * cancel-in-progress it ships.
 *
 * The reason is a field and not a comment, so a blanked or stubbed
 * justification fails the non-blank-reason test below instead of passing
 * unnoticed. The group is pinned for the same reason `BOUNDED` pins its: two
 * workflows sharing a group cancel each other's PENDING runs whatever each
 * one's own reason says, so a collision has to fail here rather than only in
 * whichever older suite happens to pin that file's whole block.
 *
 * **This list is a judgement surface, not an enforcement mechanism, and it opens
 * in BOTH directions.** A reviewer has to be able to see that, so both are
 * named here:
 *
 * 1. **Adding.** Putting a workflow here with a plausible reason turns the
 *    default-deny off for it. No assertion can tell a true justification from a
 *    plausible one — only a reviewer reading the diff can. This direction needs
 *    a conspicuous diff, because a workflow file has to appear.
 * 2. **De-bounding.** Moving a workflow OUT of `BOUNDED` and reverting its group
 *    to an unbounded one is the same escape with a much smaller diff: two lines
 *    in this file plus a workflow edit, and every assertion still passes if the
 *    table entry moves with the workflow. This is the direction a future
 *    contributor reaches for when a bound inconveniences them, and it is the
 *    more dangerous of the two precisely because it looks like housekeeping.
 *
 * Direction 2 is narrowed, not closed, by the assertion that no workflow named
 * in `.github/required-checks.json` may appear here — that catches unbinding
 * `ci`, `actionlint` and `ratchet-guard`, which are the three whose required
 * contexts the whole design exists to protect. No assertion can catch every
 * de-bounding move, and pretending otherwise would be worse than saying so.
 *
 * That is the design the plan specifies ("unless it appears in a named,
 * justified exception list"), and it is why a diff that moves a name between
 * `BOUNDED` and this table — in either direction — deserves the same attention
 * as one touching a required-check pin.
 *
 * GitHub keeps only one PENDING run per concurrency group and cancels the
 * older pending one even at `cancel-in-progress: false`, so sharing a group
 * would drop work for these. That is why the bound is applied only to the
 * metered CI workflows, each of whose runs is reproducible from the next push.
 */
const UNBOUNDED_BY_CHOICE = new Map<string, {
  reason: string;
  group: string;
  "cancel-in-progress": unknown;
  /**
   * The third concurrency key, recorded for every entry so the block an
   * exception ships is compared whole. `undefined` means the workflow has no
   * `queue` key, which is a fact this file pins rather than a field it skips:
   * a `queue` appearing on an exception's workflow, or disappearing from the
   * one that needs it, then fails the equality below by name instead of
   * passing an assertion that never looks.
   */
  queue: unknown;
}>([
  [
    "claim.yml",
    {
      reason:
        "Two racers commenting /claim on one issue must both get an answer. A shared group keeps only the newest PENDING run and cancels the older even at cancel-in-progress false, so one racer would silently never be answered.",
      group: "claim-${{ github.event.issue.number }}",
      "cancel-in-progress": false,
      // `queue: max` is what makes the reason true rather than aspirational:
      // the single PENDING slot is exactly the drop the reason describes, and
      // the queue is the only setting that holds the arrivals instead of
      // cancelling the older one.
      queue: "max",
    },
  ],
  [
    "pr-gate.yml",
    {
      reason:
        "A cancelled run may already have closed the pull request; the queued run is what reads that and repairs it. Cancelling it leaves the pull request closed with no repair.",
      group: "pr-gate-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "ledger-relay.yml",
    {
      reason:
        "The relay posts the check-runs branch protection requires. A cancelled relay posts none, and a missing check-run blocks every open pull request.",
      group: "ledger-relay",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "coverage-comment.yml",
    {
      reason:
        "The report posts a comment the author reads. Cancelling a queued run loses the report for that head commit, and the next run may not come.",
      group:
        "coverage-comment-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "secret-scan.yml",
    {
      reason:
        "Every pull request must be scanned: per-PR groups let a newer run supersede only its own PR's pending scan, so another PR cannot cancel it. Push, workflow_dispatch and schedule runs group per SHA so different merged SHAs cannot cancel each other's pending scans. cancel-in-progress false preserves every in-flight full-history detection record.",
      group: "secret-scan-${{ github.event.pull_request.number || github.sha }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "dependency-audit.yml",
    {
      reason:
        "This workflow has NO pull_request and NO pull_request_target trigger — it is schedule and workflow_dispatch only — so BOTH arms that would make it unbounded are dead: the pull_request arm of its group always resolves null and falls through to github.ref, and its cancel-in-progress test is never true. The group is therefore already per-ref on a schedule tick, and it never receives the event that would make a repository-level group contend.",
      group: "dependency-audit-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      queue: undefined,
    },
  ],
  [
    "scorecard.yml",
    {
      reason:
        "This workflow has NO pull_request and NO pull_request_target trigger — it is schedule and workflow_dispatch only — so BOTH arms that would make it unbounded are dead: it never keys its group on one contributor's pull request, and it never receives the event that would make a repository-level group contend. The group is therefore already per-ref, and on a schedule tick github.ref is the default branch. Unlike the two schedule workflows above it, which make cancel-in-progress an event expression that is never true here, this one ships the literal true, and that flag is NOT unreachable — workflow_dispatch is an arrival into this group too, because a manual run on the default branch resolves to the same github.ref as the tick, so a maintainer dispatching while a tick is in flight would cancel that tick. What bounds the exposure is the window rather than the absence of arrivals: ticks are a week apart and the job bounds itself at 15 minutes, so the only overlap possible is a dispatch inside those 15 minutes, and what that costs is one weekly reading of a signal nothing in this repository depends on. Scorecard is also not reproducible from a later push the way a metered CI leg is — its SARIF is a weekly reading, not a per-commit verdict — which is the second reason the group needs no repository-level bound.",
      group: "scorecard-${{ github.ref }}",
      "cancel-in-progress": true,
      queue: undefined,
    },
  ],
]);

/** The two events that make a workflow reachable from a fork pull request. */
const PR_EVENTS = ["pull_request", "pull_request_target"];

/**
 * Group keys that scope a run to one pull request or one ref, not to the
 * repository. Matched as substrings, so `github.ref_name` is caught too: on a
 * `pull_request` event that resolves to `<N>/merge`, which is per-pull-request
 * and equally unbounded, so flagging it is the answer we want rather than a
 * false positive to work around.
 *
 * `github.event.number` is the canonical shorthand for the pull request number
 * on a `pull_request` event and the spelling a future author is most likely to
 * reach for. `github.event.pull_request.head.sha` is worse than per-PR: one pull
 * request that pushes ten times gets ten groups.
 *
 * This list is a SPELLING list, not an exhaustive one. A group that means "this
 * one pull request" can be spelled in ways not enumerated here, and the
 * assertion below is named for what it does rather than for a universality it
 * cannot deliver. What closes the gap for the workflows this repository ships is
 * the classification equality: every workflow is in a table, and every table
 * pins the exact group, so a missed spelling still cannot ship. The gap that
 * remains is on the EXCEPTION path, where a workflow with a group nobody pinned
 * is not covered by that argument — which is why the exception list's own
 * docstring is the thing a reviewer has to read.
 */
const UNBOUNDED_GROUP_KEYS = [
  "github.event.pull_request.number",
  "github.event.pull_request.head.ref",
  "github.event.pull_request.head.sha",
  "github.event.number",
  "github.head_ref",
  "github.ref",
];

/**
 * The per-pull-request keys a group expression uses, as a pure function so it
 * can be exercised on synthetic groups. Asserting the key list through a
 * dynamic loop over real workflow files alone leaves the list itself untested:
 * dropping a key from it changes nothing observable until a workflow happens to
 * use that key, so the omission is invisible at the moment it is made.
 */
export function unboundedGroupKeysIn(group: string): string[] {
  return UNBOUNDED_GROUP_KEYS.filter((key) => group.includes(key));
}

/**
 * Every top-level key a workflow in this directory is allowed to carry, and no
 * others.
 *
 * This is a check AGAINST UNEXPECTED KEYS, and that is the whole point of it.
 * Every other assertion in this file — and every assertion in
 * `tests/api/ci-workflows.test.ts` that is not issue 986's own — reads a key
 * the workflow is EXPECTED to carry: `concurrency` here, `name`/`on`/
 * `permissions`/`jobs` there. A key outside the set those assertions read is not
 * a gap in coverage, it is a channel nothing reads. An unpinned top-level `env:`
 * block planting a `${{ github.repository }}` survives both pin suites green and
 * survives `actionlint` and `zizmor` as well, because all three read it clean:
 * a key nobody asserts on is a key nobody is looking at. Issue 986 closed that
 * hole for `scorecard.yml` alone; this closes it for the directory.
 *
 * **`env` is deliberately absent, and that is the load-bearing omission.** It is
 * a legitimate GitHub Actions key — a workflow may legitimately pin one, at the
 * job level or at the top — which is exactly why an allowlist and not a
 * denylist is the mechanism: a denylist would need `env` named in it to catch
 * this, and the next unasserted key nobody thought of would pass. Adding `env`
 * here to quiet a failure is the fix this file exists to prevent, and the
 * failure message below says so.
 *
 * The set is the union of what the eleven shipped workflows actually carry, so a
 * twelfth workflow carrying only legitimate top-level keys needs NO EDIT TO THIS
 * ALLOWLIST — though it is not free of edits to this FILE: a new workflow still
 * has to be classified in `BOUNDED` / `UNBOUNDED_BY_CHOICE` below, or the
 * classification totality assertion reds. What this set does NOT catch,
 * deliberately: a workflow DROPPING a key it should have, such as a missing
 * `permissions:`. This is a check against the unexpected, not against the
 * missing — that direction is covered elsewhere for eight of the eleven
 * workflows, being the seven whose exact `permissions` value
 * `ci-workflows.test.ts` pins and `claim.yml`, whose ABSENCE of a top-level
 * `permissions` it pins. The three it does not cover — `coverage-comment.yml`,
 * `ledger-relay.yml` and `secret-scan.yml`, all of which do carry one — are a
 * gap in THAT suite, not a reason to duplicate the direction here.
 *
 * Every name below is carried by at least one shipped workflow, which is what
 * keeps the set from rotting: an entry added here "just in case" is a hole
 * nothing reads, and a later check would deny nothing. Adding one together with
 * the workflow that uses it is the only way an entry belongs in this list.
 */
const ALLOWED_TOP_LEVEL_KEYS = [
  "concurrency",
  "jobs",
  "name",
  "on",
  "permissions",
];

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

describe("every workflow's top-level keys", () => {
  it("carry nothing outside the allowed set, because an unasserted key is a channel nothing reads", () => {
    // The one assertion in this file that reads against UNEXPECTED keys rather
    // than expected ones. Everything else here looks up a key by name, so it can
    // only ever fail on a key someone chose to read — and a key nobody chose to
    // read is exactly the one that ships. Asserted on the PARSED object, never
    // on file text, so reformatting the block does not disturb it while a key
    // change fails loudly by name.
    //
    // Built as a whole-collection comparison rather than a per-workflow `expect`
    // inside the loop, and that shape is load-bearing twice over: it names every
    // offending workflow at once, and — with the companion comparison below — an
    // EMPTY result fails. Both of those were arrived at by mutation, and the
    // mutations are the reason neither can be simplified:
    //
    // 1. The per-workflow `expect`-in-loop variant is VACUOUS. Written first, it
    //    passed this suite whole with a planted top-level `env:` block in the
    //    tree once its iteration source was emptied to `new Map()` — the
    //    assertion never ran. The enumeration guard above did not notice either;
    //    it reads the Map, not this loop.
    // 2. Hoisting ONE sorted name list for both sides is that same vacuity in
    //    another hat: emptying the collected side empties the expectation too,
    //    and the comparison holds against itself. Written, and the planted block
    //    passed it.
    //
    // So the two sides are derived from SEPARATE reads: only the collected side
    // goes through the loop this assertion depends on, and the expected side
    // re-reads the directory. Keep it that way.
    const entries = [...workflows].map(
      ([name, workflow]): [string, string[]] => [
        name,
        Object.keys(workflow)
          .filter((key) => !ALLOWED_TOP_LEVEL_KEYS.includes(key))
          .sort(),
      ],
    );
    const offenders = entries.filter(([, keys]) => keys.length > 0);
    expect(
      offenders.map(([name, keys]) => `${name}: ${JSON.stringify(keys)}`).join("; ") ||
        "(none)",
      "these workflows carry top-level key(s) outside the allowed set: " +
        `${JSON.stringify(Object.fromEntries(offenders))}. Every other assertion in this file and ` +
        "in ci-workflows.test.ts reads a key this workflow is EXPECTED to carry, so a key outside " +
        "that set is not merely unasserted — it is a channel nothing reads. An unpinned top-level " +
        "`env:` block planting a `${{ github.repository }}` passes both pin suites whole and is " +
        "clean to actionlint and zizmor too, because a key nobody asserts on is a key nobody is " +
        "looking at. `env` is absent from ALLOWED_TOP_LEVEL_KEYS ON PURPOSE. If you are adding a " +
        "legitimate top-level key, add it to ALLOWED_TOP_LEVEL_KEYS in this file alongside the " +
        "workflow that uses it: the fix for this failure is the assertion, not the deletion of " +
        "your key from your workflow, and not a new denylist entry naming the key you happened to " +
        "trip on.",
    ).toEqual("(none)");
    expect(
      entries.map(([name]) => name),
      "every workflow in the directory must be decided by the key check above. A comparison " +
        "collecting fewer names than the directory holds has iterated over nothing and passes " +
        "vacuously, which is the failure mode a dynamically-enumerated contract suite has to " +
        "guard explicitly. The enumeration guard above does not cover this: it reads the Map, not " +
        "this loop. Keep the expected value reading the directory independently — sharing one " +
        "derived name list between both sides is the same vacuity, and it passes.",
    ).toEqual([...workflows.keys()].sort((left, right) => left.localeCompare(right)));
  });

  it("spend every allowed key, so an entry added for a workflow nobody ships is denied", () => {
    // The rot guard for the set above. An entry added there "just in case" is a
    // hole: the check above would deny nothing, because nothing carries it, and
    // the next workflow to use it would ship an unasserted key with a test suite
    // that has already agreed the key is fine. A twelfth workflow carrying a
    // legitimate NEW key fails here and is then named in the set above, which is
    // the diff a reviewer can see.
    const spent = ALLOWED_TOP_LEVEL_KEYS.filter((key) =>
      [...workflows.values()].some((workflow) => Object.hasOwn(workflow, key)),
    ).sort();
    expect(
      spent,
      `these ALLOWED_TOP_LEVEL_KEYS entries are carried by no workflow in the directory: ` +
        `${JSON.stringify(ALLOWED_TOP_LEVEL_KEYS.filter((key) => !spent.includes(key)))}. An ` +
        "allowed key nothing ships is a hole nothing can trip over, and the failure it lets " +
        "through is silent. Remove the entry, or land the workflow that carries it.",
    ).toEqual([...ALLOWED_TOP_LEVEL_KEYS].sort());
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
      for (const key of unboundedGroupKeysIn(group)) {
        expect(
          key,
          `${name} is reachable from a pull request and keys its concurrency group on ${key}, ` +
            "so the repository's Actions minutes scale with the number of open pull requests. " +
            "Key a pull request into one repository-level group, or add it to UNBOUNDED_BY_CHOICE " +
            "with the reason it may stay unbounded.",
        ).toBe("");
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
    // This is a diagnostic over the shape the exact assertion above already
    // holds, not a second guard — but it is the assertion that holds the deploy
    // guarantee, because it reads the SHIPPED group and the table constant can be
    // edited to match a wrong group. That is why the message names both things
    // this shape carries, not just the precedence trap: a reader who repointed
    // the non-pull-request leg at github.run_id, re-opening issue 474, is not
    // here because of parentheses.
    for (const [name] of Object.entries(BOUNDED)) {
      expect(
        workflows.get(name)!.concurrency?.group,
        `${name}'s group must be exactly the parenthesised event-class form: a literal prefix, ` +
          "then the two pull-request event names in parentheses, then an &&-gated 'repo-wide' " +
          "arm, then a fallback to github.sha. Two things ride on that shape. The non-pull-request " +
          "leg keys on github.sha so that no push to main shares a group with another event — the " +
          "deploy gate refuses a merged SHA whose check concludes cancelled (issue 474). And the " +
          "pull-request arm must be parenthesised, because && binds tighter than ||: the " +
          "unparenthesised form reads as `a || (b && 'repo-wide') || github.sha`, which gives every " +
          "pull_request run its own SHA group and bounds nothing.",
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

  it("never cancel an in-flight run, because the group is shared by every pull request", () => {
    // Asserted against the value actually shipped in the workflow file, not
    // against BOUNDED's own copy of it, so it cannot be weakened by editing a
    // table. A `true` here — or the event expression that used to be here —
    // lets one contributor's push cancel a peer's RUNNING run, because the
    // group is repository-level and the run it destroys is not necessarily the
    // author's own. `verify`, `actionlint` and `ratchet-guard` are the required
    // contexts in .github/required-checks.json and ledger-relay mirrors a run
    // conclusion onto them, so that cancellation blocks a pull request that did
    // nothing wrong. Measured over the 370 pull-request arrivals of the 6.13-day
    // window that is ~15 destroyed running runs a day, ~98 on the busiest
    // measured day (the 106 push and 7 dispatch runs key their own SHA and never
    // contend, so they are not in either figure).
    //
    // The message below is careful about what this does and does not buy,
    // because the over-strong version of the claim is the one that was shipped
    // first and it is false: `false` does NOT prevent cancellation. GitHub
    // cancels the PENDING run in a group whatever this flag says, and on this
    // shared group that run can be another pull request's live head with no
    // replacement. The flag governs the running run only; the bound is
    // unaffected either way because the group holds at most one running job
    // regardless. On the non-pull-request leg the same literal also keeps the
    // issue-474 deploy gate satisfied.
    for (const [name] of Object.entries(BOUNDED)) {
      expect(
        workflows.get(name)!.concurrency?.["cancel-in-progress"],
        `${name}'s cancel-in-progress must be the literal boolean false, on every leg. A true ` +
          "destroys a RUNNING run that may belong to a different pull request, and these are " +
          "required contexts. It does not stop GitHub cancelling the group's PENDING run — that " +
          "happens by default and the workflow comments say so — and the bound is unaffected " +
          "either way, since the group holds at most one running job regardless of this flag.",
      ).toBe(false);
    }
  });
});

describe("the per-pull-request group keys", () => {
  it("denies these spellings of a group that means 'this one pull request'", () => {
    // Named for what it asserts, not for a universality the list cannot
    // deliver: the key list is a spelling list, and the docstring above says so
    // and says what closes the gap. The dynamic deny rule alone can only
    // exercise the list against keys some workflow uses today, so on its own it
    // cannot tell you a key is missing from it — dropping `github.head_ref`
    // changed nothing observable until a workflow used it, which is exactly when
    // the omission costs something. Hence the direct assertions.
    //
    // `github.ref_name` is listed against `github.ref` because the match is a
    // substring one: a group naming ref_name is denied, and the message names
    // the key that caught it rather than the one the author wrote.
    for (const [key, reportedAs] of [
      ["github.event.pull_request.number", "github.event.pull_request.number"],
      ["github.event.pull_request.head.ref", "github.event.pull_request.head.ref"],
      ["github.event.pull_request.head.sha", "github.event.pull_request.head.sha"],
      ["github.event.number", "github.event.number"],
      ["github.head_ref", "github.head_ref"],
      ["github.ref", "github.ref"],
      ["github.ref_name", "github.ref"],
    ] as const) {
      expect(
        unboundedGroupKeysIn("some-workflow-${{ " + key + " }}"),
        `a group keyed on ${key} is per-pull-request on a pull_request event and must be denied`,
      ).toContain(reportedAs);
    }
  });

  it("does not deny a repository-level group", () => {
    // The negative direction, so the list cannot be widened until it denies
    // the four groups this repository actually ships.
    for (const group of Object.values(BOUNDED).map((entry) => entry.group)) {
      expect(unboundedGroupKeysIn(group), `${group} is a repository-level group`).toEqual([]);
    }
  });
});

describe("the workflows left unbounded", () => {
  it("each carry a written reason", () => {
    for (const [name, entry] of UNBOUNDED_BY_CHOICE) {
      expect(workflows.has(name), `${name} is listed as unbounded but is not in the workflow directory`).toBe(true);
      expect(
        entry.reason.trim().length,
        `${name} is in UNBOUNDED_BY_CHOICE without a reason, so the default-deny above is disabled for it`,
      ).toBeGreaterThan(0);
      expect(entry.reason.length, `${name}'s reason must be a justification, not a stub`).toBeGreaterThan(80);
    }
  });

  it("ship exactly the group, cancel-in-progress and queue recorded beside the reason", () => {
    // Two workflows sharing a group cancel each other's PENDING runs whatever
    // each one's own reason says, so a collision is a correctness change and not
    // a cosmetic one — but nothing in this suite used to pin an exception's
    // group, so pointing pr-gate's at `ci-repo-wide` left the whole file green
    // and only an older suite's whole-block pin noticed. This is that pin.
    //
    // The whole block, not three keys read one at a time: a `queue` that appears
    // or disappears is a change in what GitHub does with a pending arrival, and
    // comparing the object makes that change fail here whether it is on
    // claim.yml — whose reason depends on the queue — or on an exception that
    // has no queue and should not have grown one.
    for (const [name, entry] of UNBOUNDED_BY_CHOICE) {
      expect(workflows.get(name)!.concurrency, `${name}'s concurrency block`).toEqual({
        group: entry.group,
        "cancel-in-progress": entry["cancel-in-progress"],
        queue: entry.queue,
      });
    }
  });

  it("never share a group with each other or with a bounded workflow", () => {
    // The failure the exact pins above cannot see: two different workflows can
    // each ship the group their own entry records and still collide, because
    // the collision is in the resolved string, not in either file. A constant
    // group (`ledger-relay`) is the case that needs this most — it is not
    // derived from a pull request, so nothing else about it looks unusual.
    const groups = new Map<string, string[]>();
    for (const [name, workflow] of workflows) {
      const group = String(workflow.concurrency?.group ?? "");
      groups.set(group, [...(groups.get(group) ?? []), name]);
    }
    const collisions = [...groups.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([group, names]) => `${names.join(" and ")} both resolve to "${group}"`);
    expect(
      collisions,
      "two workflows in one concurrency group cancel each other's pending runs, so a shared " +
        "group is a correctness change for both of them at once",
    ).toEqual([]);
  });

  it("keeps the premise each reason names", () => {
    // The premise these reasons rest on is NOT that `cancel-in-progress: false`
    // prevents cancellation — it does not, for the pending run. It is that each
    // exception's GROUP is scoped to one unit of work, so that the pending run
    // GitHub drops is always that same unit's superseded attempt and a
    // replacement exists. `cancel-in-progress: false` is a second, independent
    // part of the same premise: without it the RUNNING attempt is destroyed too,
    // and for these workflows that is work nobody re-runs — the first of two
    // /claim racers, the run that repairs an already-closed pull request, the
    // relay that posts the check-runs. So the flag is asserted because flipping
    // it makes each stated reason false, not because it is what the reason is
    // about.
    for (const [name, entry] of UNBOUNDED_BY_CHOICE) {
      if (!isPullRequestReachable(workflows.get(name)!.on)) continue;
      expect(
        workflows.get(name)!.concurrency?.["cancel-in-progress"],
        `${name} is listed as unbounded on a reason about work a cancellation would lose, but its ` +
          "cancel-in-progress is not the literal false that reason depends on — either it now " +
          "cancels, or it has gained a pull request trigger its reason says it does not receive",
      ).toBe(false);
      expect(entry.reason).toMatch(/cancel/i);
    }
  });

  it("never covers a workflow that produces a required check", () => {
    // The mechanical half of the de-bounding guard, and the only one in the
    // suite. Moving ci.yml, actionlint.yml or ratchet-guard.yml out of BOUNDED
    // and reverting its group passes every other assertion here, because the
    // table entry can move with the workflow — that escape needs a two-line
    // diff and looks like housekeeping. Those three are exactly the workflows
    // whose job names appear in .github/required-checks.json, and a required
    // context is the one thing this repository cannot afford to have quietly
    // unbounded, so it cannot be exempted from the bound at all. A workflow that
    // legitimately needs its own group per unit of work (pr-gate.yml, keyed on
    // the pull request number) is not a required context and is unaffected.
    const required = requiredCheckWorkflows();
    expect([...required].sort(), ".github/required-checks.json must name workflows this suite can read")
      .not.toEqual([]);
    for (const name of required) {
      expect(
        UNBOUNDED_BY_CHOICE.has(name),
        `${name} produces a required check context, so it must stay in BOUNDED. Moving it here ` +
          "and reverting its group passes every other assertion in this file, which is exactly why " +
          "it needs a mechanical guard rather than a reviewer's memory.",
      ).toBe(false);
      expect(workflows.has(name), `${name} is a required-check workflow but is not in the directory`).toBe(true);
    }
  });

  it("are never one of the bounded workflows", () => {
    for (const name of UNBOUNDED_BY_CHOICE.keys()) {
      expect(Object.hasOwn(BOUNDED, name), `${name} is both bounded and left unbounded`).toBe(false);
    }
  });
});

/**
 * The workflow filenames whose jobs are required check contexts, read from
 * .github/required-checks.json rather than hardcoded — the same file the deploy
 * gate resolves through, so a required check added there is covered here without
 * editing this suite. A path is taken as a basename, and anything that does not
 * resolve to a workflow in the directory is left for the caller's
 * `workflows.has` assertion to name.
 */
function requiredCheckWorkflows(): string[] {
  // Typed as `unknown` and narrowed, not as `Record<string, string>`: a future
  // object- or array-valued entry would otherwise throw a bare TypeError from
  // `.split` with no actionable message, which reads as a broken test rather
  // than a contract that needs updating.
  const pins: unknown = JSON.parse(readFileSync(resolve(".github/required-checks.json"), "utf8"));
  const paths = pins && typeof pins === "object" ? Object.values(pins) : [];
  return [
    ...new Set(
      paths
        .filter((value): value is string => typeof value === "string")
        .map((path) => path.split("/").pop()!),
    ),
  ];
}

/** True when any of the two fork-reachable events appears in a workflow's `on` block. */
function isPullRequestReachable(on: unknown): boolean {
  const keys = Array.isArray(on) ? on : typeof on === "string" ? [on] : Object.keys((on ?? {}) as object);
  return keys.some((key) => PR_EVENTS.includes(String(key)));
}
