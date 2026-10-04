import { createVerify, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import * as actionsEventPolicy from "../../scripts/check-actions-event-policy.ts";
import { classify } from "../../scripts/check-actions-event-policy.ts";

type ApiResponse = { status: number; body: string; error?: string; headers?: Headers };
type PolicyTransport = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "status" | "text" | "headers">>;
type Outcome = "pass" | "fail" | "neutral";
type RunnerResult = { outcome: Outcome; exitCode: number; message: string };
type Runner = (token: string | undefined, transport?: PolicyTransport) => Promise<RunnerResult>;
type ScriptRun = { result: RunnerResult; warnings: string[] };
type ScriptRunner = (
  env: Record<string, string | undefined>,
  transport?: PolicyTransport,
) => Promise<ScriptRun>;
type ReportRenderer = (
  result: RunnerResult,
  warnings?: string[],
) => { out: string[]; err: string[]; exitCode: number };

const runCheck = (actionsEventPolicy as typeof actionsEventPolicy & { runCheck?: Runner })
  .runCheck;
const runScript = (actionsEventPolicy as typeof actionsEventPolicy & { runScript?: ScriptRunner })
  .runScript;
const renderReport = (
  actionsEventPolicy as typeof actionsEventPolicy & { renderReport?: ReportRenderer }
).renderReport;
const POLICY_LIST_URL =
  "https://api.github.com/repos/Nitjsefnie/Overflow/actions/policies";
const POLICY_LIST_PATH = new URL(POLICY_LIST_URL).pathname;

function policyListPageUrl(page: number): string {
  const url = new URL(POLICY_LIST_URL);
  url.searchParams.set("per_page", "100");
  url.searchParams.set("page", String(page));
  return url.toString();
}

function activePolicyDetail(id: number): Response {
  return new Response(JSON.stringify({
    id,
    name: `policy-${id}`,
    enforcement: "active",
    conditions: { workflow_path: { include: ["~ALL"], exclude: [] } },
    rules: [
      {
        type: "restrict_action_events",
        parameters: { allowed_events: events },
      },
    ],
  }), { status: 200 });
}

const events = ["pull_request_target", "workflow_run"];

function listResponse(policyCount: number): ApiResponse {
  return {
    status: 200,
    body: JSON.stringify({
      total_count: policyCount,
      policies: Array.from({ length: policyCount }, (_, index) => ({
        id: 6375 + index,
        name: `policy-${index + 1}`,
      })),
    }),
  };
}

function detailResponse(overrides: Record<string, unknown> = {}): ApiResponse {
  return {
    status: 200,
    body: JSON.stringify({
      id: 6375,
      name: "repo-event-policy",
      enforcement: "active",
      conditions: { workflow_path: { include: ["~ALL"], exclude: [] } },
      rules: [
        {
          type: "restrict_action_events",
          parameters: { allowed_events: events },
        },
      ],
      ...overrides,
    }),
  };
}

describe("Actions event policy classification", () => {
  it("fails visibly when the policy-list surface is absent", () => {
    const result = classify({ status: 404, body: "Not Found" }, []);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("2026-11-02");
  });

  it("fails when the policy list is empty", () => {
    const result = classify(listResponse(0), []);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/no .*polic/i);
  });

  it("fails visibly when a policy detail fetch fails", () => {
    const result = classify(listResponse(1), [{ status: 403, body: "Forbidden" }]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("403");
    expect(result.reason).toContain("6375");
    expect(result.reason).toContain("Administration read");
  });

  it("passes when an active ~ALL policy allows both required events", () => {
    const result = classify(listResponse(1), [detailResponse()]);

    expect(result.outcome).toBe("pass");
  });

  it("fails when a required event is missing and names it", () => {
    const result = classify(listResponse(1), [
      detailResponse({
        rules: [
          {
            type: "restrict_action_events",
            parameters: { allowed_events: ["pull_request_target"] },
          },
        ],
      }),
    ]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("workflow_run");
    expect(result.reason).toContain("repo-event-policy");
  });

  it("fails when enforcement is disabled", () => {
    const result = classify(listResponse(1), [detailResponse({ enforcement: "disabled" })]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("active");
  });

  it("rejects an unknown enforcement value even beside a qualifying policy", () => {
    const result = classify(listResponse(2), [
      detailResponse(),
      detailResponse({ id: 6376, enforcement: "evaluate" }),
    ]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("6376");
    expect(result.reason).toContain("evaluate");
  });

  it("rejects missing enforcement even beside a qualifying policy", () => {
    const result = classify(listResponse(2), [
      detailResponse(),
      detailResponse({ id: 6376, enforcement: undefined }),
    ]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("6376");
    expect(result.reason).toMatch(/malformed|missing|enforcement/i);
  });

  it("fails when an active policy does not target ~ALL", () => {
    const result = classify(listResponse(1), [
      detailResponse({
        conditions: {
          workflow_path: { include: [".github/workflows/ci.yml"], exclude: [] },
        },
      }),
    ]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("~ALL");
  });

  it("passes when an active policy's conditions omit workflow_path entirely", () => {
    const result = classify(listResponse(1), [
      detailResponse({ conditions: {} }),
    ]);

    expect(result.outcome).toBe("pass");
    expect(result.reason).toContain("6375");
  });

  it("fails when the detail body's id does not match the listed policy id", () => {
    const result = classify(listResponse(1), [detailResponse({ id: 999 })]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/does not match the list/);
    expect(result.reason).toContain("6375");
  });

  it("fails when a policy excludes any workflow despite ~ALL targeting", () => {
    const result = classify(
      listResponse(1),
      [
        detailResponse({
          conditions: {
            workflow_path: {
              include: ["~ALL"],
              exclude: [".github/workflows/untrusted.yml"],
            },
          },
        }),
      ],
    );

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("6375");
    expect(result.reason).toMatch(/exclud|full coverage/i);
  });

  it("fails closed when the policy-list JSON is malformed", () => {
    const result = classify({ status: 200, body: "not JSON" }, []);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/JSON|malformed/i);
  });

  it("fails closed when a policy detail body is malformed", () => {
    const result = classify(listResponse(1), [{ status: 200, body: "{" }]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toMatch(/JSON|malformed/i);
    expect(result.reason).toContain("6375");
  });

  it("fails closed when a malformed rule follows an otherwise qualifying rule", () => {
    const result = classify(listResponse(1), [detailResponse({ rules: [
      {
        type: "restrict_action_events",
        parameters: { allowed_events: events },
      },
      null,
    ] })]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("malformed restrict_action_events rule");
  });

  it.each([500])("fails visibly for policy-list HTTP %s", (status) => {
    const result = classify({ status, body: "" }, []);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain(String(status));
  });

  it("ends neutral on the list 403 that is the known permission gap", () => {
    const result = classify({ status: 403, body: "Forbidden" }, []);

    expect(result.outcome).toBe("neutral");
    expect(result.reason).toContain("1024");
    expect(result.reason).toContain("Administration read");
  });

  it("ends neutral on a list 403 whose body names the integration access gap", () => {
    const result = classify(
      { status: 403, body: "Resource not accessible by integration" },
      [],
    );

    expect(result.outcome).toBe("neutral");
  });

  it.each([
    ["the x-ratelimit-remaining header at 0", { "x-ratelimit-remaining": "0" }, ""],
    ["a retry-after header", { "retry-after": "60" }, ""],
    ["a secondary rate-limit body", undefined, "You have exceeded a secondary rate limit"],
    [
      "a primary rate-limit body",
      undefined,
      "You have exceeded a primary rate limit. Please wait for your rate limit to reset.",
    ],
  ])("fails on a list 403 naming a rate limit: %s", (_label, headers, body) => {
    const result = classify(
      {
        status: 403,
        body,
        headers: headers === undefined ? undefined : new Headers(headers),
      },
      [],
    );

    expect(result.outcome).toBe("fail");
  });

  it("does not read a rate limit into a non-zero x-ratelimit-remaining header", () => {
    const result = classify(
      {
        status: 403,
        body: "Forbidden",
        headers: new Headers({ "x-ratelimit-remaining": "59" }),
      },
      [],
    );

    expect(result.outcome).toBe("neutral");
  });

  it("keeps a policy-detail 403 a failure even when the response carries no rate-limit marker", () => {
    const result = classify(listResponse(1), [
      { status: 403, body: "Forbidden", headers: new Headers() },
    ]);

    expect(result.outcome).toBe("fail");
    expect(result.reason).toContain("6375");
  });
});

describe("Actions event policy runner", () => {
  it("fetches policy details and returns a passing exit result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport: PolicyTransport = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (new URL(url).pathname === POLICY_LIST_PATH) {
        return new Response(JSON.stringify({
          total_count: 1,
          policies: [{ id: 6375, name: "repo-event-policy" }],
        }), { status: 200 });
      }
      if (url === `${POLICY_LIST_URL}/6375`) {
        return new Response(JSON.stringify({
          id: 6375,
          name: "repo-event-policy",
          enforcement: "active",
          conditions: { workflow_path: { include: ["~ALL"], exclude: [] } },
          rules: [
            {
              type: "restrict_action_events",
              parameters: { allowed_events: events },
            },
          ],
        }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("policy 6375");
    expect(calls.map(({ url }) => url)).toEqual([
      policyListPageUrl(1),
      `${POLICY_LIST_URL}/6375`,
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer offline-token" });
  });

  it("does not qualify list-only policy summaries without a successful detail fetch", async () => {
    const calls: string[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = String(input);
      calls.push(url);
      if (new URL(url).pathname === POLICY_LIST_PATH) {
        return new Response(JSON.stringify({
          total_count: 1,
          policies: [{ id: 6375, name: "summary-has-no-rules" }],
        }), { status: 200 });
      }
      return new Response("Not Found", { status: 404 });
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("404");
    expect(result.message).toContain("6375");
    expect(calls).toEqual([policyListPageUrl(1), `${POLICY_LIST_URL}/6375`]);
  });

  it("fails visibly without a token without making a request", async () => {
    const calls: string[] = [];
    const transport: PolicyTransport = async (input) => {
      calls.push(String(input));
      return new Response("{}", { status: 200 });
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck(undefined, transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("GITHUB_TOKEN");
    expect(result.message).toContain("GH_TOKEN");
    expect(calls).toEqual([]);
  });

  it("ends neutral on the permission-gap 403, naming the issue and the missing permission", async () => {
    const transport: PolicyTransport = async () => new Response("Forbidden", { status: 403 });

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("github-token", transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("1024");
    expect(result.message).toContain("Administration read");
  });

  it("fails on a list 403 carrying a rate-limit header", async () => {
    const transport: PolicyTransport = async () =>
      new Response("Forbidden", { status: 403, headers: { "x-ratelimit-remaining": "0" } });

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("github-token", transport);

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/rate limit/i);
  });

  it("ends neutral without the page-failed prefix when a later list page hits the permission gap", async () => {
    const pages: number[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        const page = Number(url.searchParams.get("page") ?? "1");
        pages.push(page);
        if (page === 2) return new Response("Forbidden", { status: 403 });
        return new Response(JSON.stringify({
          total_count: 101,
          policies: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: `policy-${index + 1}`,
          })),
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("1024");
    expect(result.message).not.toContain("page 2 failed");
    expect(pages).toEqual([1, 2]);
  });

  it("fails with the page-failed prefix when a later list page is rate limited", async () => {
    const pages: number[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        const page = Number(url.searchParams.get("page") ?? "1");
        pages.push(page);
        if (page === 2) {
          return new Response("Forbidden", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0" },
          });
        }
        return new Response(JSON.stringify({
          total_count: 101,
          policies: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            name: `policy-${index + 1}`,
          })),
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("page 2 failed");
    expect(result.message).toMatch(/rate limit/i);
    expect(pages).toEqual([1, 2]);
  });

  it("fetches a 31st policy and fails when that policy is malformed", async () => {
    const summaries = Array.from({ length: 31 }, (_, index) => ({
      id: index + 1,
      name: `policy-${index + 1}`,
    }));
    const listRequests: URL[] = [];
    const fetchedDetails: number[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        listRequests.push(url);
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        const page = Number(url.searchParams.get("page") ?? "1");
        return new Response(JSON.stringify({
          total_count: summaries.length,
          policies: summaries.slice((page - 1) * perPage, page * perPage),
        }), { status: 200 });
      }
      const id = Number(url.pathname.split("/").at(-1));
      fetchedDetails.push(id);
      return id === 31 ? new Response("{", { status: 200 }) : activePolicyDetail(id);
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("policy 31");
    expect(result.message).toMatch(/malformed JSON/i);
    expect(fetchedDetails).toContain(31);
    expect(listRequests.map((url) => url.searchParams.get("per_page"))).toEqual(["100"]);
  });

  it("fails with fetched and total counts when pagination cannot reach total_count", async () => {
    const pages: number[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        const page = Number(url.searchParams.get("page") ?? "1");
        pages.push(page);
        return new Response(JSON.stringify({
          total_count: 2,
          policies: page === 1 ? [{ id: 1, name: "policy-1" }] : [],
        }), { status: 200 });
      }
      return activePolicyDetail(Number(url.pathname.split("/").at(-1)));
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("1");
    expect(result.message).toContain("2");
    expect(result.message).toMatch(/fetched|total_count|total/i);
    expect(result.message).toMatch(/distinct/i);
    expect(pages).toEqual([1, 2]);
  });

  it("fails closed when a policy ID is repeated across list pages", async () => {
    const pages: number[] = [];
    const fetchedDetails: number[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        const page = Number(url.searchParams.get("page") ?? "1");
        pages.push(page);
        return new Response(JSON.stringify({
          total_count: 2,
          policies: [{ id: 1, name: "policy-1" }],
        }), { status: 200 });
      }
      const id = Number(url.pathname.split("/").at(-1));
      fetchedDetails.push(id);
      return activePolicyDetail(id);
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/duplicate/i);
    expect(result.message).toContain("policy id 1");
    expect(pages).toEqual([1, 2]);
    expect(fetchedDetails).toEqual([]);
  });

  it("fails when a later policy-list page returns a non-200 response", async () => {
    const pages: number[] = [];
    const summaries = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: `policy-${index + 1}`,
    }));
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        const page = Number(url.searchParams.get("page") ?? "1");
        pages.push(page);
        if (page === 2) return new Response("rate limited", { status: 503 });
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        return new Response(JSON.stringify({
          total_count: summaries.length,
          policies: summaries.slice((page - 1) * perPage, page * perPage),
        }), { status: 200 });
      }
      return activePolicyDetail(Number(url.pathname.split("/").at(-1)));
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("503");
    expect(pages).toEqual([1, 2]);
  });

  it("passes when all policies across multiple pages qualify", async () => {
    const summaries = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      name: `policy-${index + 1}`,
    }));
    const pages: number[] = [];
    const details: number[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === POLICY_LIST_PATH) {
        const page = Number(url.searchParams.get("page") ?? "1");
        const perPage = Number(url.searchParams.get("per_page") ?? "30");
        pages.push(page);
        return new Response(JSON.stringify({
          total_count: summaries.length,
          policies: summaries.slice((page - 1) * perPage, page * perPage),
        }), { status: 200 });
      }
      const id = Number(url.pathname.split("/").at(-1));
      details.push(id);
      return activePolicyDetail(id);
    };

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("offline-token", transport);

    expect(result.exitCode).toBe(0);
    expect(pages).toEqual([1, 2]);
    expect(details).toHaveLength(101);
  });
});

describe("Actions event policy report rendering", () => {
  const mustRender = (): ReportRenderer => {
    if (renderReport === undefined) {
      expect(renderReport, "the report renderer must be exported").toBeTypeOf("function");
    }
    return renderReport as ReportRenderer;
  };

  it("renders a neutral outcome with the warning annotation and exit 0", () => {
    const rendered = mustRender()(
      { outcome: "neutral", exitCode: 0, message: "Cannot verify the event policy (issue 1024).\nSecond line." },
      [],
    );

    expect(rendered.exitCode).toBe(0);
    expect(rendered.out).toEqual([
      "Cannot verify the event policy (issue 1024).\nSecond line.",
    ]);
    expect(rendered.err).toEqual([
      "::warning::Cannot verify the event policy (issue 1024). Second line.",
    ]);
  });

  it("renders a failure with the error annotation and exit 1", () => {
    const rendered = mustRender()(
      { outcome: "fail", exitCode: 1, message: "Actions policy list request failed with HTTP 403." },
      [],
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.out).toEqual(["Actions policy list request failed with HTTP 403."]);
    expect(rendered.err).toEqual([
      "::error::Actions policy list request failed with HTTP 403.",
    ]);
  });

  it("keeps the missing-token failure an error annotation on both streams", () => {
    const rendered = mustRender()(
      {
        outcome: "fail",
        exitCode: 1,
        message: "Missing GITHUB_TOKEN and GH_TOKEN; cannot verify the Actions event policy.",
      },
      [],
    );

    expect(rendered.exitCode).toBe(1);
    expect(rendered.out).toEqual([
      "::error::Missing GITHUB_TOKEN and GH_TOKEN; cannot verify the Actions event policy.",
    ]);
    expect(rendered.err).toEqual([
      "::error::Missing GITHUB_TOKEN and GH_TOKEN; cannot verify the Actions event policy.",
    ]);
  });

  it("renders a pass with no annotation and exit 0", () => {
    const rendered = mustRender()(
      { outcome: "pass", exitCode: 0, message: 'policy 6375 ("p") is active, targets all workflows.' },
      [],
    );

    expect(rendered.exitCode).toBe(0);
    expect(rendered.out).toEqual(['policy 6375 ("p") is active, targets all workflows.']);
    expect(rendered.err).toEqual([]);
  });

  it("renders extra warnings as warning annotations after the outcome line", () => {
    const rendered = mustRender()(
      { outcome: "neutral", exitCode: 0, message: "gap message naming 1024" },
      ["the neutral check run could not be posted (HTTP 500)"],
    );

    expect(rendered.exitCode).toBe(0);
    expect(rendered.out).toEqual(["gap message naming 1024"]);
    expect(rendered.err).toEqual([
      "::warning::gap message naming 1024",
      "::warning::the neutral check run could not be posted (HTTP 500)",
    ]);
  });
});

describe("Actions event policy entry orchestration", () => {
  function mustRun(): ScriptRunner {
    if (runScript === undefined) {
      expect(runScript, "the entry orchestration must be exported").toBeTypeOf("function");
    }
    return runScript as ScriptRunner;
  }

  function generatedKeyPair(): { publicKey: string; privateKey: string } {
    return generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }) as unknown as { publicKey: string; privateKey: string };
  }

  function appEnv(appKey: string): Record<string, string | undefined> {
    return {
      LEDGER_APP_ID: "5118623",
      LEDGER_INSTALLATION_ID: "166057493",
      LEDGER_APP_KEY: appKey,
      GITHUB_SHA: "a".repeat(40),
    };
  }

  function mintCallOf(calls: Array<{ url: string; init?: RequestInit }>): {
    url: string;
    init?: RequestInit;
  } {
    const mintCall = calls.find(({ url }) => url.includes("/app/installations/"));
    if (mintCall === undefined) {
      throw new Error("no installation-token mint call was recorded");
    }
    return mintCall;
  }

  function checkRunCallOf(calls: Array<{ url: string; init?: RequestInit }>): {
    url: string;
    init?: RequestInit;
  } {
    const postCall = calls.find(({ url }) => url.endsWith("/check-runs"));
    if (postCall === undefined) {
      throw new Error("no check-run post was recorded");
    }
    return postCall;
  }

  function transportFor(
    calls: Array<{ url: string; init?: RequestInit }>,
    routes: {
      mint?: () => Response;
      list?: () => Response;
      checkRun?: () => Response;
      detail?: () => Response;
    },
  ): PolicyTransport {
    return async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/app/installations/")) {
        return routes.mint === undefined
          ? new Response(JSON.stringify({ token: "installation-token-1" }), { status: 201 })
          : routes.mint();
      }
      if (new URL(url).pathname === POLICY_LIST_PATH) {
        return routes.list === undefined
          ? new Response("Forbidden", { status: 403 })
          : routes.list();
      }
      if (url.endsWith("/check-runs")) {
        return routes.checkRun === undefined ? new Response("{}", { status: 201 }) : routes.checkRun();
      }
      return routes.detail === undefined
        ? new Response("{}", { status: 200 })
        : routes.detail();
    };
  }

  it("mints the App token first, runs the whole check with it, and posts the App-owned neutral check run", async () => {
    const { publicKey, privateKey } = generatedKeyPair();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()(appEnv(privateKey), transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(warnings).toEqual([]);

    const mintCall = mintCallOf(calls);
    expect(mintCall.url).toContain("/app/installations/166057493/access_tokens");
    expect(mintCall.init?.method).toBe("POST");
    expect(mintCall.init?.signal).toBeInstanceOf(AbortSignal);
    const jwt = String(
      new Headers(mintCall.init?.headers).get("authorization"),
    ).slice("Bearer ".length);
    const [jwtHeader, jwtPayload, jwtSignature] = jwt.split(".");
    const verified = createVerify("RSA-SHA256")
      .update(`${jwtHeader}.${jwtPayload}`)
      .verify(publicKey, Buffer.from(jwtSignature, "base64url"));
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(jwtHeader, "base64url").toString("utf8")))
      .toMatchObject({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(jwtPayload, "base64url").toString("utf8")))
      .toMatchObject({ iss: "5118623" });

    const listCall = calls.find(({ url }) => new URL(url).pathname === POLICY_LIST_PATH);
    expect(listCall).toBeDefined();
    expect(listCall?.init?.headers).toMatchObject({
      Authorization: "Bearer installation-token-1",
    });

    const postCall = checkRunCallOf(calls);
    expect(postCall.init?.headers).toMatchObject({
      Authorization: "Bearer installation-token-1",
    });
    expect(postCall.init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(postCall.init?.body)) as {
      name: string;
      head_sha: string;
      status: string;
      conclusion: string;
      output: { title: string; summary: string };
    };
    expect(body).toMatchObject({
      name: "event-policy",
      head_sha: "a".repeat(40),
      status: "completed",
      conclusion: "neutral",
      output: { title: "Cannot verify the Actions event policy" },
    });
    expect(body.output.summary).toContain("1024");
    expect(body.output.summary).toContain("Administration read");
  });

  it("runs the check under GH_TOKEN and posts nothing when the App credentials are absent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()({ GH_TOKEN: "gh-token" }, transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => url.includes("/app/installations/"))).toBe(false);
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
    const listCall = calls.find(({ url }) => new URL(url).pathname === POLICY_LIST_PATH);
    expect(listCall?.init?.headers).toMatchObject({ Authorization: "Bearer gh-token" });
  });

  it("fails closed when the mint fails (non-2xx), never throws, and runs no policies request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      mint: () => new Response("server error", { status: 500 }),
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()(
      { ...appEnv(generatedKeyPair().privateKey), GH_TOKEN: "gh-token" },
      transport,
    );

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/could not be minted/);
    expect(result.message).toContain("LEDGER_APP_KEY");
    expect(result.message).toMatch(/fails closed/i);
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => new URL(url).pathname === POLICY_LIST_PATH)).toBe(false);
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
  });

  it("fails closed when access_tokens answers 401 to a valid App key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      mint: () => new Response("nope", { status: 401 }),
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()(
      { ...appEnv(generatedKeyPair().privateKey), GH_TOKEN: "gh-token" },
      transport,
    );

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/could not be minted/);
    expect(result.message).toContain("LEDGER_APP_KEY");
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => new URL(url).pathname === POLICY_LIST_PATH)).toBe(false);
  });

  it("fails closed when the mint transport rejects, even with no GH_TOKEN to fall back to", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      mint: () => {
        throw new Error("connection reset");
      },
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()(appEnv(generatedKeyPair().privateKey), transport);

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/could not be minted/);
    expect(result.message).toContain("LEDGER_APP_KEY");
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => new URL(url).pathname === POLICY_LIST_PATH)).toBe(false);
  });

  it("fails closed on the issue repro shape: unparseable key, GH_TOKEN set, 401-mint 403-list transport", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      mint: () => new Response("nope", { status: 401 }),
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()(
      { ...appEnv("not a usable pem key"), GH_TOKEN: "gh-token" },
      transport,
    );

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/could not be minted/);
    expect(result.message).toContain("LEDGER_APP_KEY");
    expect(result.message).toMatch(/fails closed/i);
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => new URL(url).pathname === POLICY_LIST_PATH)).toBe(false);
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
  });

  it("names the Overflow Ledger App installation token in the neutral message when the App token drew the 403", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result } = await mustRun()(appEnv(generatedKeyPair().privateKey), transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("Overflow Ledger App installation token");
    expect(result.message).toContain("1024");
    expect(result.message).toContain("Administration read");
    expect(result.message).not.toContain("GITHUB_TOKEN");
  });

  it("names GITHUB_TOKEN in the neutral message when GH_TOKEN drew the 403 with no App credentials", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result } = await mustRun()({ GH_TOKEN: "gh-token" }, transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain("GITHUB_TOKEN");
    expect(result.message).toContain("1024");
    expect(result.message).toContain("Administration read");
  });

  it("renders the mint-failure result as an error annotation on both streams", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      mint: () => new Response("server error", { status: 500 }),
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result } = await mustRun()(
      { ...appEnv(generatedKeyPair().privateKey), GH_TOKEN: "gh-token" },
      transport,
    );
    if (renderReport === undefined) {
      expect(renderReport, "the report renderer must be exported").toBeTypeOf("function");
      return;
    }
    const rendered = renderReport(result, []);

    expect(rendered.exitCode).toBe(1);
    expect(rendered.out).toEqual([result.message]);
    expect(rendered.err).toEqual([`::error::${result.message.replace(/\s+/g, " ").trim()}`]);
  });

  it("never throws when the App key is unusable — it fails closed instead", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
    });

    const { result, warnings } = await mustRun()(
      { ...appEnv("not a usable pem key"), GH_TOKEN: "gh-token" },
      transport,
    );

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(result.message).toMatch(/could not be minted/);
    expect(result.message).toContain("LEDGER_APP_KEY");
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => new URL(url).pathname === POLICY_LIST_PATH)).toBe(false);
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
  });

  it("posts no check run when the outcome is failure, even with App credentials present", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () =>
        new Response("Forbidden", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0" },
        }),
    });

    const { result, warnings } = await mustRun()(
      appEnv(generatedKeyPair().privateKey),
      transport,
    );

    expect(result.outcome).toBe("fail");
    expect(result.exitCode).toBe(1);
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
  });

  it("posts no check run when the outcome is pass, even with App credentials present", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            policies: [{ id: 6375, name: "repo-event-policy" }],
          }),
          { status: 200 },
        ),
      detail: () => activePolicyDetail(6375),
    });

    const { result, warnings } = await mustRun()(
      appEnv(generatedKeyPair().privateKey),
      transport,
    );

    expect(result.outcome).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(warnings).toEqual([]);
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
  });

  it("warns and still ends neutral when the check-run post fails", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
      checkRun: () => new Response("nope", { status: 500 }),
    });

    const { result, warnings } = await mustRun()(
      appEnv(generatedKeyPair().privateKey),
      transport,
    );

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(warnings.join("\n")).toContain("could not be posted");
  });

  it("skips the post and says so when GITHUB_SHA is absent", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = transportFor(calls, {
      list: () => new Response("Forbidden", { status: 403 }),
    });
    const env = appEnv(generatedKeyPair().privateKey);
    delete env.GITHUB_SHA;

    const { result, warnings } = await mustRun()(env, transport);

    expect(result.outcome).toBe("neutral");
    expect(result.exitCode).toBe(0);
    expect(warnings.join("\n")).toContain("GITHUB_SHA");
    expect(calls.some(({ url }) => url.endsWith("/check-runs"))).toBe(false);
  });
});
