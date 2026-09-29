#!/usr/bin/env node
// The ledger relay (issue 708): re-posts the three required checks as
// check-runs owned by the Overflow Ledger GitHub App, so branch protection can
// pin each required context to the App instead of the github-actions app.
//
//   node scripts/ledger-relay.ts
//
// Triggered by workflow_run (a completed run of one of the producer workflows
// named in .github/workflows/ledger-relay.yml) or by workflow_dispatch with
// LEDGER_DISPATCH_RUN_ID, recovering a run whose relay posting died. The pin
// map (.github/required-checks.json) is read from the relay's own checkout —
// the trusted main tip — and each context pinned to the triggering run's path
// is decided from that run's job records and posted as a check-run under an
// App installation token minted in-process. The App key arrives only through
// the LEDGER_APP_KEY secret, signs in-process, and is never logged; every
// failure exits nonzero so a dead relay is visible as a red job, never as
// silence.

import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

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

/** The triggering run's identifying fields, validated on entry. */
export interface TriggeringRun {
  runId: string;
  headSha: string;
  path: string;
  conclusion: string | null;
  htmlUrl: string;
  event: string;
}

export const PIN_SHAPE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const SHA_40 = /^[0-9a-f]{40}$/;
const DIGITS = /^\d+$/;
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
  readPinMap?: () => Promise<Record<string, string>>;
}

export interface RelayResult {
  decisions: ContextDecision[];
  /** The contexts whose check-run POST succeeded, in posting order. */
  posted: string[];
}

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
  if (trigger.kind === "workflow_run" && contextsFor(pinMap, trigger.run.path).length === 0) {
    // Nothing is pinned to this run's workflow; there is nothing to relay and
    // no reason to mint a token.
    return { decisions: [], posted: [] };
  }

  const jwt = mintAppJwt(appId, appKey, Date.now());
  const tokenBody = await apiCall<{ token?: unknown }>(
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
      return { decisions: [], posted: [] };
    }
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
  return { decisions, posted };
}

function checkRunBody(decision: ContextDecision, run: TriggeringRun): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: decision.context,
    head_sha: run.headSha,
    status: decision.status,
    output: { title: decision.title, summary: decision.summary },
    details_url: run.htmlUrl,
  };
  if (decision.conclusion !== undefined) {
    body.conclusion = decision.conclusion;
  }
  return body;
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

type Trigger =
  | { kind: "workflow_run"; run: TriggeringRun }
  | { kind: "dispatch"; runId: string };

/**
 * The workflow passes the triggering run's fields explicitly so the entry has
 * no event payload to parse. An absent GITHUB_WORKFLOW_RUN_ID means a
 * workflow_dispatch recovery: LEDGER_DISPATCH_RUN_ID names the run to
 * re-read from the API.
 */
function parseTrigger(env: Record<string, string | undefined>): Trigger {
  const runId = env.GITHUB_WORKFLOW_RUN_ID ?? "";
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
      },
    };
  }
  const dispatchRunId = env.LEDGER_DISPATCH_RUN_ID ?? "";
  if (dispatchRunId === "") {
    throw new Error(
      "no triggering run in the environment: expected GITHUB_WORKFLOW_RUN_* (workflow_run) " +
        "or LEDGER_DISPATCH_RUN_ID (workflow_dispatch recovery)",
    );
  }
  assertShape(dispatchRunId, DIGITS, "LEDGER_DISPATCH_RUN_ID must be a workflow-run id");
  return { kind: "dispatch", runId: dispatchRunId };
}

function normalizedConclusion(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
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
  };
}

function contextsFor(pinMap: Readonly<Record<string, string>>, path: string): string[] {
  const contexts: string[] = [];
  for (const [context, pinned] of Object.entries(pinMap)) {
    if (pinned === path) contexts.push(context);
  }
  return contexts;
}

async function readRawPinMap(): Promise<unknown> {
  return JSON.parse(await readFile(".github/required-checks.json", "utf8")) as unknown;
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

function validateJobs(body: Record<string, unknown>): RelayJob[] {
  if (!Array.isArray(body.jobs)) {
    throw new Error("the job listing returned no jobs array");
  }
  const jobs: RelayJob[] = [];
  for (const entry of body.jobs) {
    const job = entry as Partial<RelayJob> | null;
    if (typeof job?.name !== "string") {
      throw new Error("the job listing holds an entry without a name");
    }
    jobs.push({
      name: job.name,
      run_attempt: typeof job.run_attempt === "number" ? job.run_attempt : 1,
      // An unknown status reads as queued: the check-run then waits rather
      // than ever passing on something unverified.
      status: job.status === "in_progress" || job.status === "completed" ? job.status : "queued",
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
    });
  }
  return jobs;
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name] ?? "";
  if (value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertShape(value: string, shape: RegExp, message: string): void {
  if (!shape.test(value)) {
    throw new Error(`${message} (got ${JSON.stringify(value)})`);
  }
}

function main(): void {
  runRelay({
    env: process.env,
    fetchFn: fetch,
    delayFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }).then(
    (result) => {
      if (result.posted.length === 0) {
        console.log(
          "[ledger-relay] nothing to relay: no required context is pinned to the triggering run's workflow",
        );
        return;
      }
      for (const decision of result.decisions) {
        console.log(`[ledger-relay] ${decision.context}: ${decision.conclusion ?? decision.status}`);
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
