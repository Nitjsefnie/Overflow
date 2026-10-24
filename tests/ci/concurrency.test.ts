import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Every workflow is classified in BOUNDED, PER_PR_REQUIRED or
 * UNBOUNDED_BY_CHOICE; the tables pin the concurrency policy read from parsed YAML.
 *
 * BOUNDED workflows share one repository-level group per workflow across pull
 * requests. Their other event legs key on github.sha, so different commits
 * have separate groups. Literal cancel-in-progress false preserves every
 * running attempt. GitHub keeps one pending run per group by default and
 * replaces it on a newer arrival, so it can drop another pull request's head
 * with no replacement; literal queue max holds up to 100 pending runs instead.
 *
 * PER_PR_REQUIRED pins the privileged aggregate per pull request: every
 * newer event reissues all four required contexts for its head.
 *
 * UNBOUNDED_BY_CHOICE records a reason and the exact group, cancellation flag
 * and queue for each exception. Groups isolate the units of work named in
 * their reasons; queue is pinned where preserving pending arrivals needs it.
 * For PR-reachable exceptions, the unreproducible premise requires literal
 * false to preserve running work. The superseded-attempt premise permits
 * cancellation within one pull request, whose newer push supplies the
 * replacement, and excludes required contexts.
 * Code scanning and event policy use this premise: their per-PR groups cancel
 * older runs only on pull_request; their SHA-keyed non-PR legs never cancel
 * running work. A pull_request-only workflow may use literal true.
 *
 * The directory-wide structural rule also covers job-level concurrency:
 * any PR-reachable block that can enable cancellation must include
 * github.event.pull_request.number in its group and never the literal
 * repo-wide. Expressions are conservatively treated as potentially enabling
 * cancellation, so a shared group cannot cancel another pull request's run.
 *
 * Exact table pins, classification coverage, trigger reachability and group
 * collision checks complement that rule. Assertions use parsed YAML so
 * formatting changes do not alter the guarantees.
 */

type Workflow = {
  on: unknown;
  concurrency?: { group?: unknown; "cancel-in-progress"?: unknown; queue?: unknown };
  jobs?: Record<string, unknown>;
};

/**
 * The metered workflows this repository bounds, with the exact group,
 * cancel-in-progress and queue each carries. Written out per workflow rather than
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
 * It does not stop GitHub cancelling the group's PENDING run; the queue does,
 * up to 100 (see the header).
 */
// Comment share serializes PR measurements; completion-driven verify is
// explicitly classified and checked per head SHA below.
const BOUNDED: Record<string, { group: string; "cancel-in-progress": false; queue: "max" }> = {
  "comment-share.yml": {
    group: "comment-share-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
    "cancel-in-progress": false,
    queue: "max",
  },
};

/** Required PR gates cancel only an older run of the same pull request. */
const PER_PR_REQUIRED = {
  "pr-gates.yml": {
    group: "pr-gates-${{ github.event.pull_request.number }}",
    "cancel-in-progress": true,
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
 * A shared group makes its members wait behind one running job and, at the
 * default single pending slot, cancels the older pending run even at
 * `cancel-in-progress: false`. The bound caps metered minutes, and the bounded
 * workflows queue their pending arrivals; each exception's reason defends the
 * group or cancellation setting it ships.
 */
/**
 * The closed vocabulary of cancellation premises, and the ONE place it is
 * written. `Premise`, the table's `premise` field and `premiseOf` are all
 * derived from it, so a value is added in exactly one edit.
 *
 * It exists as a value and not only as a type because the type alone is not a
 * check. A union rejects a misspelling at compile time and says nothing about
 * whether this suite knows what to DO with a premise that typechecks — which is
 * how a widened union leaves an entry falling through every branch to the one
 * default, checked by nothing. So the vocabulary is paired with
 * `CANCELLATION_LICENCE` below, one rule per value, and the table entry's
 * premise is asserted against the rule keys rather than against the vocabulary:
 * adding a value means adding a rule, and an entry carrying a premise with no
 * rule fails here by name.
 */
export const PREMISES = ["unreproducible", "superseded-attempt"] as const;

/** A premise is one of the values {@link PREMISES} names, and nothing else. */
type Premise = (typeof PREMISES)[number];

/**
 * What cancellation each premise licenses, keyed by the premise itself and
 * exhaustive over {@link PREMISES} — a value added there without a rule here
 * does not typecheck, and an entry recording a premise with no rule here fails
 * the "records only a premise this suite knows how to check" assertion. The
 * `satisfies` is what makes the pairing total in the compiler's direction; the
 * keys are what make it checkable at run time.
 */
const CANCELLATION_LICENCE = {
  "unreproducible":
    "the literal `false`: nothing re-runs the unit's work, so the RUNNING attempt must survive too",
  "superseded-attempt":
    "the pull-request event expression: the group is scoped to one pull request, so every run it "
    + "cancels is that same pull request's own superseded head",
} satisfies Record<Premise, string>;

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
  /**
   * What makes a cancellation acceptable for this workflow, recorded so the
   * assertion that checks `cancel-in-progress` reads the right rule rather
   * than one rule applied to two situations. Absent means
   * `"unreproducible"`.
   *
   * - `"unreproducible"` — the run is work nobody re-runs: the first of two
   *   /claim racers, the run that repairs an already-closed pull request, the
   *   relay that posts the check-runs. `cancel-in-progress` must be the
   *   literal `false`.
   * - `"superseded-attempt"` — the GROUP is scoped to one pull request, so
   *   every run GitHub cancels (pending by default, running if the flag says
   *   so) is that same pull request's superseded attempt, and the push that
   *   superseded it scheduled the replacement. `cancel-in-progress` may then be
   *   the pull-request event expression, which buys nothing about the bound
   *   and stops a superseded run accruing minutes.
   *
   * The second premise rests on a further fact, and this file asserts it: such
   * a workflow must not produce a required check. A cancelled run on a
   * required context is the peer's blocked pull request that `false` exists to
   * prevent, and "reproducible from the next push" is not a defence — the next
   * push does not unblock the pull request that is already open. The premise
   * is also narrower than it looks: it covers cancellation WITHIN one pull
   * request, not the pending run GitHub cancels in a default single-slot
   * shared group (see the header).
   */
  premise?: Premise;
}>([
  ["ratchet-push.yml", {
    reason: "Only successful main-push measurements reach this data-only writer. Its static group serializes updates against freshly fetched main, and cancel-in-progress false preserves a running commit and push; a superseded pending measurement is replaced by the newer main measurement.",
    group: "ratchet-push",
    "cancel-in-progress": false,
    queue: undefined,
  }],
  ["ci-pr.yml", {
    reason: "Suite completions can arrive out of head order. Each triggering head SHA gets its own non-cancelling group, so a stale completion cannot destroy the current head's required verify. workflow_run is the only trigger; no runner polls for the suite.",
    group: "ci-pr-${{ github.event.workflow_run.head_sha }}",
    "cancel-in-progress": false,
    queue: undefined,
  }],
  [
    "code-scanning.yml",
    {
      reason:
        "Each pull request has its own scan group, so cancellation drops only that pull request's superseded analysis and its newer push supplies the replacement. Different pull requests never share the group. Push, schedule and dispatch runs key on the SHA and never cancel an in-flight scan.",
      group: "code-scanning-${{ github.event.pull_request.number || github.sha }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      queue: undefined,
      premise: "superseded-attempt",
    },
  ],
  [
    "event-policy.yml",
    {
      reason:
        "Each pull request has its own event-policy group, so cancellation drops only that pull request's superseded policy check and its newer push supplies the replacement. Different pull requests never share the group. Push and schedule runs key on the SHA and never cancel an in-flight check.",
      group: "event-policy-${{ github.event.pull_request.number || github.sha }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
      queue: undefined,
      premise: "superseded-attempt",
    },
  ],
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
        "The relay posts the check-runs branch protection requires. Every schedule, workflow_dispatch (with or without run_id), and workflow_run start shares the literal ledger-relay group, so only one relay run writes at a time across the repository. cancel-in-progress false preserves the running start. Up to 100 pending starts wait in FIFO order (ordering is not guaranteed); a full queue cancels the new arrival. Every start sweeps to attest a cancelled arrival's producer within the sweep window.",
      group: "ledger-relay",
      "cancel-in-progress": false,
      queue: "max",
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
        "No PR event reaches this main producer. The secret-scan PR job lives in pr-gates.yml with a per-PR cancelling group. This file checks main on push and dispatch and schedule. Its SHA-keyed group preserves every in-flight run, so another merged SHA cannot cancel a conclusion that deployment reads.",
      group: "secret-scan-${{ github.sha }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "actionlint.yml",
    {
      reason:
        "No PR event reaches this main producer. The actionlint PR job lives in pr-gates.yml with a per-PR cancelling group. This file checks main on push and dispatch. Its SHA-keyed group preserves every in-flight run, so another merged SHA cannot cancel a conclusion that deployment reads.",
      group: "actionlint-${{ github.sha }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "ratchet-guard.yml",
    {
      reason:
        "No PR event reaches this main producer. The ratchet-guard PR job lives in pr-gates.yml with a per-PR cancelling group. This file checks main on push and dispatch. Its SHA-keyed group preserves every in-flight run, so another merged SHA cannot cancel a conclusion that deployment reads.",
      group: "ratchet-guard-${{ github.sha }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "ci.yml",
    {
      reason:
        "No PR trigger reaches this main producer. The verify PR job lives in ci-pr.yml. Its legs are push to main and workflow_dispatch — the latter being the deploy-recovery dispatch — and the group is per-SHA so no push to main shares a group with another push: a cancelled conclusion on a merged SHA makes the deploy gate refuse immediately (issue 474). A workflow with no pull_request and no pull_request_target event cannot be listed in BOUNDED at all, because the bound it would carry would be vacuous: the repository-level arm is dead code, so recording it would pin a promise no run exercises.",
      group: "ci-${{ github.sha }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "dependency-audit.yml",
    {
      reason:
        "No PR event reaches this main producer. The dependency-audit PR job lives in pr-gates.yml with a per-PR cancelling group. This file checks main on push and dispatch and schedule. Its SHA-keyed group preserves every in-flight run, so another merged SHA cannot cancel a conclusion that deployment reads.",
      group: "dependency-audit-${{ github.sha }}",
      "cancel-in-progress": false,
      queue: undefined,
    },
  ],
  [
    "pr-suite.yml",
    {
      reason:
        "This is where a pull request's own code runs, under pull_request with a read-only token, and its outcome is read by ci-pr.yml's verify job for the event's exact head SHA. Its group is scoped to ONE pull request, so a run it cancels is always that same pull request's superseded head, never a peer's, and the push that superseded it scheduled the replacement run verify then awaits. Bounding it repository-wide would make every open pull request's verify wait behind every other's suite. It triggers on pull_request alone, so the literal true is the pull-request event expression with no other leg to cancel, and it names no required context: verify, not this workflow, carries the required check.",
      group: "pr-suite-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
      queue: undefined,
      premise: "superseded-attempt",
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
 * An entry's recorded premise, defaulted. A separate function rather than an
 * `??` at each use so the default lives in one place: the two assertion sites
 * below must agree on which entries are checked against which rule, and a
 * default written twice is a default that can drift. The return type is
 * `Premise`, so the default is itself a value {@link PREMISES} names rather
 * than a literal that could drift away from the vocabulary.
 */
function premiseOf(entry: { premise?: Premise }): Premise {
  return entry.premise ?? "unreproducible";
}

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
  "run-name",
];

/**
 * Exact job-name sets for every workflow. Equality in the assertion below
 * denies both a job the workflow does not carry and a workflow job absent from
 * this table. The independent directory guard denies stale workflow rows and
 * requires every file in `.github/workflows/` to have a row.
 */
const ALLOWED_JOB_NAMES: Record<string, readonly string[]> = {
  // Issue 1090: each of these four pairs carries the same job name in BOTH
  // legs, so a required-context conclusion arrives on a pull-request head and
  // on a main push alike. The name is deliberately NOT suffixed — the
  // check-run name is what branch protection and .github/required-checks.json
  // match.
  "actionlint.yml": ["actionlint"],
  "ci-pr.yml": ["verify"],
  "ci.yml": ["calibrate", "postgres-image", "push-recalibration", "shellcheck", "verify"],
  "claim.yml": ["claim"],
  "code-scanning.yml": ["analyze"],
  "comment-share.yml": ["comment-share"],
  "coverage-comment.yml": ["comment"],
  "dependency-audit.yml": ["dependency-audit"],
  "event-policy.yml": ["event-policy", "event-policy-pull-request"],
  "ledger-relay.yml": ["relay-required-checks"],
  "pr-gate.yml": ["gate"],
  "pr-gates.yml": ["actionlint", "ratchet-guard", "secret-scan", "dependency-audit"],
  "pr-suite.yml": ["postgres-image", "suite"],
  "ratchet-guard.yml": ["ratchet-guard"],
  "ratchet-push.yml": ["push"],
  "scorecard.yml": ["analysis"],
  "secret-scan.yml": ["secret-scan"],
};

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

  it("never allows `env`, because allowing it reopens the hole it was absent for", () => {
    expect(
      ALLOWED_TOP_LEVEL_KEYS,
      "`env` must never appear in ALLOWED_TOP_LEVEL_KEYS. It is absent on purpose, and adding " +
        "it here reopens exactly the hole it is absent for: a top-level `env:` block planting an " +
        "unpinned `${{ github.repository }}` then passes this file whole, and passes actionlint and " +
        "zizmor as well, because a key the suite has agreed to allow is a key the suite no longer " +
        "looks at. The rot guard above does not catch that edit either, since the planted block " +
        "makes the entry genuinely spent. The allowlist is the mechanism precisely because a " +
        "denylist would have to name `env` here to catch this, and would then pass the next " +
        "unasserted key nobody had thought of. If you are adding a legitimate top-level key, it is " +
        "not `env` and the fix is to assert the key, not to delete it from your workflow — a " +
        "per-job `env:` block keeps the guarantee while scoping it to the job that reads it.",
    ).not.toContain("env");
  });
});

function collectWorkflowJobChecks() {
  const checkedNames: string[] = [];
  const offenders: string[] = [];
  for (const [name, workflow] of workflows) {
    checkedNames.push(name);
    const actual = Object.keys(workflow.jobs ?? {}).sort();
    const expected = [...(ALLOWED_JOB_NAMES[name] ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      offenders.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  return { checkedNames, offenders };
}

describe("every workflow's jobs", () => {
  it("enumerates each workflow's complete job-name set", () => {
    const { offenders } = collectWorkflowJobChecks();
    expect(
      offenders.join("; ") || "(none)",
      "these workflows do not carry exactly the job names in ALLOWED_JOB_NAMES: " +
        (offenders.join("; ") || "(none)"),
    ).toBe("(none)");
  });

  it("decides every workflow in the directory", async () => {
    // checkedNames comes from the loop that makes the exact job comparison.
    // The expected side re-reads the directory. Comparing that read to a
    // second workflows.keys() list would pass if the jobs loop stopped running.
    // The table-name comparisons also name missing or stale ALLOWED_JOB_NAMES
    // rows; exact job-set equality catches a table job absent from its workflow.
    const directory = resolve(".github/workflows");
    const directoryNames = (await readdir(directory))
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .sort();
    const { checkedNames } = collectWorkflowJobChecks();
    const sortedCheckedNames = [...checkedNames].sort();
    const loadedNames = [...workflows.keys()].sort();
    const tableNames = Object.keys(ALLOWED_JOB_NAMES).sort();
    const offenders = [
      ...directoryNames
        .filter((name) => !Object.hasOwn(ALLOWED_JOB_NAMES, name))
        .map((name) => `${name} is in .github/workflows but has no ALLOWED_JOB_NAMES entry`),
      ...tableNames
        .filter((name) => !directoryNames.includes(name))
        .map((name) => `${name} is in ALLOWED_JOB_NAMES but absent from .github/workflows`),
      ...directoryNames
        .filter((name) => !workflows.has(name))
        .map((name) => `${name} is in .github/workflows but absent from the workflows Map`),
      ...loadedNames
        .filter((name) => !directoryNames.includes(name))
        .map((name) => `${name} is in the workflows Map but absent from .github/workflows`),
      ...directoryNames
        .filter((name) => !checkedNames.includes(name))
        .map((name) => `${name} is in .github/workflows but was not checked by the jobs assertion`),
      ...checkedNames
        .filter((name) => !directoryNames.includes(name))
        .map((name) => `${name} was checked by the jobs assertion but is absent from .github/workflows`),
    ];

    expect(
      offenders.join("; ") || "(none)",
      "every workflow's jobs must be decided by ALLOWED_JOB_NAMES and loaded from the directory: " +
        (offenders.join("; ") || "(none)"),
    ).toBe("(none)");
    expect(
      sortedCheckedNames,
      "the workflows actually checked by the jobs assertion must match a fresh directory read",
    ).toEqual(directoryNames);
  });
});

describe("every workflow's concurrency block", () => {
  it("keys any pull-request cancellation per pull request, never repo-wide", () => {
    for (const [name, workflow] of workflows) {
      if (!isPullRequestReachable(workflow.on)) continue;
      const blocks = [
        [name, workflow.concurrency],
        ...Object.entries(workflow.jobs ?? {}).map(([jobName, job]) => [
          `${name}/${jobName}`,
          (job as { concurrency?: Workflow["concurrency"] }).concurrency,
        ] as const),
      ] as const;
      for (const [scope, concurrency] of blocks) {
        const cancellation = concurrency?.["cancel-in-progress"];
        // Conservatively treat expressions as potentially cancelling a PR;
        // only a literal false proves cancellation is disabled structurally.
        if (cancellation === undefined || cancellation === false) continue;
        const group = String(concurrency?.group ?? "");
        expect(
          group,
          `${scope} can cancel a pull-request run, so its group must never contain repo-wide`,
        ).not.toContain("repo-wide");
        expect(
          group,
          `${scope} can cancel a pull-request run, so its group must key on github.event.pull_request.number`,
        ).toContain("github.event.pull_request.number");
      }
    }
  });

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
      if (UNBOUNDED_BY_CHOICE.has(name) || Object.hasOwn(PER_PR_REQUIRED, name)) continue;
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
    const classified = [...Object.keys(BOUNDED), ...Object.keys(PER_PR_REQUIRED), ...UNBOUNDED_BY_CHOICE.keys()].sort();
    expect([...workflows.keys()].sort()).toEqual(classified);
  });
});

describe("the per-pull-request required gates", () => {
  it("isolates superseded runs and reaches every gate on every PR event", () => {
    for (const [name, expected] of Object.entries(PER_PR_REQUIRED)) {
      const workflow = workflows.get(name);
      expect(workflow, `${name} must exist`).toBeDefined();
      expect(workflow!.concurrency).toEqual(expected);
      expect(pullRequestTriggerKeys(workflow!.on)).toEqual(["pull_request_target"]);
      expect(requiredCheckWorkflows()).toContain(name);
    }
  });
});

describe("the bounded workflows", () => {
  it("carry the exact event-class group, cancel-in-progress and queue", () => {
    for (const [name, expected] of Object.entries(BOUNDED)) {
      expect(workflows.get(name)!.concurrency, `${name}'s concurrency block`).toEqual({
        group: expected.group,
        "cancel-in-progress": expected["cancel-in-progress"],
        queue: expected.queue,
      });
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
    for (const [name] of Object.entries(BOUNDED)) {
      expect(
        workflows.get(name)!.concurrency?.["cancel-in-progress"],
        `${name}'s cancel-in-progress must be the literal boolean false, on every leg. A true ` +
          "destroys a RUNNING run that may belong to a different pull request, and these are " +
          "required contexts. It does not stop GitHub cancelling the group's PENDING run — that " +
          "happens by default, which is why the bounded workflows also carry queue max — and the bound is unaffected " +
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
    // the repository-wide groups this policy table actually records.
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
    const required = new Set(requiredCheckWorkflows());
    for (const [name, entry] of UNBOUNDED_BY_CHOICE) {
      const premise = premiseOf(entry);
      const reachable = isPullRequestReachable(workflows.get(name)!.on);
      const shipped = workflows.get(name)!.concurrency?.["cancel-in-progress"];
      if (premise === "superseded-attempt") {
        // Asserted whether or not the workflow is currently reachable: this
        // premise CLAIMS a pull-request trigger, so a workflow that loses one
        // has made its recorded reason false. Skipping it as "not applicable"
        // is what let a reverted pull_request trigger through this file green
        // while its reason still talked about one.
        expect(
          reachable,
          `${name} claims cancellation is safe because its group is scoped to one pull request, but ` +
            "the workflow is not reachable from a pull request, so the group it ships is per-ref and " +
            "the premise describes a run that never arrives",
        ).toBe(true);
        // Which fork-reachable event, not whether there is one. The premise is
        // argued for `pull_request`, and only for it: under `pull_request` the
        // run executes the pull request's own tree with a read-only token, so a
        // superseded run is work the next push reproduces. Under
        // `pull_request_target` the run executes the BASE repository's
        // definition and tools instead, which is why this repository carries
        // `zizmor: ignore[dangerous-triggers]` on the four workflows that use
        // it. Asserting plain reachability let `pull_request_target` satisfy
        // these checks with its premise unargued.
        expect(
          pullRequestTriggerKeys(workflows.get(name)!.on),
          `${name} claims its cancelled runs are a pull request's own superseded heads, but it does `
            + "not trigger on `pull_request`. That premise is about the pull request's own tree "
            + "reproducing from the next push, which `pull_request_target` — running the base "
            + "repository's definition — does not give it.",
        ).toContain("pull_request");
        expect(
          pullRequestTriggerKeys(workflows.get(name)!.on),
          `${name} carries a pull_request_target leg while claiming the superseded-attempt premise. `
            + "That trigger runs in the base repository's context, so re-decide this entry against it "
            + "rather than letting the pull_request leg vouch for both.",
        ).not.toContain("pull_request_target");
        expect(
          unboundedGroupKeysIn(String(entry.group)),
          `${name} claims cancellation is safe because every run its group holds is one pull ` +
            `request's superseded attempt, but its group is not keyed on a pull request: ${entry.group}`,
        ).toContain("github.event.pull_request.number");
        // A workflow whose ONLY trigger is pull_request may ship the literal
        // true: on it the pull-request event expression is always true, so
        // the two are the same flag, with no other leg for it to cancel.
        const onlyPullRequest =
          Object.keys(workflows.get(name)!.on ?? {}).join(",") === "pull_request";
        expect(
          onlyPullRequest && shipped === true ? "${{ github.event_name == 'pull_request' }}" : shipped,
          `${name} records the "${premise}" premise, which licenses ` +
            `${CANCELLATION_LICENCE[premise]}. It may cancel in flight only on a pull-request ` +
            "event, where its group is scoped to that one pull request and the push that superseded " +
            "the run scheduled its replacement. The literal true would also cancel the daily tick " +
            "and a push run; an expression naming another event would cancel work no push supersedes.",
        ).toBe("${{ github.event_name == 'pull_request' }}");
        expect(
          required.has(name),
          `${name} may let a superseded pull request's run conclude cancelled only because nothing ` +
            "waits on that conclusion. Naming it in .github/required-checks.json makes it merge-blocking, " +
            "and a cancelled run on a required context blocks the pull request no later push unblocks — " +
            "re-decide this entry before that edit.",
        ).toBe(false);
        continue;
      }
      if (!reachable) continue;
      // Back inside its original guard. Refactoring this loop hoisted it above
      // the reachability check, which widened a pre-existing assertion to
      // every entry in the table — including workflows this one is not about,
      // like secret-scan.yml, which has no pull-request trigger at all. The
      // widening was a side effect of the edit, not a decision, so the scope it
      // had on main is the scope it keeps here.
      expect(entry.reason).toMatch(/cancel/i);
      expect(
        shipped,
        `${name} records the "${premise}" premise, which licenses ` +
          `${CANCELLATION_LICENCE[premise]}. It is listed as unbounded on a reason about work a ` +
          "cancellation would lose, but its cancel-in-progress is not the literal false that reason " +
          "depends on — either it now cancels, or it has gained a pull request trigger its reason " +
          "says it does not receive",
      ).toBe(false);
    }
  });

  it("records only a premise this suite knows how to check", () => {
    // Asserted against the RULES, not against the vocabulary. An earlier
    // version matched `premiseOf(entry)` against a literal alternation of the
    // two values the function could return, which no mutation could turn red:
    // the function is typed to that union, the table supplies only those two,
    // and its `?? "unreproducible"` default is a third copy of one of them.
    // Every value it can produce matched, always, so it was not a runtime check
    // at all — it read as one, and a reviewer trusting it as evidence of a
    // closed vocabulary was wrong.
    //
    // What is checked now is the thing that can actually break: a premise this
    // suite has no rule for. `CANCELLATION_LICENCE` is keyed by premise and
    // exhaustive over the vocabulary, so widening `PREMISES` to a third value
    // without writing that value's rule fails the typecheck AND — because the
    // assertion reads the keys, not the vocabulary — any entry that records the
    // new premise fails here, naming it.
    //
    // The reverse direction is asserted too: a rule for a premise nothing can
    // produce is a branch that checks nothing, which is the same defect wearing
    // the other hat.
    for (const [name, entry] of UNBOUNDED_BY_CHOICE) {
      expect(
        Object.keys(CANCELLATION_LICENCE),
        `${name}'s recorded premise is not one this suite knows how to check: ${premiseOf(entry)}. `
          + "Add its rule to CANCELLATION_LICENCE and the assertion that uses it.",
      ).toContain(premiseOf(entry));
    }
    expect(
      [...Object.keys(CANCELLATION_LICENCE)].sort(),
      "CANCELLATION_LICENCE names a premise PREMISES does not, so its rule can never be reached",
    ).toEqual([...PREMISES].sort());
  });

  it("never covers a workflow that produces a required check", () => {
    const required = requiredCheckWorkflows();
    expect([...required].sort(), ".github/required-checks.json must name workflows this suite can read")
      .not.toEqual([]);
    let reachableCount = 0;
    for (const name of required) {
      const workflow = workflows.get(name);
      expect(workflow, `${name} is a required-check workflow but is not in the directory`).toBeDefined();
      if (!isPullRequestReachable(workflow!.on)) continue;
      reachableCount += 1;
      expect(
        Object.hasOwn(BOUNDED, name) || Object.hasOwn(PER_PR_REQUIRED, name),
        `${name} is a pull-request-reachable required-check workflow, so it belongs in BOUNDED or PER_PR_REQUIRED with ` +
          "its explicitly checked group. An UNBOUNDED_BY_CHOICE entry records an exception carrying a " +
          "written reason, and a required context is not an exception.",
      ).toBe(true);
    }
    // The guard above reads a filter, so an empty filter passes it vacuously.
    // This is what says the filter is not empty: at least one pinned producer
    // must actually receive a pull-request event, which after issue 1090's
    // split is the `-pr.yml` leg of each split context.
    expect(
      reachableCount,
      "no pinned required-check workflow receives a pull-request event, so the guard above " +
        "iterated over nothing and the bound it enforces is unasserted for every context.",
    ).toBeGreaterThan(0);
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
 * editing this suite. A pin may name several files (issue 1090's split), so
 * every path of every pin is read; dropping the list form would let a
 * required-check workflow escape the bound this suite enforces. A path is taken
 * as a basename, and anything that does not resolve to a workflow in the
 * directory is left for the caller's `workflows.has` assertion to name.
 */
function requiredCheckWorkflows(): string[] {
  // Typed as `unknown` and narrowed, not as `Record<string, string>`: a future
  // object-valued entry would otherwise throw a bare TypeError from `.split`
  // with no actionable message, which reads as a broken test rather than a
  // contract that needs updating.
  const pins: unknown = JSON.parse(readFileSync(resolve(".github/required-checks.json"), "utf8"));
  const values = pins && typeof pins === "object" ? Object.values(pins) : [];
  const paths = values.flatMap((value) => (typeof value === "string" ? [value] : Array.isArray(value) ? value : []));
  return [
    ...new Set(
      paths
        .filter((value): value is string => typeof value === "string")
        .map((path) => path.split("/").pop()!),
    ),
  ];
}

/**
 * The fork-reachable events a workflow's `on` block actually names, as keys.
 *
 * Returned rather than reduced to a boolean because the two call sites need
 * different things from it: `isPullRequestReachable` asks only whether such an
 * event is present at all, and the `superseded-attempt` premise asks WHICH one —
 * `pull_request` and `pull_request_target` both make a workflow reachable, and
 * only the first is the input that premise was argued for.
 */
function pullRequestTriggerKeys(on: unknown): string[] {
  const keys = Array.isArray(on) ? on : typeof on === "string" ? [on] : Object.keys((on ?? {}) as object);
  return keys.map(String).filter((key) => PR_EVENTS.includes(key));
}

/** True when any of the two fork-reachable events appears in a workflow's `on` block. */
function isPullRequestReachable(on: unknown): boolean {
  return pullRequestTriggerKeys(on).length > 0;
}
