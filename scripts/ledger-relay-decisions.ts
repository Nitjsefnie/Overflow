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

/** The base branch: the one protected ref whose workflow definitions the relay trusts. */
const BASE_BRANCH = "main";

/** Events whose run executes the definition at the ref it names — trusted only when that ref is the base branch. */
const EVENTS_TRUSTED_ON_BASE_BRANCH = new Set(["push", "workflow_dispatch", "schedule"]);

/**
 * Whether a producer run may attest a required context: true exactly when the
 * workflow definition the run EXECUTED is the base branch's. A required
 * context is evidence about the job that judged the commit, so it is only
 * worth relaying when that job's definition is one a pull request cannot
 * shape. The pin map binds a context to a workflow path; this binds it to the
 * definition at that path being main's.
 *
 * An allowlist, so an event GitHub adds later, or one a producer gains by
 * mistake, is refused until it is reasoned about here:
 *
 * - `pull_request_target` runs the definition on the pull request's TARGET
 *   branch, not its head, so the head branch says nothing about the
 *   definition and is not consulted. On main, every pinned producer restricts
 *   that trigger to `branches: [main]`. A definition on any other target — a
 *   different branch, or a tag — exists only because someone with write
 *   access created it, which is the same trust class as a push or a dispatch
 *   on a branch. The run record does not carry the target branch in a form
 *   the relay can read for a run from a fork, so the relay does not check it
 *   and trusts this event on that basis.
 * - `push`, `workflow_dispatch` and `schedule` run the definition at the ref
 *   they name — the pushed branch, the dispatched ref, the default branch. That
 *   definition is the base branch's only when the ref is exactly `main`.
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
 * The relay's core. Contexts come from the pin map entries whose path equals
 * the triggering run's path, in pin-map order. For each:
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
  pinMap: Readonly<Record<string, string>>,
  runPath: string,
  runConclusion: string | null,
  jobs: readonly RelayJob[],
): ContextDecision[] {
  const decisions: ContextDecision[] = [];
  for (const [context, path] of Object.entries(pinMap)) {
    if (path !== runPath) continue;
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

/** The same shape the deploy gate demands: one flat object of workflow paths. */
export function validatePinMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(".github/required-checks.json must be one JSON object");
  }
  const pinMap: Record<string, string> = {};
  for (const [context, path] of Object.entries(value)) {
    if (typeof path !== "string" || !PIN_SHAPE.test(path)) {
      throw new Error(
        `.github/required-checks.json: the pin for ${context} is not a workflow path: ${JSON.stringify(path)}`,
      );
    }
    pinMap[context] = path;
  }
  return pinMap;
}

