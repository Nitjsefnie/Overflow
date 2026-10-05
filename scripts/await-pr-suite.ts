#!/usr/bin/env node
// The pull-request suite awaiter. A pull request's own code runs only in the
// untrusted `pull_request` workflow SUITE_WORKFLOW_PATH; the base-defined
// verify job takes that run's outcome as DATA, never by executing the pull
// request's code. This script is what verify runs, from its base-branch
// checkout:
//
//   node scripts/await-pr-suite.ts
//
// Environment: GITHUB_REPOSITORY (OWNER/REPO), GH_TOKEN, HEAD_SHA (40-hex),
// optional SUITE_DEADLINE_SECONDS (default 2400) and SUITE_POLL_SECONDS
// (default 30), optional GITHUB_OUTPUT.
//
// It polls the workflow-run listing at HEAD_SHA, keeps only runs of exactly
// the suite workflow at exactly that SHA, and waits on the most recently
// created one (ties: the highest id). Exit 0 only when that run completed with
// conclusion `success`, writing `run_id=<id>` to GITHUB_OUTPUT so the caller
// can fetch the run's artifacts. Every other outcome fails closed with exit 1
// and one `::error::` line naming why; malformed input exits 2. It imports
// only Node built-ins, so nothing outside the base checkout's own file runs.

import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** The suite workflow whose run is awaited; matched exactly against each run's `path`. */
export const SUITE_WORKFLOW_PATH = ".github/workflows/pr-suite.yml";

const DEFAULT_DEADLINE_SECONDS = 2400;
const DEFAULT_POLL_SECONDS = 30;
const SHA_40 = /^[0-9a-f]{40}$/;
// OWNER/REPO in GitHub's own name alphabet, so the value cannot reshape the
// request URL it is interpolated into.
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const API_ROOT = "https://api.github.com";
// The media type GitHub's REST documentation names and the api-version
// header, so a response-shape change fails loudly instead of parsing wrongly.
const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};
// Bounded retry: three attempts total, 1s then 2s between them. Only
// plausibly transient failures retry — a network error, a 5xx, a 429; any
// other 4xx fails immediately, because it will not heal within the wait.
const BACKOFF_MS = [1_000, 2_000];
const LOG = "[await-pr-suite]";

export interface AwaitDeps {
  env: Record<string, string | undefined>;
  fetchFn: typeof fetch;
  sleepFn: (ms: number) => Promise<void>;
  /** Milliseconds since the epoch; the deadline is measured against it. */
  nowFn: () => number;
}

export interface AwaitOutcome {
  /** 0: the suite run succeeded; 1: any other outcome; 2: malformed input. */
  exitCode: 0 | 1 | 2;
  /** Log lines for stdout, in order; a failure ends with exactly one `::error::` line. */
  lines: string[];
  /** The successful run's id; set only when exitCode is 0. */
  runId?: number;
}

interface AwaitConfig {
  repo: string;
  token: string;
  headSha: string;
  deadlineMs: number;
  pollMs: number;
  outputPath: string | undefined;
}

interface SuiteRun {
  id: number;
  status: string;
  conclusion: string | null;
  createdMs: number;
}

/**
 * The awaiter's core, with every effect injected. It never throws: each
 * outcome, success or failure, is returned as an exit code and log lines.
 */
export async function awaitPrSuite(deps: AwaitDeps): Promise<AwaitOutcome> {
  const lines: string[] = [];
  let config: AwaitConfig;
  try {
    config = parseConfig(deps.env);
  } catch (error) {
    lines.push(errorLine(messageOf(error)));
    return { exitCode: 2, lines };
  }

  try {
    const run = await waitForCompletedRun(deps, config, lines);
    if (run.conclusion !== "success") {
      throw new Error(
        `the suite run ${run.id} concluded ${run.conclusion ?? "with no conclusion"}, not success`,
      );
    }
    if (config.outputPath !== undefined) {
      await appendFile(config.outputPath, `run_id=${run.id}\n`, "utf8");
    }
    lines.push(`${LOG} the suite run ${run.id} concluded success`);
    return { exitCode: 0, lines, runId: run.id };
  } catch (error) {
    lines.push(errorLine(messageOf(error)));
    return { exitCode: 1, lines };
  }
}

/**
 * Poll until the newest matching run is completed, or fail at the deadline.
 * The last poll lands exactly at the deadline: a sleep never carries the
 * clock past it.
 */
async function waitForCompletedRun(
  deps: AwaitDeps,
  config: AwaitConfig,
  lines: string[],
): Promise<SuiteRun> {
  const deadline = deps.nowFn() + config.deadlineMs;
  for (;;) {
    const run = newestSuiteRun(await listRuns(deps, config), config.headSha);
    if (run !== null && run.status === "completed") return run;

    const remaining = deadline - deps.nowFn();
    if (remaining <= 0) {
      throw new Error(
        run === null
          ? `no ${SUITE_WORKFLOW_PATH} run for ${config.headSha} appeared before the deadline`
          : `the deadline was reached while the suite run ${run.id} was still ${run.status}`,
      );
    }
    lines.push(
      run === null
        ? `${LOG} no suite run for ${config.headSha} yet; waiting`
        : `${LOG} the suite run ${run.id} is ${JSON.stringify(run.status)}; waiting`,
    );
    await deps.sleepFn(Math.min(config.pollMs, remaining));
  }
}

/**
 * The most recently created run of exactly the suite workflow at exactly the
 * head SHA, ties broken by the highest id; null when there is none. A matching
 * entry without a usable id or creation time fails closed rather than being
 * skipped, because skipping it could select an older run in its place.
 */
function newestSuiteRun(entries: unknown[], headSha: string): SuiteRun | null {
  let newest: SuiteRun | null = null;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (raw.path !== SUITE_WORKFLOW_PATH || raw.head_sha !== headSha) continue;
    const createdMs = typeof raw.created_at === "string" ? Date.parse(raw.created_at) : NaN;
    if (typeof raw.id !== "number" || !Number.isSafeInteger(raw.id) || Number.isNaN(createdMs)) {
      throw new Error("the listing holds a suite run without a usable id or created_at");
    }
    const run: SuiteRun = {
      id: raw.id,
      status: typeof raw.status === "string" ? raw.status : "",
      conclusion: typeof raw.conclusion === "string" ? raw.conclusion : null,
      createdMs,
    };
    if (
      newest === null ||
      run.createdMs > newest.createdMs ||
      (run.createdMs === newest.createdMs && run.id > newest.id)
    ) {
      newest = run;
    }
  }
  return newest;
}

/** One poll of the workflow-run listing at the head SHA, with the bounded retry. */
async function listRuns(deps: AwaitDeps, config: AwaitConfig): Promise<unknown[]> {
  const url =
    `${API_ROOT}/repos/${config.repo}/actions/runs` +
    `?head_sha=${config.headSha}&event=pull_request&per_page=100`;
  const body = await apiGet(deps, url, config.token);
  const runs =
    typeof body === "object" && body !== null
      ? (body as { workflow_runs?: unknown }).workflow_runs
      : undefined;
  if (!Array.isArray(runs)) {
    throw new Error("the workflow-run listing returned no workflow_runs array");
  }
  return runs;
}

/**
 * One GitHub API GET with the bounded retry. A network error, a 5xx or a 429
 * retries through the backoff; any other non-2xx fails at once. The failure
 * carries the status and GitHub's message — never a header, so the token
 * cannot reach the log.
 */
async function apiGet(deps: AwaitDeps, url: string, token: string): Promise<unknown> {
  let lastMessage = "";
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) {
      await deps.sleepFn(BACKOFF_MS[attempt - 1] ?? 0);
    }
    let response: Response;
    try {
      response = await deps.fetchFn(url, {
        method: "GET",
        headers: { ...API_HEADERS, authorization: `Bearer ${token}` },
      });
    } catch (error) {
      lastMessage = messageOf(error);
      continue;
    }
    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("the workflow-run listing returned a body that is not JSON");
      }
    }
    lastMessage = `HTTP ${response.status}: ${truncate(text)}`;
    if (response.status < 500 && response.status !== 429) {
      throw new Error(`the workflow-run listing failed: ${lastMessage}`);
    }
  }
  throw new Error(
    `the workflow-run listing failed after ${BACKOFF_MS.length + 1} attempts: ${lastMessage}`,
  );
}

function parseConfig(env: Record<string, string | undefined>): AwaitConfig {
  const repo = env.GITHUB_REPOSITORY ?? "";
  if (!REPOSITORY.test(repo)) {
    throw new Error(`GITHUB_REPOSITORY must name OWNER/REPO (got ${JSON.stringify(repo)})`);
  }
  const token = env.GH_TOKEN ?? "";
  if (token === "") {
    throw new Error("GH_TOKEN is required");
  }
  const headSha = env.HEAD_SHA ?? "";
  if (!SHA_40.test(headSha)) {
    throw new Error(`HEAD_SHA must be a 40-hex SHA (got ${JSON.stringify(headSha)})`);
  }
  return {
    repo,
    token,
    headSha,
    deadlineMs: seconds(env, "SUITE_DEADLINE_SECONDS", DEFAULT_DEADLINE_SECONDS) * 1000,
    pollMs: seconds(env, "SUITE_POLL_SECONDS", DEFAULT_POLL_SECONDS) * 1000,
    outputPath: env.GITHUB_OUTPUT === "" ? undefined : env.GITHUB_OUTPUT,
  };
}

function seconds(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined || value === "") return fallback;
  if (!POSITIVE_INTEGER.test(value)) {
    throw new Error(`${name} must be a positive whole number of seconds (got ${JSON.stringify(value)})`);
  }
  return Number(value);
}

/**
 * A `::error::` workflow command whose message is escaped the way the runner
 * decodes it, so text from the API stays one annotation on one line.
 */
function errorLine(message: string): string {
  const escaped = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return `::error::${escaped}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}

function main(): void {
  void awaitPrSuite({
    env: process.env,
    fetchFn: fetch,
    sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    nowFn: () => Date.now(),
  }).then((outcome) => {
    for (const line of outcome.lines) {
      console.log(line);
    }
    process.exitCode = outcome.exitCode;
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
