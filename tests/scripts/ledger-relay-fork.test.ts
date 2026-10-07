import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { renderRelayResult, runRelay } from "../../scripts/ledger-relay.ts";

/**
 * The fork-head refusals (issue 1142): a pinned run whose head lives in a
 * fork is decided live or dead by the base repository's open pulls at
 * `head=<owner>:<branch>` — live keeps the byte-identical throw, dead
 * downgrades to the visible exit-0 no-op, exactly as a same-repository head
 * was already decided (issue 1115). The owner must be provable from the run
 * body's `head_repository` before any request; every unprovable shape, a
 * deleted fork, and any read failure throws (fail closed).
 *
 * A separate file from tests/scripts/ledger-relay.test.ts because that file
 * sits at the tests family's module-size ceiling; the fixtures here mirror
 * its refusal describe block's stubs.
 */

const PATH_ACTIONLINT = ".github/workflows/actionlint.yml";

const PIN_MAP = { actionlint: PATH_ACTIONLINT };

describe("runRelay fork-head refusals (issue 1142)", () => {
  let keyPem = "";

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  // The incident's fields: a month-old pull_request run of actionlint.yml
  // from the closed fork pull request v01dst/Overflow#146, whose head has
  // since moved — the run that turned main's relay job red at e87a55f.
  const HEAD_SHA = `c7e06a4${"a".repeat(33)}`;
  const RUN_ID = "34069440939";
  const HEAD_BRANCH = "fix/117-env-file-migrate";
  const HTML_URL = `https://github.com/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
  const TOKEN_URL = "https://api.github.com/app/installations/166057493/access_tokens";
  const RUN_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
  // The encoding is pinned as a literal, not re-derived through
  // encodeURIComponent: a test that builds its expectation with the code's
  // own expression cannot catch an encoding change.
  const FORK_PULLS_URL =
    "https://api.github.com/repos/Nitjsefnie/Overflow/pulls?state=open" +
    "&head=v01dst%3Afix%2F117-env-file-migrate&per_page=100";
  const CHECK_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs";
  const REFUSAL =
    `run ${RUN_ID} (event "pull_request", head branch "${HEAD_BRANCH}") ` +
    "did not execute the base branch's workflow definition; no required context was relayed";

  interface Recorded {
    url: string;
    init: RequestInit;
  }

  type Outcome = { status: number; body: unknown } | { fail: Error };

  function makeFetch(outcomes: Outcome[]) {
    const requests: Recorded[] = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const rendered = typeof url === "string" ? url : String(url);
      requests.push({ url: rendered, init: init ?? {} });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error(`unexpected fetch: ${rendered}`);
      if ("fail" in outcome) throw outcome.fail;
      return new Response(JSON.stringify(outcome.body), {
        status: outcome.status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    return { requests, fn };
  }

  function makeDelay() {
    const delays: number[] = [];
    return { delays, fn: async (ms: number) => void delays.push(ms) };
  }

  /** The workflow_run trigger's env, in the incident's shape. */
  function relayEnv(over: Record<string, string> = {}): Record<string, string> {
    return {
      LEDGER_APP_ID: "5118623",
      LEDGER_INSTALLATION_ID: "166057493",
      LEDGER_APP_KEY: keyPem,
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      GITHUB_WORKFLOW_RUN_ID: RUN_ID,
      GITHUB_WORKFLOW_RUN_HEAD_SHA: HEAD_SHA,
      GITHUB_WORKFLOW_RUN_PATH: PATH_ACTIONLINT,
      GITHUB_WORKFLOW_RUN_CONCLUSION: "failure",
      GITHUB_WORKFLOW_RUN_HTML_URL: HTML_URL,
      GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: HEAD_BRANCH,
      ...over,
    };
  }

  function token(): Outcome {
    return { status: 201, body: { token: "installation-token" } };
  }

  /** The run body the gate fetches to learn the head repository and owner. */
  function fetchedRunBody(over: Record<string, unknown> = {}): Outcome {
    return {
      status: 200,
      body: {
        id: Number(RUN_ID),
        head_sha: HEAD_SHA,
        path: PATH_ACTIONLINT,
        conclusion: "failure",
        html_url: HTML_URL,
        event: "pull_request",
        head_branch: HEAD_BRANCH,
        head_repository: {
          full_name: "v01dst/Overflow",
          owner: { login: "v01dst" },
        },
        ...over,
      },
    };
  }

  /** One open pull request in the base repository's fork pulls listing. */
  function forkPullEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { number: 146, state: "open", head: { ref: HEAD_BRANCH, sha: HEAD_SHA }, ...over };
  }

  function forkPullsListing(entries: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: entries };
  }

  function relay(env: Record<string, string>, stub: ReturnType<typeof makeFetch>) {
    return runRelay({
      env,
      fetchFn: stub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
  }

  async function caughtError(promise: Promise<unknown>): Promise<Error | undefined> {
    return promise.then(
      () => undefined,
      (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
    );
  }

  function requestsTo(requests: Recorded[], url: string): Recorded[] {
    return requests.filter((request) => request.url === url);
  }

  function headersOf(request: Recorded): Record<string, string> {
    return request.init.headers as Record<string, string>;
  }

  it("relays nothing and exits 0 for the incident's dead closed-fork run", async () => {
    // The incident: the refusal gate learns the fork head repository and its
    // owner from the run body, the branch-scoped listing answers empty, and
    // the refusal downgrades to the exit-0 no-op instead of turning main red.
    const fetchStub = makeFetch([token(), fetchedRunBody(), forkPullsListing([])]);
    const result = await relay(relayEnv(), fetchStub);

    expect(result.posted).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.rerunDispatched).toBe(false);
    expect(result.sweep.examined).toBe(0);
    expect(result.refusedDeadHead, "a dead fork head exits 0 through the refusal").toBe(REFUSAL);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      RUN_URL,
      FORK_PULLS_URL,
    ]);
    expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    expect(renderRelayResult(result)).toEqual([
      `[ledger-relay] ${REFUSAL}`,
      "[ledger-relay] no open pull request is waiting at this head",
    ]);
  });

  it("requests the fork listing under the percent-encoded head parameter, as the App installation token", async () => {
    const fetchStub = makeFetch([token(), fetchedRunBody(), forkPullsListing([])]);
    await relay(relayEnv(), fetchStub);

    const listingRequest = requestsTo(fetchStub.requests, FORK_PULLS_URL);
    expect(listingRequest).toHaveLength(1);
    const request = listingRequest[0];
    if (!request) throw new Error("the fork listing request is missing");
    expect(request.url).toContain("head=v01dst%3Afix%2F117-env-file-migrate");
    expect(request.init.method).toBe("GET");
    expect(headersOf(request).authorization).toBe("Bearer installation-token");
  });

  it("keeps the byte-identical throw when a live open fork pull request carries the run's head SHA", async () => {
    // A live fork head keeps issue 1083's visibility: the listing carries the
    // refused run's own SHA, so the refusal stays a throw.
    const fetchStub = makeFetch([token(), fetchedRunBody(), forkPullsListing([forkPullEntry()])]);
    const error = await caughtError(relay(relayEnv(), fetchStub));

    expect(error, "a live fork head must keep the refusal visible").toBeInstanceOf(Error);
    expect(error?.message, "the message stays byte-identical").toBe(REFUSAL);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      RUN_URL,
      FORK_PULLS_URL,
    ]);
    expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
  });

  it("treats the fork head as dead when the listing's only open pull request has moved to another SHA", async () => {
    // Sha equality is exact: an open pull request from the same branch whose
    // tip has moved does not make the run's head live.
    const fetchStub = makeFetch([
      token(),
      fetchedRunBody(),
      forkPullsListing([forkPullEntry({ head: { ref: HEAD_BRANCH, sha: "b".repeat(40) } })]),
    ]);
    const result = await relay(relayEnv(), fetchStub);

    expect(result.refusedDeadHead, "a moved fork head is a dead head").toBe(REFUSAL);
    expect(result.posted).toEqual([]);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      RUN_URL,
      FORK_PULLS_URL,
    ]);
  });

  it.each([
    [
      "the run body names no owner login",
      { head_repository: { full_name: "v01dst/Overflow" } },
      {},
      /head_repository\.owner\.login/,
    ],
    [
      "the owner login does not match the full name's owner prefix",
      { head_repository: { full_name: "notv01dst/Overflow", owner: { login: "v01dst" } } },
      {},
      /does not begin with the owner login/,
    ],
    [
      "the owner login carries a slash",
      { head_repository: { full_name: "v01dst/Overflow", owner: { login: "v01dst/Overflow" } } },
      {},
      /head_repository\.owner\.login/,
    ],
    [
      "the owner login carries whitespace",
      { head_repository: { full_name: "v01dst/Overflow", owner: { login: "v01dst hax" } } },
      {},
      /head_repository\.owner\.login/,
    ],
    [
      "the run names no head branch",
      {},
      { GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "" },
      /names no head branch/,
    ],
    [
      "the fork listing answers a non-array",
      {},
      {},
      /returned no array/,
    ],
  ])("fails closed before any posting when %s", async (_name, bodyOver, envOver, expected) => {
    const fetchStub = makeFetch([
      token(),
      fetchedRunBody(bodyOver),
      { status: 200, body: { total_count: 0 } },
    ]);
    const error = await caughtError(relay(relayEnv(envOver), fetchStub));

    expect(error, "an unprovable fork head must fail closed").toBeInstanceOf(Error);
    expect(error?.message).toMatch(expected);
    expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    expect(fetchStub.requests[0]?.url).toBe(TOKEN_URL);
    expect(fetchStub.requests[1]?.url).toBe(RUN_URL);
  });

  it("fails closed when the fork listing read fails after the bounded retries", async () => {
    // One failing outcome per attempt: the bounded retry consumes three.
    const networkDown: Outcome = { fail: new Error("network down") };
    const fetchStub = makeFetch([token(), fetchedRunBody(), networkDown, networkDown, networkDown]);
    const error = await caughtError(relay(relayEnv(), fetchStub));

    expect(error, "an unreadable listing must fail closed").toBeInstanceOf(Error);
    expect(error?.message).toBe(
      `the open pull requests from v01dst:${HEAD_BRANCH} failed after 3 attempts: network down`,
    );
    // Every retry re-issues the same listing request.
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      RUN_URL,
      FORK_PULLS_URL,
      FORK_PULLS_URL,
      FORK_PULLS_URL,
    ]);
    expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
  });

  it("throws the refusal for a deleted fork whose run body names no head repository", async () => {
    // head_repository is null on a deleted fork, so the name is unknown and
    // the unknown-name limb keeps the refusal visible; the listing is never
    // consulted. Pinned in the issue's Known Limitations.
    const fetchStub = makeFetch([token(), fetchedRunBody({ head_repository: null })]);
    const error = await caughtError(relay(relayEnv(), fetchStub));

    expect(error, "a deleted fork must keep the refusal visible").toBeInstanceOf(Error);
    expect(error?.message).toBe(REFUSAL);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL]);
    expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
  });
});
