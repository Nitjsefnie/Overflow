#!/usr/bin/env node
// The ledger relay (issue 708): re-posts the three required checks as
// check-runs owned by the Overflow Ledger GitHub App, so branch protection can
// pin each required context to the App instead of the github-actions app.
// As its second duty (issue 861) it heals a run that GitHub cancelled out of
// the shared pending concurrency slot while its pull request's head is still
// live: the relay re-dispatches that run, so a cancelled pending run does not
// strand the PR.
// As its third duty (issue 885) it sweeps for ORPHANS — completed producer runs
// whose own relay instance was itself cancelled out of that same pending slot
// before it could post anything. Nothing else ever notices such a run: that
// relay instance was the only thing that would have attested it, so the
// completion sits unattested forever and branch protection refuses the merge
// with a message reading as a misconfiguration. The sweep lives in
// scripts/ledger-relay-sweep.ts.
//
//   node scripts/ledger-relay.ts
//
// Triggered by workflow_run (a completed run of one of the producer workflows
// named in .github/workflows/ledger-relay.yml) or by workflow_dispatch with
// LEDGER_DISPATCH_RUN_ID, recovering a run whose relay posting died. The pin
// map (.github/required-checks.json) is read from the relay's own checkout —
// the trusted main tip — and each context whose pin names the triggering run's
// path is decided from that run's job records and posted as a check-run under
// an App installation token minted in-process. A pin may name several paths
// (issue 1090 splits the workflows that read pull-request data, leaving one
// required context produced by a pull_request_target file and a push file),
// and every path it names relays. A pinned run is relayed only when the
// workflow definition it executed is the base branch's (isTrustedProducerRun);
// any other pinned run is refused without posting, whichever of its context's
// paths the run came from. The refusal keeps the byte-identical throw unless
// the head is provably dead; the head repository is decided first because a
// fork head's commit resolves in this repository — an unknown name is learned
// by fetching the run body — and a live head, a fork head, a missing name, or
// any read failure throws (issue 1115). The App key arrives only through the
// LEDGER_APP_KEY secret and is never logged; every failure exits nonzero so a
// dead relay is visible as a red job, never as silence.

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  checkRunBody,
  renderSweepLines,
  sweepOrphans,
  validateJobs,
  type SweepApi,
  type SweepOutcome,
} from "./ledger-relay-sweep.ts";
// The pure decision layer. Re-exported below, with `.ts` specifiers, so the
// surface this entry has always presented is unchanged: a caller importing
// decideContexts from here keeps working without knowing the layer exists.
import {
  decideContexts,
  isTrustedProducerRun,
  PIN_SHAPE,
  pinsFor,
  validatePinMap,
  type ContextDecision,
  type PinMap,
  type RelayJob,
} from "./ledger-relay-decisions.ts";

export { decideContexts, isTrustedProducerRun, PIN_SHAPE, pinsFor, validatePinMap };
export type { ContextDecision, PinMap, RelayJob };

// The trigger's identifying fields and the env rules that decide what kind of
// relay a start is; their own module holds the ceiling headroom this entry
// needed (issue 1116's sweep-only mode) without thinning any comment here.
import {
  assertShape,
  DIGITS,
  normalizedAttempt,
  parseTrigger,
  SHA_40,
  type TriggeringRun,
} from "./ledger-relay-trigger.ts";

export type { TriggeringRun };

const API_ROOT = "https://api.github.com";
// On every call: the media type GitHub's REST documentation names and the
// api-version header, so a response-shape change fails loudly instead of
// parsing wrongly.
const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};
// Bounded retry: three attempts total, 1s then 2s between them. Only
// plausibly transient failures retry — a network error, a 5xx, a 429; any
// other 4xx fails immediately, because it will not heal within this job's
// lifetime.
const BACKOFF_MS = [1_000, 2_000];

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
 * - d. the head is still live: an open PR whose tip is the run's head SHA;
 * - e. no live run of the same workflow is already queued, in_progress,
 *   pending, waiting or requested at that head — the rerun must not duplicate
 *   one in flight.
 */
export function decideRerun(
  run: RerunRun,
  pr: HealPullRequest | null,
  liveRunExists: boolean,
): boolean {
  if (run.conclusion !== "cancelled") return false;
  if (!isHealableEvent(run.event)) return false;
  if (run.runAttempt >= RERUN_ATTEMPT_CAP) return false;
  if (pr === null || pr.state !== "open" || pr.headSha !== run.headSha) return false;
  return !liveRunExists;
}

function isHealableEvent(event: string): boolean {
  return event === "pull_request_target";
}

/**
 * The App JWT: RS256 over base64url(header).base64url(payload), signed with
 * the App's private key. iat is backed up a minute and exp held under ten
 * minutes out, GitHub's documented bounds for the App authentication window.
 */
export function mintAppJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const nowSeconds = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId };
  const signingInput = `${encodeSegment(JSON.stringify(header))}.${encodeSegment(JSON.stringify(payload))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export interface RelayDeps {
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
  delayFn: (ms: number) => Promise<void>;
  /** Defaults to reading and validating .github/required-checks.json from the working directory. */
  readPinMap?: () => Promise<PinMap>;
}

export interface RelayResult {
  decisions: ContextDecision[];
  /** The contexts whose check-run POST succeeded, in posting order. */
  posted: string[];
  /** True when the rerun-heal dispatched a fresh run (issue 861). */
  rerunDispatched: boolean;
  /** What the orphan sweep found and healed (issue 885). */
  sweep: SweepOutcome;
  /**
   * Issue 1115: the refusal an untrusted run's DEAD head downgraded to the
   * visible exit-0 no-op, carried as the byte-identical refusal message the
   * renderer prints with the fixed reason line. Undefined on every other
   * path.
   */
  refusedDeadHead?: string;
  /**
   * Issue 1116: the start was sweep-only — no triggering run, so the mirror
   * and the rerun-heal were skipped and the sweep's own summary lines are the
   * whole output. Undefined on every other path.
   */
  sweepOnly?: boolean;
}

/**
 * Nothing examined, nothing relayed — what every path that skips the sweep
 * reports. Frozen because both early returns hand back this one object into a
 * public result type, so a consumer pushing into `sweep.relayed` would corrupt
 * every later result in the process.
 */
const NO_SWEEP: SweepOutcome = Object.freeze({ examined: 0, relayed: Object.freeze([]) });

/**
 * The entry: resolve the triggering run, read the pin map, mint an
 * installation token, mirror the producing jobs, post one check-run per
 * pinned context. Throws on any failure; main() turns a throw into a nonzero
 * exit.
 */
export async function runRelay(deps: RelayDeps): Promise<RelayResult> {
  const { env } = deps;
  const appId = required(env, "LEDGER_APP_ID");
  const installationId = required(env, "LEDGER_INSTALLATION_ID");
  const appKey = required(env, "LEDGER_APP_KEY");
  const repo = required(env, "GITHUB_REPOSITORY");
  assertShape(repo, /^[^/]+\/[^/]+$/, "GITHUB_REPOSITORY must name OWNER/REPO");
  assertShape(appId, DIGITS, "LEDGER_APP_ID must be the App's numeric id");
  assertShape(installationId, DIGITS, "LEDGER_INSTALLATION_ID must be the numeric installation id");

  const pinMap = validatePinMap(await (deps.readPinMap ?? readRawPinMap)());

  const trigger = parseTrigger(env);
  const [, repoName] = repo.split("/");
  if (trigger.kind === "sweep-only") {
    // Sweep-only (issue 1116): the scheduled start exists to sweep — there is
    // no triggering run, so the mirror is skipped and the rerun-heal has
    // nothing to heal. A thrown sweep exits nonzero (red), the unchanged
    // direction, and the renderer prints the sweep's own summary lines.
    const token = await mintInstallationToken(deps, appId, appKey, installationId, repoName);
    const sweep = await sweepOrphans({
      api: sweepApi(deps, repo, { authorization: `Bearer ${token}` }),
      decide: decideContexts,
      pinMap,
      apiRoot: API_ROOT,
      repo,
      appId,
      triggerRunId: "",
    });
    return { decisions: [], posted: [], rerunDispatched: false, sweep, sweepOnly: true };
  }
  if (trigger.kind === "workflow_run" && contextsFor(pinMap, trigger.run.path).length === 0) {
    // Nothing is pinned to this run's workflow; there is nothing to relay and
    // no reason to mint a token. A run nothing is pinned to never had a
    // check-run to orphan either, so the sweep has no part in this path.
    return { decisions: [], posted: [], rerunDispatched: false, sweep: NO_SWEEP };
  }

  const token = await mintInstallationToken(deps, appId, appKey, installationId, repoName);
  const auth = { authorization: `Bearer ${token}` };

  let run: TriggeringRun;
  if (trigger.kind === "workflow_run") {
    run = trigger.run;
  } else {
    const fetched = await apiCall<Record<string, unknown>>(
      deps,
      {
        url: `${API_ROOT}/repos/${repo}/actions/runs/${trigger.runId}`,
        method: "GET",
        headers: { ...API_HEADERS, ...auth },
      },
      `the workflow run ${trigger.runId}`,
    );
    run = triggeringRunFromApi(fetched);
    if (contextsFor(pinMap, run.path).length === 0) {
      return { decisions: [], posted: [], rerunDispatched: false, sweep: NO_SWEEP };
    }
  }

  // The trust gate, both paths, after the mint (issue 1115): an untrusted run
  // is thrown out byte-identically unless its head is provably dead (then the
  // refusal exits 0 visibly).
  if (!isTrustedProducerRun(run.event, run.headBranch)) {
    return await refuseUntrustedProducer(deps, repo, run, auth);
  }

  const jobsBody = await apiCall<Record<string, unknown>>(
    deps,
    {
      url: `${API_ROOT}/repos/${repo}/actions/runs/${run.runId}/jobs?filter=latest&per_page=100`,
      method: "GET",
      headers: { ...API_HEADERS, ...auth },
    },
    `the job listing of run ${run.runId}`,
  );
  const jobs = validateJobs(jobsBody);

  const decisions = decideContexts(pinMap, run.path, run.conclusion, jobs);
  const posted: string[] = [];
  for (const decision of decisions) {
    await apiCall(
      deps,
      {
        url: `${API_ROOT}/repos/${repo}/check-runs`,
        method: "POST",
        headers: { ...API_HEADERS, ...auth },
        body: JSON.stringify(checkRunBody(decision, run)),
      },
      `the check-run for ${decision.context}`,
    );
    posted.push(decision.context);
  }

  // The sweep and the heal both follow the mirrored decisions, so the mirror —
  // the relay's primary duty — lands whatever they do, and a failure in either
  // still exits nonzero rather than passing quietly. But both following the
  // mirror does NOT make them independent: awaiting the sweep first held the
  // heal hostage to a far larger failure surface (a repository-wide listing
  // plus up to SWEEP_RUN_LIMIT check-runs GETs on EVERY start, against the
  // heal's three queries on a rare path). So the heal runs exactly once
  // whatever the sweep does, and the sweep's failure is rethrown after it.
  let sweep: SweepOutcome;
  let sweepError: unknown = undefined;
  try {
    sweep = await sweepOrphans({
      api: sweepApi(deps, repo, auth),
      decide: decideContexts,
      pinMap,
      apiRoot: API_ROOT,
      repo,
      appId,
      triggerRunId: run.runId,
    });
  } catch (error) {
    sweep = NO_SWEEP;
    sweepError = error;
  }

  const rerunDispatched = await healWithRerun(deps, env, repo, run, auth);
  if (sweepError !== undefined) throw sweepError;

  return { decisions, posted, rerunDispatched, sweep };
}

/**
 * The App installation token both relay duties run under: a JWT minted from
 * the App key is exchanged for a repo-scoped installation token, whose failure
 * is the red job the failure direction demands. One helper because the
 * sweep-only start (issue 1116) mints the same credential for the same reason.
 */
async function mintInstallationToken(
  deps: RelayDeps,
  appId: string,
  appKey: string,
  installationId: string,
  repoName: string,
): Promise<string> {
  const jwt = mintAppJwt(appId, appKey, Date.now());  const tokenBody = await apiCall<{ token?: unknown }>(
    deps,
    {
      url: `${API_ROOT}/app/installations/${installationId}/access_tokens`,
      method: "POST",
      headers: { ...API_HEADERS, authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ repositories: [repoName] }),
    },
    "the installation-token mint",
  );
  const token = tokenBody.token;
  if (typeof token !== "string" || token === "") {
    throw new Error("the installation-token mint returned no token");
  }
  return token;
}

/**
 * The sweep's HTTP, over the relay's own bounded-retry call under the App
 * installation token minted above, so it inherits the backoff, the API headers
 * and the red-on-failure direction rather than needing its own.
 */
function sweepApi(deps: RelayDeps, repo: string, auth: Record<string, string>): SweepApi {
  const headers = { ...API_HEADERS, ...auth };
  return {
    get: <T,>(url: string, what: string) => apiCall<T>(deps, { url, method: "GET", headers }, what),
    postCheckRun: (body, what) =>
      apiCall<unknown>(
        deps,
        {
          url: `${API_ROOT}/repos/${repo}/check-runs`,
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        what,
      ),
  };
}

/**
 * The rerun-heal (issue 861). When the triggering run was cancelled out of the
 * shared pending concurrency slot while its pull request's head is still live,
 * dispatch a fresh run of it, so the cancelled conclusion — mirrored above —
 * is replaced when the rerun's own completion event arrives. The heal runs
 * only for a cancelled pull_request_target run; its conditions are evaluated
 * in order and each query is issued only when every earlier condition already
 * holds.
 * Returns true exactly when the rerun was dispatched.
 */
async function healWithRerun(
  deps: RelayDeps,
  env: Record<string, string | undefined>,
  repo: string,
  run: TriggeringRun,
  auth: Record<string, string>,
): Promise<boolean> {
  // The rerun token is required whenever a cancelled PR run is on the table —
  // checked before any heal API call, so a missing token is a visible red
  // relay job, never silent degradation.
  if (run.conclusion !== "cancelled" || !isHealableEvent(run.event)) return false;
  const rerunToken = required(env, "RELAY_RERUN_TOKEN");
  // The attempt cap precedes the queries.
  if (run.runAttempt >= RERUN_ATTEMPT_CAP) return false;

  const pr = await findOpenPullRequestAtHead(deps, repo, run.headSha, auth);
  const liveRunExists =
    pr === null ? false : await hasLiveRunOfPath(deps, repo, run.headSha, run.path, auth);
  if (!decideRerun(run, pr, liveRunExists)) return false;

  // The rerun authenticates as the workflow's own repo-scoped token, not the
  // App token: the rerun needs actions: write, which the App does not hold.
  await apiCall<unknown>(
    deps,
    {
      url: `${API_ROOT}/repos/${repo}/actions/runs/${run.runId}/rerun`,
      method: "POST",
      headers: { ...API_HEADERS, authorization: `Bearer ${rerunToken}` },
    },
    `the rerun of run ${run.runId}`,
  );
  return true;
}

/**
 * Condition (d): the one open PR whose tip is the run's head SHA, or null.
 * The commit's associated PRs are filtered client-side; a PR whose head has
 * moved on (superseded) does not match.
 */
async function findOpenPullRequestAtHead(
  deps: RelayDeps,
  repo: string,
  headSha: string,
  auth: Record<string, string>,
): Promise<HealPullRequest | null> {
  const body = await apiCall<unknown>(
    deps,
    {
      url: `${API_ROOT}/repos/${repo}/commits/${headSha}/pulls?per_page=100`,
      method: "GET",
      headers: { ...API_HEADERS, ...auth },
    },
    `the pull requests associated with commit ${headSha}`,
  );
  if (!Array.isArray(body)) {
    throw new Error("the commit's associated-pull-request listing returned no array");
  }
  for (const entry of body) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { state?: unknown; head?: { sha?: unknown } | undefined };
    if (candidate.state !== "open") continue;
    const prHeadSha = typeof candidate.head?.sha === "string" ? candidate.head.sha : "";
    if (prHeadSha === headSha) {
      return { state: candidate.state, headSha: prHeadSha };
    }
  }
  return null;
}

/**
 * Every status in which GitHub's workflow-run `status` enum reports a run that
 * has not finished: it is on the board, so a rerun of the same workflow at the
 * same head would duplicate it — and GitHub refuses the POST while it is
 * there. `pending`, `waiting` and `requested` are the statuses a run waits in
 * for a runner, so all five are live for this check (issue 952: a cancelled
 * attempt healed into a `pending` successor, which GitHub refused with 403
 * "This workflow is already running").
 */
const LIVE_RUN_STATUSES = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

/**
 * Condition (e): whether any run of the SAME workflow at the head SHA is live
 * — queued, in_progress, pending, waiting or requested. The runs listing is
 * filtered client-side for the workflow's path and the live statuses.
 *
 * A malformed listing reads as "no live run" rather than throwing — the
 * deliberate asymmetry with findOpenPullRequestAtHead, which throws: the
 * failure direction is bounded by GitHub's own rerun guard, which refuses a
 * live run with a 4xx that apiCall throws, so the worst case is a visible red
 * relay job, never a duplicate dispatch.
 */
async function hasLiveRunOfPath(
  deps: RelayDeps,
  repo: string,
  headSha: string,
  path: string,
  auth: Record<string, string>,
): Promise<boolean> {
  const body = await apiCall<Record<string, unknown>>(
    deps,
    {
      url: `${API_ROOT}/repos/${repo}/actions/runs?head_sha=${headSha}&per_page=100`,
      method: "GET",
      headers: { ...API_HEADERS, ...auth },
    },
    `the workflow-run listing at ${headSha}`,
  );
  const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
  for (const entry of runs) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as { path?: unknown; status?: unknown };
    if (candidate.path === path && LIVE_RUN_STATUSES.has(String(candidate.status))) {
      return true;
    }
  }
  return false;
}

interface ApiRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/**
 * One GitHub API call with the bounded retry. A network error, a 5xx or a 429
 * retries through the backoff; any other non-2xx fails at once. The error
 * messages carry the endpoint, the status and GitHub's message — never a
 * header, so no key or token can reach the log.
 */
async function apiCall<T>(deps: RelayDeps, request: ApiRequest, what: string): Promise<T> {
  let lastMessage = "";
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) {
      await deps.delayFn(BACKOFF_MS[attempt - 1] ?? 0);
    }
    let response: Response;
    try {
      response = await deps.fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      continue;
    }
    const text = await response.text();
    if (response.ok) {
      // The rerun endpoint (issue 861) answers 202 with an empty body; an
      // empty success body parses as no data rather than a shape failure.
      if (text === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`${what} returned a body that is not JSON`);
      }
    }
    lastMessage = `HTTP ${response.status}: ${truncate(text)}`;
    if (response.status < 500 && response.status !== 429) {
      throw new Error(`${what} failed: ${lastMessage}`);
    }
  }
  throw new Error(`${what} failed after ${BACKOFF_MS.length + 1} attempts: ${lastMessage}`);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}

function triggeringRunFromApi(body: Record<string, unknown>): TriggeringRun {
  const headSha = typeof body.head_sha === "string" ? body.head_sha : "";
  assertShape(headSha, SHA_40, "the fetched run's head_sha must be a 40-hex SHA");
  const path = typeof body.path === "string" ? body.path : "";
  assertShape(path, PIN_SHAPE, "the fetched run's path must be a workflow path");
  const htmlUrl = typeof body.html_url === "string" ? body.html_url : "";
  if (htmlUrl === "") {
    throw new Error("the fetched run's html_url is empty; cannot set the check-run's details_url");
  }
  return {
    runId: typeof body.id === "number" ? String(body.id) : "",
    headSha,
    path,
    conclusion: typeof body.conclusion === "string" ? body.conclusion : null,
    htmlUrl,
    event: typeof body.event === "string" ? body.event : "",
    headBranch: typeof body.head_branch === "string" ? body.head_branch : "",
    runAttempt: normalizedAttempt(
      typeof body.run_attempt === "number" || typeof body.run_attempt === "string"
        ? body.run_attempt
        : undefined,
    ),
    headRepository: headRepositoryFullNameOf(body),
  };
}

/**
 * The run body's `head_repository.full_name`, or the empty string when the
 * body carries no readable repository name. Never a guess: an empty value
 * means unknown, and the gate learns the name by fetching the run body — a
 * name still missing keeps the throw.
 */
function headRepositoryFullNameOf(body: Record<string, unknown>): string {
  const headRepository =
    typeof body.head_repository === "object" && body.head_repository !== null
      ? (body.head_repository as { full_name?: unknown })
      : undefined;
  return typeof headRepository?.full_name === "string" ? headRepository.full_name : "";
}

/**
 * The relay's refusal of a pinned run whose executed workflow definition was
 * not the base branch's, resolved against the head's liveness (issue 1115):
 * a live head keeps the byte-identical throw (issue 1083's visibility); a
 * DEAD head downgrades the refusal to the visible exit-0 no-op. The head's
 * repository is decided FIRST, because a fork head's commit resolves in the
 * base repository through its pull ref and the listing answers 200 with
 * count 0 for it: an unknown name is learned by fetching the run body, and
 * a fork name, a live head, or any read failure throws.
 */
async function refuseUntrustedProducer(
  deps: RelayDeps,
  repo: string,
  run: TriggeringRun,
  auth: Record<string, string>,
): Promise<RelayResult> {
  let headRepository = run.headRepository;
  if (headRepository === "") {
    const fetched = await apiCall<Record<string, unknown>>(
      deps,
      {
        url: `${API_ROOT}/repos/${repo}/actions/runs/${run.runId}`,
        method: "GET",
        headers: { ...API_HEADERS, ...auth },
      },
      `the workflow run ${run.runId}`,
    );
    headRepository = headRepositoryFullNameOf(fetched);
  }
  if (headRepository === "" || headRepository !== repo) {
    throw new Error(untrustedProducerMessage(run));
  }
  const pr = await findOpenPullRequestAtHead(deps, repo, run.headSha, auth);
  if (pr !== null) {
    throw new Error(untrustedProducerMessage(run));
  }
  return {
    decisions: [],
    posted: [],
    rerunDispatched: false,
    sweep: NO_SWEEP,
    refusedDeadHead: untrustedProducerMessage(run),
  };
}

/**
 * The refusal message, byte-identical across the throw and the exit-0 print.
 */
function untrustedProducerMessage(run: TriggeringRun): string {
  return (
    `run ${run.runId} (event ${JSON.stringify(run.event)}, head branch ` +
      `${JSON.stringify(run.headBranch)}) did not execute the base branch's workflow ` +
      "definition; no required context was relayed"
  );
}

/**
 * The contexts a run of `path` may attest: every pin map entry whose pin names
 * that path. A context pinned to several paths (issue 1090's split, where one
 * required context is produced by a `pull_request_target` file and a push
 * file) resolves from EACH of them — matching only one would leave the other
 * file's runs on the "nothing is pinned to this run's workflow" branch, which
 * returns without posting anything and without failing.
 *
 * This decides WHICH runs relay; it decides nothing about which runs MAY
 * (refuseUntrustedProducer). The two are deliberately separate: widening this
 * cannot widen that, and the narrowness of the predicate is pinned against a
 * second path in tests/scripts/ledger-relay.test.ts.
 */
function contextsFor(pinMap: PinMap, path: string): string[] {
  const contexts: string[] = [];
  for (const [context, pins] of Object.entries(pinMap)) {
    if (pinsFor(pins).includes(path)) contexts.push(context);
  }
  return contexts;
}

async function readRawPinMap(): Promise<unknown> {
  return JSON.parse(await readFile(".github/required-checks.json", "utf8")) as unknown;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name] ?? "";
  if (value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * The relay's human-visible success signal, one log line at a time. Pure, so a
 * synthetic result can drive it: the rerun-heal line is the only signal that a
 * cancelled run was re-dispatched, and the sweep's summary line the only signal
 * that orphans are being healed — so both are pinned by tests rather than
 * living undrivable in main().
 */
export function renderRelayResult(result: RelayResult): string[] {
  if (result.sweepOnly === true) {
    // Issue 1116: the sweep's summary is the whole output; there is no
    // triggering run to name and no mirror to report.
    return renderSweepLines(result.sweep);
  }
  if (result.refusedDeadHead !== undefined) {
    return [
      `[ledger-relay] ${result.refusedDeadHead}`,
      "[ledger-relay] no open pull request is waiting at this head",
    ];
  }
  if (result.posted.length === 0) {
    return [
      "[ledger-relay] nothing to relay: no required context is pinned to the triggering run's workflow",
    ];
  }
  const lines = result.decisions.map(
    (decision) => `[ledger-relay] ${decision.context}: ${decision.conclusion ?? decision.status}`,
  );
  if (result.rerunDispatched) {
    lines.push(
      "[ledger-relay] rerun-heal: the cancelled run was re-dispatched; " +
        "its completion event will mirror the real conclusion",
    );
  }
  lines.push(...renderSweepLines(result.sweep));
  return lines;
}

function main(): void {
  runRelay({
    env: process.env,
    fetchFn: fetch,
    delayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then(
    (result) => {
      for (const line of renderRelayResult(result)) {
        console.log(line);
      }
    },
    (error: unknown) => {
      console.error(`[ledger-relay] ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
