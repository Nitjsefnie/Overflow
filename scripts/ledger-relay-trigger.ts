// The ledger relay's trigger parsing, in its own module because
// scripts/ledger-relay.ts sits at its tooling-family line ceiling and this
// block is one cohesive unit: the triggering run's identifying fields and the
// rules that decide WHAT KIND of relay a start is. The workflow passes the
// triggering run's fields explicitly through env (never an event payload), so
// parsing is validation. An absent GITHUB_WORKFLOW_RUN_ID means a
// workflow_dispatch recovery: LEDGER_DISPATCH_RUN_ID names the run to re-read
// from the API. With neither, LEDGER_SWEEP_ONLY=true (issue 1116) makes the
// start sweep-only — no triggering run, so no mirror and no heal — and the
// mode is fail-closed on ambiguity: a value other than exactly "true" or
// "false" throws, and sweep-only alongside any run id throws.

import { PIN_SHAPE } from "./ledger-relay-decisions.ts";

export const SHA_40 = /^[0-9a-f]{40}$/;
export const DIGITS = /^\d+$/;

/** The triggering run's identifying fields, validated on entry. */
export interface TriggeringRun {
  runId: string;
  headSha: string;
  path: string;
  conclusion: string | null;
  htmlUrl: string;
  event: string;
  /** The triggering run's head branch; empty when the environment or the API did not name one. */
  headBranch: string;
  /** The triggering run's attempt number; 1 when the environment or the API did not name one. */
  runAttempt: number;
  /**
   * The full name ("OWNER/REPO") of the repository the run's head commit
   * lives in, per the run body's `head_repository.full_name`; empty when the
   * run's fields carry none (the workflow_run path's env carries none). The
   * refusal gate compares it against this repository's slug (issue 1115): a
   * known mismatch throws before any listing is consulted. Empty does NOT
   * mean "same repository" — a fork head's commit resolves in the base
   * repository through its pull ref — so the gate fetches the run body to
   * learn the name, and a name still missing keeps the throw.
   */
  headRepository: string;
}

/** What kind of relay this start is, decided by parseTrigger or never at all. */
export type Trigger =
  | { kind: "workflow_run"; run: TriggeringRun }
  | { kind: "dispatch"; runId: string }
  // Issue 1116: a scheduled start, or a workflow_dispatch without a run_id,
  // whose sole duty is the orphan sweep. Named by LEDGER_SWEEP_ONLY=true and
  // no run id anywhere; fail-closed on any ambiguity (see parseTrigger).
  | { kind: "sweep-only" };

export function parseTrigger(env: Record<string, string | undefined>): Trigger {
  const sweepOnlyRaw = env.LEDGER_SWEEP_ONLY ?? "";
  if (sweepOnlyRaw !== "" && sweepOnlyRaw !== "true" && sweepOnlyRaw !== "false") {
    throw new Error(
      `LEDGER_SWEEP_ONLY must be exactly "true" or "false" (got ${JSON.stringify(sweepOnlyRaw)})`,
    );
  }
  const sweepOnly = sweepOnlyRaw === "true";
  const runId = env.GITHUB_WORKFLOW_RUN_ID ?? "";
  const dispatchRunId = env.LEDGER_DISPATCH_RUN_ID ?? "";
  if (sweepOnly && (runId !== "" || dispatchRunId !== "")) {
    throw new Error(
      "LEDGER_SWEEP_ONLY=true is a sweep-only relay: no triggering run may be named alongside it " +
        "(GITHUB_WORKFLOW_RUN_ID or LEDGER_DISPATCH_RUN_ID); unset one of the two",
    );
  }
  if (runId !== "") {
    assertShape(runId, DIGITS, "GITHUB_WORKFLOW_RUN_ID must be a workflow-run id");
    const headSha = env.GITHUB_WORKFLOW_RUN_HEAD_SHA ?? "";
    assertShape(headSha, SHA_40, "GITHUB_WORKFLOW_RUN_HEAD_SHA must be a 40-hex SHA");
    const path = env.GITHUB_WORKFLOW_RUN_PATH ?? "";
    assertShape(path, PIN_SHAPE, "GITHUB_WORKFLOW_RUN_PATH must be a workflow path");
    const htmlUrl = env.GITHUB_WORKFLOW_RUN_HTML_URL ?? "";
    if (htmlUrl === "") {
      throw new Error("GITHUB_WORKFLOW_RUN_HTML_URL is required for the check-run's details_url");
    }
    return {
      kind: "workflow_run",
      run: {
        runId,
        headSha,
        path,
        conclusion: normalizedConclusion(env.GITHUB_WORKFLOW_RUN_CONCLUSION),
        htmlUrl,
        event: env.GITHUB_WORKFLOW_RUN_EVENT ?? "",
        headBranch: env.GITHUB_WORKFLOW_RUN_HEAD_BRANCH ?? "",
        runAttempt: normalizedAttempt(env.GITHUB_WORKFLOW_RUN_ATTEMPT),
        headRepository: "",
      },
    };
  }
  if (dispatchRunId !== "") {
    assertShape(dispatchRunId, DIGITS, "LEDGER_DISPATCH_RUN_ID must be a workflow-run id");
    return { kind: "dispatch", runId: dispatchRunId };
  }
  if (sweepOnly) return { kind: "sweep-only" };
  throw new Error(
    "no triggering run in the environment: expected GITHUB_WORKFLOW_RUN_* (workflow_run) " +
      "or LEDGER_DISPATCH_RUN_ID (workflow_dispatch recovery)",
  );
}

function normalizedConclusion(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A missing or invalid attempt reads as 1 (issue 861): the heal's cap
 * compares against the run's own attempt number, which both trigger paths
 * carry — GITHUB_WORKFLOW_RUN_ATTEMPT on the workflow_run path, run_attempt in
 * the fetched body on the dispatch path.
 */
export function normalizedAttempt(value: string | number | undefined): number {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 ? value : 1;
  }
  const trimmed = (value ?? "").trim();
  if (!DIGITS.test(trimmed)) return 1;
  const parsed = Number(trimmed);
  return parsed >= 1 ? parsed : 1;
}

export function assertShape(value: string, shape: RegExp, message: string): void {
  if (!shape.test(value)) {
    throw new Error(`${message} (got ${JSON.stringify(value)})`);
  }
}
