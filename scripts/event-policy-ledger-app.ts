// The Overflow Ledger App half of the Actions event-policy check: minting the
// App installation token the check runs under when the LEDGER_* credentials are
// present, and posting the App-owned neutral check run that records
// cannot-verify on the known GITHUB_TOKEN permission gap (issue 1024).
// Best-effort by contract: neither action may fail the job, so every failure
// becomes a warning annotation and the check falls back to GH_TOKEN.

import { mintAppJwt } from "./ledger-relay.ts";

const API_ROOT = "https://api.github.com";
const CHECK_RUN_URL = `${API_ROOT}/repos/Nitjsefnie/Overflow/check-runs`;
const CHECK_RUN_NAME = "event-policy";

/** A transport for the GitHub API: what a Response usefully exposes here. */
export type PolicyTransport = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, "status" | "text" | "headers">>;

export function errorCause(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s+/g, " ").trim();
}

/** One best-effort mint: a token, or a warning naming why there is none. */
export type MintOutcome = { token?: string; warning?: string };

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

/**
 * The Ledger App installation token, mirroring scripts/ledger-relay.ts: the
 * RS256 App JWT from its exported mintAppJwt, then the installation-token
 * POST it performs inside runRelay. Best-effort: credentials absent gives
 * an empty outcome with no warning; any mint failure gives a warning and the
 * caller falls back to GH_TOKEN. Never throws.
 */
export async function mintInstallationToken(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
export async function postNeutralCheckRun(
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
