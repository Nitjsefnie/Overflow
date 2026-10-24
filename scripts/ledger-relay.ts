#!/usr/bin/env node
// The ledger relay (issue 708): re-posts the three required checks as
// check-runs owned by the Overflow Ledger GitHub App, so branch protection can
// pin each required context to the App instead of the github-actions app.
// As its second duty (issue 861) the sweep heals runs GitHub cancelled out of
// the shared pending concurrency slot while its pull request's head is still
// live: the relay re-dispatches that run, so a cancelled pending run does not
// strand the PR.
// As its third duty (issue 885) it sweeps for ORPHANS — completed producer runs
// whose own relay instance was itself cancelled out of that same pending slot
// before it could post anything. Nothing else ever notices such a run: that
// relay instance was the only thing that would have attested it, so the
// completion stays unattested and branch protection refuses the merge
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
// path is decided from the newest completed eligible producer's job records under
// an App installation token minted in-process. A pin may name several paths
// (issue 1090 splits the workflows that read pull-request data, leaving one
// required context produced by a pull_request_target file and a push file),
// and every path it names relays. A pinned run is relayed only when the
// workflow definition it executed is the base branch's (isTrustedProducerRun);
// any other pinned run is refused without posting, whichever of its context's
// paths the run came from. The refusal keeps the byte-identical throw unless
// the head is provably dead: a same-repository head reads the commit's
// associated pulls, a fork head (issue 1142) the base repository's open pulls
// at `head=<owner>:<branch>`, its owner proven from the run body's
// head_repository; an unknown name — a deleted fork's null head_repository —
// an unprovable fork owner, or any read failure throws (issue 1115). The App
// key arrives only through the
// LEDGER_APP_KEY secret and is never logged; every failure exits nonzero so a
// dead relay is visible as a red job, never as silence.

import { readSuiteRuns, suiteRunsUrl, supersessionMessage } from "./pr-suite-supersession.ts";
import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  renderSweepLines,
  sweepOrphans,
  type SweepOutcome,
} from "./ledger-relay-sweep.ts";
import { API_ROOT, API_HEADERS, RUN_DEADLINE_MS, apiCall, sweepApi, assertRunDeadline,
  RateLimitExceededError, type RelayHttpOptions } from "./ledger-relay-http.ts";
import { publishProducerContexts } from "./ledger-relay-publication.ts";
import { readEffectiveDeadline } from "./ledger-relay-job-budget.ts";
import { type CheckRunSuppression, type SweepCandidate } from "./ledger-relay-producers.ts";
import { LEDGER_APP_MINT_PERMISSIONS } from "./ledger-app-mint-permissions.ts";
// The pure decision layer. Re-exported below, with `.ts` specifiers, so the
// surface this entry has always presented is unchanged: a caller importing
// decideContexts from here keeps working without knowing the layer exists.
import {
  anyJobStartedOf,
  decideContexts,
  decideRerun,
  hasPullRequestProducerAtHead,
  isTrustedProducerRun,
  openPullRequestsAtHead,
  PIN_SHAPE,
  pinsFor,
  RERUN_ATTEMPT_CAP,
  validatePinMap,
  type ContextDecision,
  type HealPullRequest,
  type PinMap,
  type RelayJob,
  type RerunRun,
  type RerunStartedEvidence,
} from "./ledger-relay-decisions.ts";

export {
  anyJobStartedOf,
  decideContexts,
  decideRerun,
  isTrustedProducerRun,
  PIN_SHAPE,
  pinsFor,
  RERUN_ATTEMPT_CAP,
  validatePinMap,
};
export type { ContextDecision, HealPullRequest, PinMap, RelayJob, RerunRun, RerunStartedEvidence };

// The trigger's identifying fields and the env rules that decide what kind of
// relay a start is; their own module holds the ceiling headroom this entry
// needed (issue 1116's sweep-only mode) without thinning any comment here.
import {
  assertShape,
  DIGITS,
  namesSweepOnlyStart,
  parseTrigger,
  type TriggeringRun,
} from "./ledger-relay-trigger.ts";
import { forkOwnerLoginOf, openPullAtForkHead } from "./ledger-relay-fork.ts";
import {
  headRepositoryFullNameOf,
  resolveWorkflowRunHead,
  triggeringRunFromApi,
  type UpstreamPublicationCheck,
} from "./ledger-relay-upstream.ts";

export type { TriggeringRun };

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

export interface RelayDeps extends RelayHttpOptions {
  env: Record<string, string | undefined>;
  /** Defaults to reading and validating .github/required-checks.json from the working directory. */
  readPinMap?: () => Promise<PinMap>;
}

type RunDeps = RelayDeps & { deadlineMs: number };

export interface RelayResult {
  /** Superseded workflow_run certification is an exit-0 no-op, never a POST. */
  supersededBy?: number;
  decisions: ContextDecision[];
  /** The contexts whose check-run POST succeeded, in posting order. */
  posted: string[];
  /** Writes stopped by a newer App identity during reconciliation, across both duties. */
  suppressed?: CheckRunSuppression[];
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
   * is skipped and the sweep's own summary and heal lines are the whole
   * output. Undefined on every other path.
   */
  sweepOnly?: boolean;
  /**
   * Issue 1355: a sweep-only start deferred its rate-limited orphan sweep.
   * Undefined on every other path.
   */
  sweepDeferred?: string;
}

/**
 * The empty result used until the finally sweep completes. Frozen because
 * early returns hand back this one object into a
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
export async function runRelay(inputDeps: RelayDeps): Promise<RelayResult> {
  const nowFn = inputDeps.nowFn ?? Date.now;
  const deps: RunDeps = { ...inputDeps, nowFn, deadlineMs: nowFn() + RUN_DEADLINE_MS };
  const { env } = deps;
  const appId = required(env, "OVERFLOW_LEDGER_APP_ID", "LEDGER_APP_ID");
  const installationId = required(env, "OVERFLOW_LEDGER_INSTALLATION_ID", "LEDGER_INSTALLATION_ID");
  const appKey = required(env, "OVERFLOW_LEDGER_APP_KEY", "LEDGER_APP_KEY");
  const repo = required(env, "GITHUB_REPOSITORY");
  assertShape(repo, /^[^/]+\/[^/]+$/, "GITHUB_REPOSITORY must name OWNER/REPO");
  assertShape(appId, DIGITS, "LEDGER_APP_ID must be the App's numeric id");
  assertShape(installationId, DIGITS, "LEDGER_INSTALLATION_ID must be the numeric installation id");
  const ownJob = {
    repo, runId: required(env, "GITHUB_RUN_ID"), runAttempt: required(env, "GITHUB_RUN_ATTEMPT"),
    workflowToken: required(env, "OVERFLOW_RELAY_RERUN_TOKEN", "RELAY_RERUN_TOKEN"),
  };
  assertShape(ownJob.runId, DIGITS, "GITHUB_RUN_ID must be the relay run's numeric id");
  assertShape(ownJob.runAttempt, DIGITS, "GITHUB_RUN_ATTEMPT must be the relay run's numeric attempt");

  const pinMap = validatePinMap(await (deps.readPinMap ?? readRawPinMap)());
  // Before any write, the token mint included: an unknown job start or a
  // consumed job-start budget ends the start red with nothing written.
  deps.deadlineMs = await readEffectiveDeadline(deps, ownJob);

  const [, repoName] = repo.split("/");
  const token = await mintInstallationToken(deps, appId, appKey, installationId, repoName);
  const auth = { authorization: `Bearer ${token}` };
  const api = sweepApi(deps, repo, appId, auth);
  let triggerRunId = "";
  let attestationRun: SweepCandidate | undefined;
  let triggerJobs: Record<string, unknown> | undefined;
  const sweepOnlyStart = namesSweepOnlyStart(env);
  let result: RelayResult = { decisions: [], posted: [], rerunDispatched: false, sweep: NO_SWEEP,
    sweepOnly: sweepOnlyStart };
  let primaryError: unknown;
  let failed = false;
  try {
    const trigger = parseTrigger(env);
    if (trigger.kind === "sweep-only") {
      result.sweepOnly = true;
      return result;
    }
    triggerRunId = trigger.kind === "dispatch" ? trigger.runId : trigger.run.runId;
    let fetchedProducer: Record<string, unknown> | undefined;
    let run: TriggeringRun;
    if (trigger.kind === "workflow_run") {
      run = trigger.run;
    } else {
      fetchedProducer = await api.get<Record<string, unknown>>(
        `${API_ROOT}/repos/${repo}/actions/runs/${trigger.runId}`, `the workflow run ${trigger.runId}`,
      );
      run = triggeringRunFromApi(fetchedProducer);
    }
    let recheckPublication: UpstreamPublicationCheck | undefined;
    let historyBound: string | undefined;
    if (run.event === "workflow_run") {
      const resolved = await resolveWorkflowRunHead(
        trigger.kind === "dispatch" ? trigger.runId : run.runId,
        env.GITHUB_REPOSITORY_ID,
        (id) => api.get(`${API_ROOT}/repos/${repo}/actions/runs/${id}`, `the workflow run ${id}`),
        fetchedProducer,
        (sha) => readSuiteRuns((page) => api.get(suiteRunsUrl(API_ROOT, repo, sha, page), "the suite supersession listing", false)),
      );
      run = resolved.run;
      attestationRun = { ...run, headSha: resolved.headSha, status: resolved.producerStatus };
      if (resolved.supersededBy !== undefined) {
        result.supersededBy = resolved.supersededBy;
        return result;
      }
      recheckPublication = resolved.recheckPublication;
      historyBound = resolved.historyBound;
    }
    if (contextsFor(pinMap, run.path).length === 0) return result;
    // Legacy refusals retain their exact throw or dead-head exit-0 result.
    // The finally below runs for either direction and for API-backed refusals.
    if (run.event !== "workflow_run" && !isTrustedProducerRun(run.event, run.headBranch)) {
      result = await refuseUntrustedProducer(deps, repo, run, auth);
      return result;
    }
    attestationRun ??= {
      ...run, status: trigger.kind === "dispatch" ? String(fetchedProducer?.status ?? "") : "completed",
    };
    triggerJobs = historyBound !== undefined ? { jobs: [] } : await api.get<Record<string, unknown>>(
      `${API_ROOT}/repos/${repo}/actions/runs/${run.runId}/jobs?filter=latest&per_page=100`,
      `the job listing of run ${run.runId}`,
    );
    const publication = await publishProducerContexts({
      api, pinMap, apiRoot: API_ROOT, repo, appId, repositoryId: env.GITHUB_REPOSITORY_ID,
      remainingMs: () => deps.deadlineMs - nowFn(),
    }, attestationRun, triggerJobs, recheckPublication, historyBound);
    result.decisions = publication.decisions;
    result.posted = publication.posted;
    if (publication.suppressed !== undefined) result.suppressed = publication.suppressed;
    if (publication.supersededBy !== undefined) result.supersededBy = publication.supersededBy;
    return result;
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      result.sweep = await sweepOrphans({
        api, decide: decideContexts, pinMap, apiRoot: API_ROOT, repo, appId,
        repositoryId: env.GITHUB_REPOSITORY_ID,
        triggerRunId,
        triggerRun: attestationRun, triggerJobs,
        // A refused trigger has no proven producer identity. Do not resolve it
        // again inside the sweep and strand unrelated eligible completions.
        skipTrigger: attestationRun === undefined,
        rerunToken: env.OVERFLOW_RELAY_RERUN_TOKEN ?? env.RELAY_RERUN_TOKEN,
        rerun: (id, rerunToken) => apiCall<unknown>(deps, {
          url: `${API_ROOT}/repos/${repo}/actions/runs/${id}/rerun`, method: "POST",
          headers: { ...API_HEADERS, authorization: `Bearer ${rerunToken}` },
        }, `the rerun of run ${id}`),
      });
      result.rerunDispatched = (result.sweep.rerunDispatched?.length ?? 0) > 0;
      if (result.sweep.suppressed !== undefined) result.suppressed = [
        ...(result.suppressed ?? []), ...result.sweep.suppressed,
      ];
      assertRunDeadline(deps, "completion of the relay run");
    } catch (sweepError) {
      // Issue 1355: a rate-limited sweep defers a sweep-only start to the next
      // scheduled sweep; triggered starts keep failing red — that is the design.
      if (!failed && sweepOnlyStart && sweepError instanceof RateLimitExceededError) {
        result.sweepDeferred = sweepError.message;
        return result;
      }
      if (!failed) throw sweepError;
      const message = (error: unknown) => error instanceof Error ? error.message : String(error);
      throw new AggregateError([primaryError, sweepError],
        `${message(primaryError)}; orphan sweep also failed: ${message(sweepError)}`);
    }
  }
}

/**
 * The App installation token both relay duties run under: a JWT minted from
 * the App key is exchanged for a repo-scoped installation token, whose failure
 * is the red job the failure direction demands. One helper because the
 * sweep-only start (issue 1116) mints the same credential for the same reason.
 */
async function mintInstallationToken(
  deps: RunDeps,
  appId: string,
  appKey: string,
  installationId: string,
  repoName: string,
): Promise<string> {
  const jwt = mintAppJwt(appId, appKey, Date.now());
  const tokenBody = await apiCall<{ token?: unknown }>(
    deps,
    {
      url: `${API_ROOT}/app/installations/${installationId}/access_tokens`,
      method: "POST",
      headers: { ...API_HEADERS, authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        repositories: [repoName],
        permissions: LEDGER_APP_MINT_PERMISSIONS,
      }),
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
 * Condition (d): the open PRs whose tips match the run's head SHA. The
 * commit's associated PRs are filtered client-side; a superseded PR does not
 * match.
 */
async function findOpenPullRequestsAtHead(
  deps: RunDeps,
  repo: string,
  headSha: string,
  auth: Record<string, string>,
): Promise<HealPullRequest[]> {
  const body = await apiCall<unknown>(
    deps,
    {
      url: `${API_ROOT}/repos/${repo}/commits/${headSha}/pulls?per_page=100`,
      method: "GET",
      headers: { ...API_HEADERS, ...auth },
    },
    `the pull requests associated with commit ${headSha}`,
  );
  return openPullRequestsAtHead(body, headSha);
}

/**
 * The relay's refusal of a pinned run whose executed workflow definition was
 * not the base branch's, resolved against the head's liveness (issue 1115):
 * a live head keeps the byte-identical throw (issue 1083's visibility); a
 * DEAD head downgrades the refusal to the visible exit-0 no-op. The head's
 * repository is decided FIRST, because a fork head's commit resolves in the
 * base repository through its pull ref and the same-repo liveness listing
 * answers 200 with count 0 for it: an unknown name is learned by fetching
 * the run body. A same-repo head's liveness is the commit's associated-PR
 * listing; a fork head's (issue 1142) is the base repository's open pulls at
 * `head=<owner>:<branch>`, live only when one carries the run's head SHA. A
 * deleted fork, an unprovable fork owner, an unnamed branch, a missing name,
 * or any read failure throws (fail closed).
 */
async function refuseUntrustedProducer(
  deps: RunDeps,
  repo: string,
  run: TriggeringRun,
  auth: Record<string, string>,
): Promise<RelayResult> {
  const refusedDeadHead = (): RelayResult => ({
    decisions: [],
    posted: [],
    rerunDispatched: false,
    sweep: NO_SWEEP,
    refusedDeadHead: untrustedProducerMessage(run),
  });
  const fetchRunBody = async (): Promise<Record<string, unknown>> =>
    apiCall<Record<string, unknown>>(
      deps,
      {
        url: `${API_ROOT}/repos/${repo}/actions/runs/${run.runId}`,
        method: "GET",
        headers: { ...API_HEADERS, ...auth },
      },
      `the workflow run ${run.runId}`,
    );
  let headRepository = run.headRepository;
  let runBody: Record<string, unknown> | undefined;
  if (headRepository === "") {
    runBody = await fetchRunBody();
    headRepository = headRepositoryFullNameOf(runBody);
  }
  if (headRepository === "") {
    // Unknown name: a deleted fork's head_repository is null, so this limb
    // is the deleted-fork throw too (issue 1142). Fails closed.
    throw new Error(untrustedProducerMessage(run));
  }
  if (headRepository === repo) {
    const pullRequests = await findOpenPullRequestsAtHead(deps, repo, run.headSha, auth);
    if (hasPullRequestProducerAtHead(run.event, run.headBranch, pullRequests)) {
      throw new Error(untrustedProducerMessage(run));
    }
    return pullRequests.length === 0
      ? refusedDeadHead()
      : { decisions: [], posted: [], rerunDispatched: false, sweep: NO_SWEEP };
  }
  // Fork head (issue 1142): the owner must be provable from the run body
  // before any request; the branch-scoped listing then decides liveness.
  const ownerLogin = forkOwnerLoginOf(runBody ?? (await fetchRunBody()));
  if (run.headBranch === "") {
    throw new Error(
      "the refused fork run names no head branch; the fork head's liveness cannot be read, so the refusal stays visible",
    );
  }
  if (
    openPullAtForkHead(
      await apiCall<unknown>(
        deps,
        {
          url:
            `${API_ROOT}/repos/${repo}/pulls?state=open&head=` +
            `${encodeURIComponent(`${ownerLogin}:${run.headBranch}`)}&per_page=100`,
          method: "GET",
          headers: { ...API_HEADERS, ...auth },
        },
        `the open pull requests from ${ownerLogin}:${run.headBranch}`,
      ),
      run.headSha,
    )
  ) {
    throw new Error(untrustedProducerMessage(run));
  }
  return refusedDeadHead();
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

function required(env: Record<string, string | undefined>, name: string, displayName = name): string {
  const value = env[name] ?? env[name.replace(/^OVERFLOW_/, "")] ?? "";
  if (value === "") {
    throw new Error(`${displayName} is required`);
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
  const suppressed = (result.suppressed ?? []).map((entry) =>
    `[ledger-relay] ${entry.context} at ${entry.headSha}: ${entry.externalId} suppressed by newer App identity ${entry.suppressedBy}`);
  if (result.supersededBy !== undefined) return [
    ...suppressed,
    `[ledger-relay] ${supersessionMessage(result.supersededBy)}`,
    ...renderSweepLines(result.sweep),
  ];
  if (result.sweepOnly === true) {
    // The sweep's summary is the whole output; the defer line is issue 1355's only signal.
    const deferred = result.sweepDeferred === undefined ? [] :
      [`[ledger-relay] orphan-sweep: deferred to the next scheduled sweep: ${result.sweepDeferred}`];
    return [...suppressed, ...deferred, ...renderSweepLines(result.sweep)];
  }
  if (result.refusedDeadHead !== undefined) {
    return [
      ...suppressed,
      `[ledger-relay] ${result.refusedDeadHead}`,
      "[ledger-relay] no open pull request is waiting at this head",
      ...renderSweepLines(result.sweep),
    ];
  }
  if (result.posted.length === 0) {
    return [
      ...suppressed,
      ...(suppressed.length > 0 ? [] : ["[ledger-relay] nothing to relay: no required context is pinned to the triggering run's workflow"]),
      ...renderSweepLines(result.sweep),
    ];
  }
  const lines = [...suppressed, ...result.decisions.map(
    (decision) => `[ledger-relay] ${decision.context}: ${decision.conclusion ?? decision.status}`,
  )];
  if (result.rerunDispatched && result.sweep.rerunDispatched === undefined) {
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
