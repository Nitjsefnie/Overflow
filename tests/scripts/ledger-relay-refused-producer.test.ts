import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { runRelay } from "../../scripts/ledger-relay.ts";

const REPOSITORY = "Nitjsefnie/Overflow";
const RUN_ID = "9001";
const HEAD_SHA = "a".repeat(40);
const CI_PATH = ".github/workflows/ci.yml";
const HTML_URL = `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}`;
const PULL_REQUEST_BRANCH = "feature/issue-1170";
const PROBE_BRANCH = "codex-probe-issue-1071";
const UNRELATED_FIRST_PULL_REQUESTS = [
  { state: "open", head: { sha: HEAD_SHA, ref: "another-branch" } },
  { state: "open", head: { sha: HEAD_SHA, ref: PULL_REQUEST_BRANCH } },
];
const APP_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

interface RequestRecord {
  url: string;
  init: RequestInit;
}

interface Outcome {
  status: number;
  body: unknown;
}

describe("untrusted runs whose SHA is an open pull request head", () => {
  it.each([
    {
      name: "no-ops for a workflow_dispatch probe sharing the pull request's SHA",
      event: "workflow_dispatch",
      headBranch: PROBE_BRANCH,
      throws: false,
    },
    {
      name: "keeps throwing for the pull_request producer on its own head ref",
      event: "pull_request",
      headBranch: PULL_REQUEST_BRANCH,
      throws: true,
    },
    {
      name: "no-ops when a pull_request event names a different head ref",
      event: "pull_request",
      headBranch: "another-branch",
      throws: false,
    },
    {
      name: "no-ops when a workflow_dispatch names the pull request's head ref",
      event: "workflow_dispatch",
      headBranch: PULL_REQUEST_BRANCH,
      throws: false,
    },
    {
      name: "no-ops for a probe when an unrelated same-SHA pull request is listed first",
      event: "workflow_dispatch",
      headBranch: PROBE_BRANCH,
      throws: false,
      pullRequests: UNRELATED_FIRST_PULL_REQUESTS,
    },
    {
      name: "throws when its producer pull request follows an unrelated same-SHA pull request",
      event: "pull_request",
      headBranch: PULL_REQUEST_BRANCH,
      throws: true,
      pullRequests: UNRELATED_FIRST_PULL_REQUESTS,
    },
  ])("$name", async ({ event, headBranch, throws, pullRequests }) => {
    const requests: RequestRecord[] = [];
    const outcomes: Outcome[] = [
      { status: 201, body: { token: Buffer.from("relay-test").toString("base64url") } },
      {
        status: 200,
        body: { head_repository: { full_name: REPOSITORY } },
      },
      {
        status: 200,
        body: pullRequests ?? [{ state: "open", head: { sha: HEAD_SHA, ref: PULL_REQUEST_BRANCH } }],
      },
    ];
    const fetchFn = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      requests.push({ url, init: init ?? {} });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(outcome.body), {
        status: outcome.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const result = runRelay({
      env: {
        LEDGER_APP_ID: "1",
        LEDGER_INSTALLATION_ID: "2",
        LEDGER_APP_KEY: APP_KEY,
        GITHUB_REPOSITORY: REPOSITORY,
        GITHUB_WORKFLOW_RUN_ID: RUN_ID,
        GITHUB_WORKFLOW_RUN_HEAD_SHA: HEAD_SHA,
        GITHUB_WORKFLOW_RUN_PATH: CI_PATH,
        GITHUB_WORKFLOW_RUN_CONCLUSION: "success",
        GITHUB_WORKFLOW_RUN_HTML_URL: HTML_URL,
        GITHUB_WORKFLOW_RUN_EVENT: event,
        GITHUB_WORKFLOW_RUN_HEAD_BRANCH: headBranch,
      },
      fetchFn,
      delayFn: async () => undefined,
      readPinMap: async () => ({ verify: CI_PATH }),
    });

    if (throws) {
      await expect(result).rejects.toThrow("did not execute the base branch's workflow definition");
    } else {
      const relayResult = await result;
      expect(relayResult.posted).toEqual([]);
      expect(relayResult.decisions).toEqual([]);
    }

    expect(
      requests.filter((request) => request.url.endsWith("/check-runs") && request.init.method === "POST"),
    ).toEqual([]);
  });
});
