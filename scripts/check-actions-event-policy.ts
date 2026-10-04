#!/usr/bin/env node
// Verify the repository's active Actions policy admits every event used by its
// pull-request gates and ledger relay.

import { pathToFileURL } from "node:url";

import { mintAppJwt } from "./ledger-relay.ts";

const POLICY_LIST_URL =
  "https://api.github.com/repos/Nitjsefnie/Overflow/actions/policies";
const POLICY_LIST_PAGE_SIZE = 100;
const REQUIRED_EVENTS = ["pull_request_target", "workflow_run"] as const;
const API_ROOT = "https://api.github.com";
const CHECK_RUN_URL = `${API_ROOT}/repos/Nitjsefnie/Overflow/check-runs`;
const CHECK_RUN_NAME = "event-policy";

type RequiredEvent = (typeof REQUIRED_EVENTS)[number];
/** The three-state outcome: verified-good, verified-bad, and cannot-verify. */
type Outcome = "pass" | "fail" | "neutral";
type Classification = { outcome: Outcome; reason: string };
type ApiResponse = { status: number; body: string; error?: string; headers?: Headers };
type PolicySummary = { id: string; name: string };
type ParsedList = {
  policies?: PolicySummary[];
  totalCount?: number;
  error?: string;
  /** Set when the list request hit the known permission gap: cannot-verify, not failure. */
  neutralReason?: string;
};
type PolicyTransport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "text" | "headers">>;
type RunnerResult = { outcome: Outcome; exitCode: 0 | 1; message: string };
/** What runScript hands report(): the classification plus best-effort action warnings. */
export type ScriptRun = { result: RunnerResult; warnings: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function policyLabel(policy: PolicySummary): string {
  return `policy ${policy.id} ("${policy.name}")`;
}

function responseLabel(response: ApiResponse): string {
  if (response.error !== undefined) return `transport error: ${response.error}`;
  return `HTTP ${response.status}`;
}

function administrationAccessMessage(): string {
  return (
    "GITHUB_TOKEN cannot hold the Administration permission documented for the Actions " +
    "policies API; this job can pass only with a token carrying Administration read access " +
    "(for example, a maintainer-wired secret)."
  );
}

/** The one neutral reason: the known, documented permission gap on the list endpoint. */
function neutralGapReason(): string {
  return (
    "Cannot verify the Actions event policy: the policy-list request returned HTTP 403, the known " +
    "GITHUB_TOKEN permission gap (GITHUB_TOKEN cannot hold Administration read on the Actions " +
    "policies API). Ending neutral, tracked by issue 1024; with Overflow Ledger App credentials " +
    "present an App-owned neutral check run records cannot-verify."
  );
}

function rateLimitedReason(response: ApiResponse): string {
  return (
    `Actions policy list request failed with HTTP ${response.status}: GitHub is rate limiting ` +
    "this run (x-ratelimit-remaining 0, a retry-after header, or a rate-limit body); " +
    "the outcome is failure."
  );
}

/**
 * Whether a 403 is GitHub rate limiting rather than the known permission gap,
 * judged in the order the design pins: the x-ratelimit-remaining header at 0,
 * then a retry-after header, then the body naming a rate limit or abuse. The
 * permission-gap bodies ("Forbidden", "Resource not accessible by integration")
 * match none of these.
 */
function isRateLimited(response: ApiResponse): boolean {
  if (response.headers === undefined) {
    return /rate limit|abuse/i.test(response.body);
  }
  if (response.headers.get("x-ratelimit-remaining") === "0") return true;
  if (response.headers.get("retry-after") !== null) return true;
  return /rate limit|abuse/i.test(response.body);
}

function parsePolicyList(response: ApiResponse): ParsedList {
  if (response.error !== undefined) {
    return { error: `Actions policy list request failed with ${responseLabel(response)}.` };
  }
  if (response.status !== 200) {
    if (response.status === 404) {
      return {
        error:
          "Actions policy surface is absent (HTTP 404); GitHub enforcement starts " +
          "2026-11-02. Issue 818 alarm: the policy cannot be verified.",
      };
    }
    if (response.status === 403) {
      if (isRateLimited(response)) {
        return { error: rateLimitedReason(response) };
      }
      return { neutralReason: neutralGapReason() };
    }
    return {
      error:
        `Actions policy list request failed with HTTP ${response.status}; ` +
        "cannot verify the event policy (the token may lack access or the API may be rate limiting).",
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(response.body) as unknown;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      error: `Actions policy list returned malformed JSON (${cause}). Raw document: ${response.body}`,
    };
  }

  if (!isRecord(document) || !Array.isArray(document.policies)) {
    return {
      error:
        "Actions policy list response is malformed: expected a policies array. " +
        `Raw document: ${response.body}`,
    };
  }
  if (
    typeof document.total_count !== "number" ||
    !Number.isSafeInteger(document.total_count) ||
    document.total_count < 0
  ) {
    return {
      error:
        "Actions policy list response is malformed: expected a non-negative integer total_count. " +
        `Raw document: ${response.body}`,
    };
  }

  const policies: PolicySummary[] = [];
  for (const [index, value] of document.policies.entries()) {
    if (!isRecord(value)) {
      return {
        error:
          `Actions policy list item ${index + 1} is malformed: expected an object. ` +
          `Raw document: ${response.body}`,
      };
    }

    const idValue = value.id;
    const id =
      typeof idValue === "number" && Number.isSafeInteger(idValue) && idValue > 0
        ? String(idValue)
        : typeof idValue === "string" && idValue.trim().length > 0
          ? idValue
          : undefined;
    if (id === undefined) {
      return {
        error:
          `Actions policy list item ${index + 1} is malformed: missing a usable policy id. ` +
          `Raw document: ${response.body}`,
      };
    }
    if (value.name !== undefined && typeof value.name !== "string") {
      return {
        error:
          `Actions policy ${id} is malformed: expected its name to be a string. ` +
          `Raw document: ${response.body}`,
      };
    }
    policies.push({ id, name: typeof value.name === "string" ? value.name : "unnamed" });
  }

  return { policies, totalCount: document.total_count };
}

function parseDocument(response: ApiResponse): { document?: unknown; error?: string } {
  try {
    return { document: JSON.parse(response.body) as unknown };
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { error: `malformed JSON (${cause})` };
  }
}

function summarizeMissingEvents(rules: unknown[]): RequiredEvent[] | undefined {
  let bestMissing: RequiredEvent[] | undefined;
  let allowsBoth = false;
  for (const value of rules) {
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    if (value.type !== "restrict_action_events") continue;
    if (!isRecord(value.parameters) || !Array.isArray(value.parameters.allowed_events)) {
      return undefined;
    }
    const allowedEvents = value.parameters.allowed_events;
    if (!allowedEvents.every((event) => typeof event === "string")) return undefined;
    const missing = REQUIRED_EVENTS.filter((event) => !allowedEvents.includes(event));
    if (missing.length === 0) {
      allowsBoth = true;
      continue;
    }
    if (bestMissing === undefined || missing.length < bestMissing.length) bestMissing = missing;
  }
  if (allowsBoth) return [];
  return bestMissing ?? [...REQUIRED_EVENTS];
}

/**
 * Classifies the list response and its detail responses in list order. Every
 * required event must appear in one active policy's event allow-list, and that
 * policy must target all workflows or omit workflow_path, with no excluded
 * workflow paths. Only the documented active and disabled enforcement states
 * are accepted; malformed states reject the whole policy set.
 */
export function classify(
  listResponse: ApiResponse,
  policyResponses: ApiResponse[],
): Classification {
  const parsedList = parsePolicyList(listResponse);
  if (parsedList.neutralReason !== undefined) {
    return { outcome: "neutral", reason: parsedList.neutralReason };
  }
  if (parsedList.error !== undefined) return { outcome: "fail", reason: parsedList.error };
  const policies = parsedList.policies ?? [];
  const totalCount = parsedList.totalCount;
  if (totalCount === undefined) {
    return {
      outcome: "fail",
      reason: "Actions policy list is missing total_count; refusing to verify an incomplete list.",
    };
  }
  if (policies.length !== totalCount) {
    return {
      outcome: "fail",
      reason:
        `Fetched ${policies.length} Actions policy summaries, but total_count is ${totalCount}; ` +
        "refusing to verify an incomplete or ambiguous policy list.",
    };
  }
  if (policies.length === 0) {
    return {
      outcome: "fail",
      reason: "No Actions policies are configured; cannot verify the required workflow events.",
    };
  }
  if (policyResponses.length !== policies.length) {
    return {
      outcome: "fail",
      reason:
        `Received ${policyResponses.length} policy detail responses for ${policies.length} ` +
        "listed policies; refusing to verify an incomplete or ambiguous policy set.",
    };
  }

  const inspected: Array<{
    policy: PolicySummary;
    enforcement: "active" | "disabled";
    targetsAll: boolean;
    excludedWorkflowPaths: string[];
    missingEvents: RequiredEvent[];
  }> = [];

  for (const [index, policyResponse] of policyResponses.entries()) {
    const policy = policies[index];
    if (policy === undefined) {
      return { outcome: "fail", reason: "Policy detail response ordering is ambiguous." };
    }
    if (policyResponse.error !== undefined || policyResponse.status !== 200) {
      const accessGap =
        policyResponse.status === 403 ? ` ${administrationAccessMessage()}` : "";
      return {
        outcome: "fail",
        reason:
          `Could not read ${policyLabel(policy)}: ${responseLabel(policyResponse)}. ` +
          `Cannot verify the Actions event policy.${accessGap}`,
      };
    }

    const parsedDocument = parseDocument(policyResponse);
    if (parsedDocument.error !== undefined) {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} returned ${parsedDocument.error}. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    const document = parsedDocument.document;
    if (!isRecord(document)) {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} returned a malformed policy: expected an object. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    if (
      (typeof document.id !== "number" && typeof document.id !== "string") ||
      String(document.id) !== policy.id
    ) {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} returned a malformed policy: detail id does not match the list. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    if (document.name !== undefined && typeof document.name !== "string") {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} returned a malformed policy: name is not a string. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    if (document.enforcement !== "active" && document.enforcement !== "disabled") {
      const enforcement =
        document.enforcement === undefined ? "missing" : JSON.stringify(document.enforcement);
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} has malformed enforcement ${enforcement}; expected "active" ` +
          `or "disabled". Raw document: ${policyResponse.body}`,
      };
    }
    if (document.conditions !== undefined && !isRecord(document.conditions)) {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} returned a malformed policy: conditions is not an object. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    const conditions = isRecord(document.conditions) ? document.conditions : {};
    const workflowPath = conditions.workflow_path;
    let targetsAll = workflowPath === undefined;
    let excludedWorkflowPaths: string[] = [];
    if (workflowPath !== undefined) {
      if (!isRecord(workflowPath) || !Array.isArray(workflowPath.include)) {
        return {
          outcome: "fail",
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path condition. ` +
          `Raw document: ${policyResponse.body}`,
        };
      }
      if (!Array.isArray(workflowPath.exclude)) {
        return {
          outcome: "fail",
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path.exclude list. ` +
            `Raw document: ${policyResponse.body}`,
        };
      }
      if (!workflowPath.include.every((path) => typeof path === "string")) {
        return {
          outcome: "fail",
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path.include list. ` +
          `Raw document: ${policyResponse.body}`,
        };
      }
      if (!workflowPath.exclude.every((path) => typeof path === "string")) {
        return {
          outcome: "fail",
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path.exclude list. ` +
            `Raw document: ${policyResponse.body}`,
        };
      }
      targetsAll = workflowPath.include.includes("~ALL");
      excludedWorkflowPaths = workflowPath.exclude;
    }
    if (!Array.isArray(document.rules)) {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} returned a malformed policy: expected a rules array. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    const missingEvents = summarizeMissingEvents(document.rules);
    if (missingEvents === undefined) {
      return {
        outcome: "fail",
        reason:
          `${policyLabel(policy)} has a malformed restrict_action_events rule. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }

    inspected.push({
      policy: {
        id: policy.id,
        name: typeof document.name === "string" ? document.name : policy.name,
      },
      enforcement: document.enforcement,
      targetsAll,
      excludedWorkflowPaths,
      missingEvents,
    });
  }

  const qualifying = inspected.find(
    (policy) =>
      policy.enforcement === "active" &&
      policy.targetsAll &&
      policy.excludedWorkflowPaths.length === 0 &&
      policy.missingEvents.length === 0,
  );
  if (qualifying !== undefined) {
    return {
      outcome: "pass",
      reason:
        `${policyLabel(qualifying.policy)} is active, targets all workflows, and allows ` +
        `${REQUIRED_EVENTS.join(" and ")}.`,
    };
  }

  const active = inspected.filter((policy) => policy.enforcement === "active");
  if (active.length === 0) {
    const states = inspected
      .map((policy) => `${policyLabel(policy.policy)} enforcement is "${policy.enforcement}"`)
      .join("; ");
    return {
      outcome: "fail",
      reason: `No active Actions policy was found; ${states}. Expected enforcement "active".`,
    };
  }

  const fullCoveragePolicies = active.filter(
    (policy) => policy.targetsAll && policy.excludedWorkflowPaths.length === 0,
  );
  if (fullCoveragePolicies.length === 0) {
    const coverageIssues = active.map((policy) => {
      if (!policy.targetsAll) {
        return `${policyLabel(policy.policy)} has a narrower workflow_path condition than ~ALL`;
      }
      return (
        `${policyLabel(policy.policy)} excludes workflow path(s) ` +
        `${policy.excludedWorkflowPaths.join(", ")}; full coverage requires an empty exclude list`
      );
    });
    return {
      outcome: "fail",
      reason:
        `No active Actions policy covers all workflows with ~ALL (or omits workflow_path) and ` +
        `an empty exclude list; ${coverageIssues.join("; ")}.`,
    };
  }

  const eventIssues = fullCoveragePolicies.map(
    (policy) =>
      `${policyLabel(policy.policy)} is missing or blocks required event(s): ` +
      `${policy.missingEvents.join(", ") || REQUIRED_EVENTS.join(", ")}`,
  );
  return {
    outcome: "fail",
    reason: `${eventIssues.join("; ")}.`,
  };
}

function errorCause(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s+/g, " ").trim();
}

async function request(
  url: string,
  token: string,
  transport: PolicyTransport,
): Promise<ApiResponse> {
  try {
    const response = await transport(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(30_000),
    });
    return { status: response.status, body: await response.text(), headers: response.headers };
  } catch (error) {
    return { status: 0, body: "", error: errorCause(error) };
  }
}

function policyListPageUrl(page: number): string {
  const url = new URL(POLICY_LIST_URL);
  url.searchParams.set("per_page", String(POLICY_LIST_PAGE_SIZE));
  url.searchParams.set("page", String(page));
  return url.toString();
}

function runnerResult(result: Classification): RunnerResult {
  return {
    outcome: result.outcome,
    exitCode: result.outcome === "fail" ? 1 : 0,
    message: result.reason,
  };
}

export async function runCheck(
  token: string | undefined,
  transport: PolicyTransport = globalThis.fetch,
): Promise<RunnerResult> {
  if (token === undefined || token.length === 0) {
    return {
      outcome: "fail",
      exitCode: 1,
      message: "Missing GITHUB_TOKEN and GH_TOKEN; cannot verify the Actions event policy.",
    };
  }

  const firstPageResponse = await request(policyListPageUrl(1), token, transport);
  const firstPage = parsePolicyList(firstPageResponse);
  if (
    firstPage.error !== undefined ||
    firstPage.policies === undefined ||
    firstPage.totalCount === undefined
  ) {
    return runnerResult(classify(firstPageResponse, []));
  }

  const policies: PolicySummary[] = [];
  const policyIds = new Set<string>();
  const appendPage = (pagePolicies: PolicySummary[], page: number): string | undefined => {
    for (const policy of pagePolicies) {
      if (policyIds.has(policy.id)) {
        return `Actions policy list pagination returned duplicate policy id ${policy.id} ` +
          `on page ${page}; refusing to verify a broken pagination contract.`;
      }
      policyIds.add(policy.id);
      policies.push(policy);
    }
    return undefined;
  };
  const firstPageDuplicate = appendPage(firstPage.policies, 1);
  if (firstPageDuplicate !== undefined) {
    return { outcome: "fail", exitCode: 1, message: firstPageDuplicate };
  }

  const totalCount = firstPage.totalCount;
  for (let page = 2; policyIds.size < totalCount && page <= totalCount; page += 1) {
    const pageResponse = await request(policyListPageUrl(page), token, transport);
    const parsedPage = parsePolicyList(pageResponse);
    if (
      parsedPage.error !== undefined ||
      parsedPage.policies === undefined ||
      parsedPage.totalCount === undefined
    ) {
      const failedPage = classify(pageResponse, []);
      if (failedPage.outcome === "neutral") {
        return runnerResult(failedPage);
      }
      return {
        outcome: "fail",
        exitCode: 1,
        message: `Actions policy list page ${page} failed: ${failedPage.reason}`,
      };
    }
    const duplicateId = appendPage(parsedPage.policies, page);
    if (duplicateId !== undefined) {
      return { outcome: "fail", exitCode: 1, message: duplicateId };
    }
    if (parsedPage.totalCount !== totalCount) {
      return {
        outcome: "fail",
        exitCode: 1,
        message:
          `Actions policy pagination changed total_count from ${totalCount} on page 1 ` +
          `to ${parsedPage.totalCount} on page ${page}; refusing to verify an unstable list.`,
      };
    }
    if (parsedPage.policies.length === 0) break;
  }

  const completeListResponse: ApiResponse = {
    status: 200,
    body: JSON.stringify({ total_count: totalCount, policies }),
  };
  if (policyIds.size !== totalCount) {
    return {
      outcome: "fail",
      exitCode: 1,
      message:
        `Fetched ${policyIds.size} distinct Actions policy IDs, but total_count is ${totalCount}; ` +
        "refusing to verify an incomplete policy list.",
    };
  }
  if (policyIds.size === 0) {
    return runnerResult(classify(completeListResponse, []));
  }

  const policyResponses = await Promise.all(
    policies.map((policy) =>
      request(`${POLICY_LIST_URL}/${encodeURIComponent(policy.id)}`, token, transport),
    ),
  );
  return runnerResult(classify(completeListResponse, policyResponses));
}

export type RenderedReport = { out: string[]; err: string[]; exitCode: 0 | 1 };

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Pure report rendering, so the annotation contract is pinnable: neutral logs
 * the message and one ::warning:: annotation, exit 0; fail logs the message
 * (annotation-only for the missing-token message, as before) plus one
 * ::error:: annotation, exit 1; pass logs the message alone, exit 0.
 */
export function renderReport(result: RunnerResult, warnings: string[] = []): RenderedReport {
  const annotation = collapseWhitespace(result.message);
  const warningLines = warnings.map((warning) => `::warning::${collapseWhitespace(warning)}`);
  if (result.outcome === "neutral") {
    return {
      out: [result.message],
      err: [`::warning::${annotation}`, ...warningLines],
      exitCode: 0,
    };
  }
  if (result.outcome === "pass") {
    return { out: [result.message], err: warningLines, exitCode: 0 };
  }
  const annotationOnly = result.message.startsWith("Missing GITHUB_TOKEN");
  return {
    out: [annotationOnly ? `::error::${annotation}` : result.message],
    err: [`::error::${annotation}`, ...warningLines],
    exitCode: 1,
  };
}

function report(result: RunnerResult, warnings: string[]): void {
  const rendered = renderReport(result, warnings);
  for (const line of rendered.out) console.log(line);
  for (const line of rendered.err) console.error(line);
  process.exitCode = rendered.exitCode;
}

function ledgerAppCredentials(
  env: Record<string, string | undefined>,
): { appId: string; installationId: string; appKey: string } | undefined {
  const appId = env.LEDGER_APP_ID?.trim();
  const installationId = env.LEDGER_INSTALLATION_ID?.trim();
  const appKey = env.LEDGER_APP_KEY;
  if (appId === undefined || appId === "") return undefined;
  if (installationId === undefined || installationId === "") return undefined;
  if (appKey === undefined || appKey === "") return undefined;
  return { appId, installationId, appKey };
}

/** One best-effort mint: a token, or a warning naming why there is none. */
type MintOutcome = { token?: string; warning?: string };

/**
 * The Ledger App installation token, mirroring scripts/ledger-relay.ts: the
 * RS256 App JWT from its exported mintAppJwt, then the installation-token
 * POST it performs inside runRelay. Best-effort: credentials absent gives
 * an empty outcome with no warning; any mint failure gives a warning and the
 * caller falls back to GH_TOKEN. Never throws.
 */
async function mintInstallationToken(
  env: Record<string, string | undefined>,
  transport: PolicyTransport,
): Promise<MintOutcome> {
  const credentials = ledgerAppCredentials(env);
  if (credentials === undefined) return {};
  try {
    const jwt = mintAppJwt(credentials.appId, credentials.appKey, Date.now());
    const response = await transport(
      `${API_ROOT}/app/installations/${credentials.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ repositories: ["Overflow"] }),
      },
    );
    const body = await response.text();
    if (response.status < 200 || response.status >= 300) {
      return {
        warning:
          `the Overflow Ledger App installation token could not be minted (HTTP ${response.status}); ` +
          "falling back to GH_TOKEN",
      };
    }
    const parsed: unknown = JSON.parse(body);
    const token =
      isRecord(parsed) && typeof parsed.token === "string" && parsed.token !== ""
        ? parsed.token
        : undefined;
    if (token === undefined) {
      return {
        warning:
          "the Overflow Ledger App installation-token mint returned no token; " +
          "falling back to GH_TOKEN",
      };
    }
    return { token };
  } catch (error) {
    return {
      warning:
        `the Overflow Ledger App installation token could not be minted (${errorCause(error)}); ` +
        "falling back to GH_TOKEN",
    };
  }
}

function neutralCheckRunBody(headSha: string): Record<string, unknown> {
  return {
    name: CHECK_RUN_NAME,
    head_sha: headSha,
    status: "completed",
    conclusion: "neutral",
    output: {
      title: "Cannot verify the Actions event policy",
      summary:
        "The policy-list request returned the known GITHUB_TOKEN permission gap (HTTP 403): " +
        "GITHUB_TOKEN cannot hold Administration read on the Actions policies API. Ending neutral, " +
        "tracked by issue 1024, so cannot-verify stays distinguishable from verified.",
    },
  };
}

/**
 * The App-owned neutral check run, best-effort: skipped with a warning when
 * GITHUB_SHA is absent, and any post failure becomes a warning — the job still
 * ends neutral. Never throws.
 */
async function postNeutralCheckRun(
  appToken: string,
  env: Record<string, string | undefined>,
  transport: PolicyTransport,
): Promise<string | undefined> {
  const headSha = env.GITHUB_SHA;
  if (headSha === undefined || headSha === "") {
    return "the neutral check run was skipped because GITHUB_SHA is absent";
  }
  try {
    const response = await transport(CHECK_RUN_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify(neutralCheckRunBody(headSha)),
    });
    if (response.status < 200 || response.status >= 300) {
      return `the neutral check run could not be posted (HTTP ${response.status})`;
    }
    return undefined;
  } catch (error) {
    return `the neutral check run could not be posted (${errorCause(error)})`;
  }
}

/**
 * The entry: mint the App installation token when all three LEDGER_* variables
 * are present (falling back to GH_TOKEN on any mint failure), run the whole
 * check with that token, and — on a neutral outcome — post the App-owned
 * neutral check run best-effort. Never throws.
 */
export async function runScript(
  env: Record<string, string | undefined>,
  transport: PolicyTransport = globalThis.fetch,
): Promise<ScriptRun> {
  const mint = await mintInstallationToken(env, transport);
  const appToken = mint.token;
  const warnings: string[] = [];
  if (mint.warning !== undefined) warnings.push(mint.warning);
  const token = appToken ?? (env.GITHUB_TOKEN || env.GH_TOKEN);
  const result = await runCheck(token, transport);
  if (result.outcome === "neutral" && appToken !== undefined) {
    const warning = await postNeutralCheckRun(appToken, env, transport);
    if (warning !== undefined) warnings.push(warning);
  }
  return { result, warnings };
}

async function main(): Promise<void> {
  const { result, warnings } = await runScript(process.env);
  report(result, warnings);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
