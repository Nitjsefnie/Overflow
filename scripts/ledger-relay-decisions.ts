#!/usr/bin/env node
// The ledger relay's PURE DECISION LAYER (issue 885 polish): everything the
// relay decides from data it has already been handed, with no IO, no clock and
// no environment. scripts/ledger-relay.ts holds the wiring and the API calls;
// scripts/ledger-relay-sweep.ts holds the sweep; both reach their decisions
// through here, which is what lets either of them reach the other without
// either importing the other.
//
// It imports NOTHING from either sibling: a decision layer that reached back
// into a sibling for a type or a constant would be neither pure nor honest
// about where it ends. The relay entry re-exports every symbol here, so the
// public surface it has always presented is unchanged.

/** One job of the triggering run, as the jobs listing reports it. The API's field names are kept so the listing's JSON maps straight through. */
export interface RelayJob {
  name: string;
  run_attempt: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
}

/** What the relay will post for one required context. */
export interface ContextDecision {
  context: string;
  /** The check-run status to post. */
  status: "queued" | "in_progress" | "completed";
  /** The conclusion, present exactly when status is completed. */
  conclusion?: string;
  title: string;
  summary: string;
}

export const PIN_SHAPE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * One required context's producer workflow paths: the single path every
 * committed entry uses, or a non-empty list of them.
 *
 * The list form exists because issue 1090 splits a workflow that reads
 * pull-request data out of its privileged triggers, which leaves one required
 * context produced by TWO workflow files — a `pull_request_target` leg and a
 * `push`/`workflow_dispatch` leg. A context pinned to a single path cannot
 * name both, and the paths it does not name are not merely unverified: the
 * relay's "nothing is pinned to this run's workflow" branch makes them
 * SILENT, so the second file's completions post no App check-run at all.
 *
 * Read through {@link pinsFor} everywhere rather than narrowed by hand, so a
 * consumer cannot learn the shape by accident and split on it.
 */
export type ContextPins = string | readonly string[];

/** The pin map: each required context, and the workflow paths that may attest it. */
export type PinMap = Readonly<Record<string, ContextPins>>;

/**
 * The paths one context's pin names, whichever form it is written in. The only
 * place the two forms are distinguished.
 */
export function pinsFor(pins: ContextPins): readonly string[] {
  return typeof pins === "string" ? [pins] : pins;
}

/** The base branch: the one protected ref whose workflow definitions the relay trusts. */
const BASE_BRANCH = "main";

/** Events whose run executes the definition at the ref it names — trusted only when that ref is the base branch. */
const EVENTS_TRUSTED_ON_BASE_BRANCH = new Set(["push", "workflow_dispatch", "schedule"]);

/**
 * Whether a producer run may attest a required context: trusted when the
 * workflow definition the run EXECUTED is the base branch's, within the
 * write-access assumptions the bullets below state. A required context is
 * evidence about the job that judged the commit, so it is only worth relaying
 * when that job's definition is one a pull request cannot shape. The pin map
 * binds a context to a workflow path; this binds it to the definition at that
 * path being main's.
 *
 * An allowlist, so an event GitHub adds later, or one a producer gains by
 * mistake, is refused until it is reasoned about here:
 *
 * - `pull_request_target` runs the definition on the pull request's TARGET
 *   branch, not its head, so the head branch says nothing about the
 *   definition and is not consulted. On main, every pinned producer restricts
 *   that trigger to `branches: [main]`. A definition on any other target
 *   branch exists only because someone with write access created it, which
 *   is the same trust class as a push or a dispatch on a branch. The run
 *   record does not carry the target branch in a form the relay can read for
 *   a run from a fork, so the relay does not check it and trusts this event
 *   on that basis.
 * - `push`, `workflow_dispatch` and `schedule` run the definition at the ref
 *   they name — the pushed branch, the dispatched ref, the default branch. That
 *   definition is the base branch's only when the ref is exactly `main`. The
 *   check compares the ref's short name, so a non-branch ref — a tag — named
 *   `main` passes it too; such a ref exists only through write access, the
 *   same accepted trust class as the target-branch case above.
 * - Every other event is refused — `pull_request` (which executes the
 *   definition the pull request carries), the comment and review events,
 *   `merge_group`, `workflow_run`, an empty event and any unknown value.
 *
 * Both comparisons are exact: no prefix, no case folding, no `refs/heads/`
 * form, because a near match is a different ref.
 */
export function isTrustedProducerRun(event: string, headBranch: string): boolean {
  if (event === "pull_request_target") return true;
  return EVENTS_TRUSTED_ON_BASE_BRANCH.has(event) && headBranch === BASE_BRANCH;
}

/**
 * The relay's core. Contexts come from the pin map entries whose pin NAMES the
 * triggering run's path — every path of a list pin, in pin-map order, and one
 * decision per context however many of its paths match. For each:
 *
 * - jobs named exactly the context: the highest run_attempt decides, and on
 *   an attempt tie a non-success replaces a success — the deploy gate's
 *   tie-break, so a tie can only hold the deploy back;
 * - a job that is not completed posts its pending status, which branch
 *   protection reads as waiting;
 * - a completed job mirrors its conclusion;
 * - jobs exist but none named the context: failure naming the missing job and
 *   the pinned path, so a renamed producer is visible and blocking, not
 *   silence;
 * - no jobs at all: the run-level outcome is the only evidence. success
 *   mirrors as success; any other conclusion (failure, cancelled, or a
 *   workflow-level failure before any job was created) mirrors as failure —
 *   neutral outcomes fail closed.
 */
export function decideContexts(
  pinMap: PinMap,
  runPath: string,
  runConclusion: string | null,
  jobs: readonly RelayJob[],
): ContextDecision[] {
  const decisions: ContextDecision[] = [];
  for (const [context, pins] of Object.entries(pinMap)) {
    if (!pinsFor(pins).includes(runPath)) continue;
    decisions.push(decideOne(context, runPath, runConclusion, jobs));
  }
  return decisions;
}

function decideOne(
  context: string,
  runPath: string,
  runConclusion: string | null,
  jobs: readonly RelayJob[],
): ContextDecision {
  const candidates = jobs.filter((job) => job.name === context);
  if (candidates.length === 0) {
    if (jobs.length > 0) {
      return {
        context,
        status: "completed",
        conclusion: "failure",
        title: `${context}: no producing job`,
        summary:
          `No job named "${context}" ran in ${runPath}, though the run produced other jobs. ` +
          "The pinned producer may have been renamed; branch protection stays blocked.",
      };
    }
    if (runConclusion === "success") {
      return {
        context,
        status: "completed",
        conclusion: "success",
        title: `${context}: success`,
        summary:
          `The triggering run of ${runPath} concluded success with no job records to mirror; ` +
          "the run-level outcome is relayed.",
      };
    }
    return {
      context,
      status: "completed",
      conclusion: "failure",
      title: `${context}: workflow-level failure`,
      summary:
        `The triggering run of ${runPath} concluded ${conclusionWord(runConclusion)} with no ` +
        "job records to mirror; the pinned contexts cannot be attested. " +
        "Branch protection stays blocked.",
    };
  }
  let best = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (
      candidate.run_attempt > best.run_attempt ||
      (candidate.run_attempt === best.run_attempt && !isCompletedSuccess(candidate))
    ) {
      best = candidate;
    }
  }
  if (best.status === "completed") {
    const conclusion = best.conclusion ?? "failure";
    return {
      context,
      status: "completed",
      conclusion,
      title: `${context}: ${conclusion}`,
      summary:
        `Job "${context}" (attempt ${best.run_attempt}) in ${runPath} concluded ${conclusion}; ` +
        "the outcome is relayed to branch protection.",
    };
  }
  // A job that has not concluded posts PENDING, and the sweep posts pending for a
  // candidate too, though a candidate is `completed` by selection. Deliberate:
  // an ABSENT check is what branch protection refuses a merge on, a PENDING one
  // is what it waits on. So the sweep counts only CONCLUDED App check-runs as
  // attestations, and the next start supersedes this one.
  return {
    context,
    status: best.status,
    title: `${context}: ${best.status}`,
    summary:
      `Job "${context}" (attempt ${best.run_attempt}) in ${runPath} is ${best.status}; ` +
      "branch protection waits.",
  };
}

function isCompletedSuccess(job: RelayJob): boolean {
  return job.status === "completed" && job.conclusion === "success";
}

function conclusionWord(conclusion: string | null): string {
  return conclusion === null || conclusion === "" ? "without a conclusion" : conclusion;
}

/** A rerun is capped at this attempt, so a flapping heal cannot ping-pong forever. */
export const RERUN_ATTEMPT_CAP = 5;

/** The heal-relevant fields of the triggering run. */
export interface RerunRun {
  conclusion: string | null;
  event: string;
  runAttempt: number;
  /** The run's head commit, compared against the associated PR's tip to detect supersession. */
  headSha: string;
}

/** The one PR the heal found associated with the run's head commit, if any. */
export interface HealPullRequest {
  state: string;
  headSha: string;
}

/**
 * The never-started evidence the rerun-heal supplies (issue 1037): two signals
 * for the same question, did the run ever start executing.
 *
 * - `runStartedAt` is the PRIMARY signal — the run object's `run_started_at`,
 *   which GitHub names the moment the run began executing. On the relay's
 *   dispatch path it is read from the fetched run body; on the workflow_run
 *   path the workflow passes no started-at through the environment (the
 *   workflow file is a gate-executed surface this change does not open), so
 *   it carries null there and the fallback decides.
 * - `anyJobStarted` is the FALLBACK signal — whether the run's job listing
 *   (which the mirror has already fetched on both paths) holds any job that
 *   started. A step can only start inside a job that started, so the
 *   job-level signal subsumes the issue's "no started job or step".
 *
 * The recognition rule (runNeverStarted below): a run that NEVER started is
 * the supersession case the heal exists for; a run that DID start was
 * cancelled deliberately — a maintainer pressed Cancel on executing work —
 * and stays cancelled. When the primary is absent the fallback decides alone;
 * when it is present it decides, and the fallback is not consulted.
 */
export interface RerunStartedEvidence {
  /** The run body's `run_started_at`, or null when it names none. */
  runStartedAt: string | null;
  /** Whether the run's job listing holds any job whose `started_at` names a time. */
  anyJobStarted: boolean;
}

/**
 * The job listing's started signal, read from the RAW listing body: whether
 * any listed job carries a non-empty `started_at`. A body that is not an
 * object, or holds no jobs array, reads as no started job — the same
 * reads-as-absent direction the sweep's listing readers take; a listing the
 * relay cannot read can never testify that a run started, and a wrongful heal
 * remains bounded by GitHub's own rerun guard and the relay's red job.
 */
export function anyJobStartedOf(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const jobs = (body as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return false;
  return jobs.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const startedAt = (entry as { started_at?: unknown }).started_at;
    return typeof startedAt === "string" && startedAt !== "";
  });
}

/**
 * The recognition rule itself: a run that NEVER started is the supersession
 * case the heal exists for; a run that DID start was cancelled deliberately —
 * a maintainer pressed Cancel on executing work — and stays cancelled. The
 * primary signal decides when it names anything at all; the fallback decides
 * alone when the primary is absent.
 */
export function runNeverStarted(evidence: RerunStartedEvidence): boolean {
  return evidence.runStartedAt === null && !evidence.anyJobStarted;
}

/**
 * The rerun-heal's decision (issue 861), pure. Every condition is required;
 * they are evaluated in this order:
 *
 * - a. the run concluded `cancelled` — the shape GitHub leaves when it cancels
 *   a pending run out of the shared concurrency slot;
 * - b. the run's event is pull_request_target — push legs key their own SHA
 *   and are never healed, and a pull_request run is never relayed at all
 *   (isTrustedProducerRun), so re-dispatching one would heal nothing;
 * - c. the attempt is under RERUN_ATTEMPT_CAP — a run cancelled from the
 *   pending slot never started, so attempts increment only via rerun and the
 *   cap bounds the churn;
 * - c2. the run NEVER STARTED (issue 1037): `startedEvidence` decides, and a
 *   call that supplies none decides as the pre-1037 heal did — the relay
 *   always supplies it, gating on runNeverStarted BEFORE its queries (so a
 *   started run is never probed for a heal that must not happen) and passing
 *   the same evidence here so the decision is self-contained;
 *   tests/scripts/ledger-relay-never-started.test.ts pins both legs;
 * - d. the head is still live: an open PR whose tip is the run's head SHA;
 * - e. no live run of the same workflow is already queued, in_progress,
 *   pending, waiting or requested at that head — the rerun must not duplicate
 *   one in flight.
 */
export function decideRerun(
  run: RerunRun,
  pr: HealPullRequest | null,
  liveRunExists: boolean,
  startedEvidence?: RerunStartedEvidence,
): boolean {
  if (run.conclusion !== "cancelled") return false;
  if (!isHealableEvent(run.event)) return false;
  if (run.runAttempt >= RERUN_ATTEMPT_CAP) return false;
  if (startedEvidence !== undefined && !runNeverStarted(startedEvidence)) return false;
  if (pr === null || pr.state !== "open" || pr.headSha !== run.headSha) return false;
  return !liveRunExists;
}

/**
 * The heal's event gate, shared by decideRerun and the relay's early return
 * that avoids requiring RELAY_RERUN_TOKEN for runs no heal could ever take.
 */
export function isHealableEvent(event: string): boolean {
  return event === "pull_request_target";
}

/**
 * The pin map, checked against the shape the deploy gate demands: one flat JSON
 * object whose every value is a workflow path, or a non-empty list of them.
 * The string form is what every committed entry uses, and it is kept rather
 * than normalised away so the file stays readable; the list form is what a
 * context with more than one producing workflow writes (issue 1090).
 *
 * An EMPTY list is refused rather than read as "no producer". It is the one
 * shape that would let a context name itself into the map and then never be
 * decided — the relay would relay nothing for it while every run of its
 * workflow looked successful — and the deploy gate refuses a required check
 * with no pin for the same reason.
 */
export function validatePinMap(value: unknown): PinMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(".github/required-checks.json must be one JSON object");
  }
  const pinMap: Record<string, ContextPins> = {};
  for (const [context, pins] of Object.entries(value)) {
    const paths = typeof pins === "string" ? [pins] : pins;
    const usable =
      Array.isArray(paths) &&
      paths.length > 0 &&
      paths.every((path) => typeof path === "string" && PIN_SHAPE.test(path));
    if (!usable) {
      throw new Error(
        `.github/required-checks.json: the pin for ${context} is not a workflow path, ` +
          `or a non-empty list of them: ${JSON.stringify(pins)}`,
      );
    }
    pinMap[context] = pins;
  }
  return pinMap;
}

