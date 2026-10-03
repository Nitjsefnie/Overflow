#!/usr/bin/env node
// Verify the repository's active Actions policy admits every event used by its
// pull-request gates and ledger relay.

import { pathToFileURL } from "node:url";

const POLICY_LIST_URL =
  "https://api.github.com/repos/Nitjsefnie/Overflow/actions/policies";
const REQUIRED_EVENTS = ["pull_request_target", "workflow_run"] as const;

type RequiredEvent = (typeof REQUIRED_EVENTS)[number];
type Classification = { pass: boolean; reason: string };
type ApiResponse = { status: number; body: string; error?: string };
type PolicySummary = { id: string; name: string };
type ParsedList = { policies?: PolicySummary[]; error?: string };
type PolicyTransport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "text">>;
type RunnerResult = { exitCode: 0 | 1; message: string };

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
      return {
        error:
          `Actions policy list request failed with HTTP 403. ${administrationAccessMessage()}`,
      };
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

  return { policies };
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
  if (parsedList.error !== undefined) return { pass: false, reason: parsedList.error };
  const policies = parsedList.policies ?? [];
  if (policies.length === 0) {
    return {
      pass: false,
      reason: "No Actions policies are configured; cannot verify the required workflow events.",
    };
  }
  if (policyResponses.length !== policies.length) {
    return {
      pass: false,
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
      return { pass: false, reason: "Policy detail response ordering is ambiguous." };
    }
    if (policyResponse.error !== undefined || policyResponse.status !== 200) {
      const accessGap =
        policyResponse.status === 403 ? ` ${administrationAccessMessage()}` : "";
      return {
        pass: false,
        reason:
          `Could not read ${policyLabel(policy)}: ${responseLabel(policyResponse)}. ` +
          `Cannot verify the Actions event policy.${accessGap}`,
      };
    }

    const parsedDocument = parseDocument(policyResponse);
    if (parsedDocument.error !== undefined) {
      return {
        pass: false,
        reason:
          `${policyLabel(policy)} returned ${parsedDocument.error}. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    const document = parsedDocument.document;
    if (!isRecord(document)) {
      return {
        pass: false,
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
        pass: false,
        reason:
          `${policyLabel(policy)} returned a malformed policy: detail id does not match the list. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    if (document.name !== undefined && typeof document.name !== "string") {
      return {
        pass: false,
        reason:
          `${policyLabel(policy)} returned a malformed policy: name is not a string. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    if (document.enforcement !== "active" && document.enforcement !== "disabled") {
      const enforcement =
        document.enforcement === undefined ? "missing" : JSON.stringify(document.enforcement);
      return {
        pass: false,
        reason:
          `${policyLabel(policy)} has malformed enforcement ${enforcement}; expected "active" ` +
          `or "disabled". Raw document: ${policyResponse.body}`,
      };
    }
    if (document.conditions !== undefined && !isRecord(document.conditions)) {
      return {
        pass: false,
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
          pass: false,
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path condition. ` +
          `Raw document: ${policyResponse.body}`,
        };
      }
      if (!Array.isArray(workflowPath.exclude)) {
        return {
          pass: false,
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path.exclude list. ` +
            `Raw document: ${policyResponse.body}`,
        };
      }
      if (!workflowPath.include.every((path) => typeof path === "string")) {
        return {
          pass: false,
          reason:
            `${policyLabel(policy)} returned a malformed workflow_path.include list. ` +
          `Raw document: ${policyResponse.body}`,
        };
      }
      if (!workflowPath.exclude.every((path) => typeof path === "string")) {
        return {
          pass: false,
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
        pass: false,
        reason:
          `${policyLabel(policy)} returned a malformed policy: expected a rules array. ` +
          `Raw document: ${policyResponse.body}`,
      };
    }
    const missingEvents = summarizeMissingEvents(document.rules);
    if (missingEvents === undefined) {
      return {
        pass: false,
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
      pass: true,
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
      pass: false,
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
      pass: false,
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
    pass: false,
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
    return { status: response.status, body: await response.text() };
  } catch (error) {
    return { status: 0, body: "", error: errorCause(error) };
  }
}

function listPolicies(response: ApiResponse): PolicySummary[] | undefined {
  const parsed = parsePolicyList(response);
  return parsed.policies;
}

function runnerResult(result: Classification): RunnerResult {
  return { exitCode: result.pass ? 0 : 1, message: result.reason };
}

export async function runCheck(
  token: string | undefined,
  transport: PolicyTransport = globalThis.fetch,
): Promise<RunnerResult> {
  if (token === undefined || token.length === 0) {
    return {
      exitCode: 1,
      message: "Missing GITHUB_TOKEN and GH_TOKEN; cannot verify the Actions event policy.",
    };
  }

  const listResponse = await request(POLICY_LIST_URL, token, transport);
  const policies = listPolicies(listResponse);
  if (policies === undefined || policies.length === 0) {
    return runnerResult(classify(listResponse, []));
  }

  const policyResponses = await Promise.all(
    policies.map((policy) =>
      request(`${POLICY_LIST_URL}/${encodeURIComponent(policy.id)}`, token, transport),
    ),
  );
  return runnerResult(classify(listResponse, policyResponses));
}

function report(result: RunnerResult): void {
  const annotation = result.message.replace(/\s+/g, " ").trim();
  console.log(
    result.exitCode !== 0 && result.message.startsWith("Missing GITHUB_TOKEN")
      ? `::error::${annotation}`
      : result.message,
  );
  if (result.exitCode !== 0) {
    console.error(`::error::${annotation}`);
    process.exitCode = result.exitCode;
  }
}

async function main(): Promise<void> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  report(await runCheck(token));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
