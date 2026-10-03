import { describe, expect, it } from "vitest";
import * as actionsEventPolicy from "../../scripts/check-actions-event-policy.ts";
import { classify } from "../../scripts/check-actions-event-policy.ts";

type ApiResponse = { status: number; body: string; error?: string };
type PolicyTransport = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "status" | "text">>;
type RunnerResult = { exitCode: number; message: string };
type Runner = (token: string | undefined, transport?: PolicyTransport) => Promise<RunnerResult>;

const runCheck = (actionsEventPolicy as typeof actionsEventPolicy & { runCheck?: Runner })
  .runCheck;
const POLICY_LIST_URL =
  "https://api.github.com/repos/Nitjsefnie/Overflow/actions/policies";

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

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("2026-11-02");
  });

  it("fails when the policy list is empty", () => {
    const result = classify(listResponse(0), []);

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/no .*polic/i);
  });

  it("fails visibly when a policy detail fetch fails", () => {
    const result = classify(listResponse(1), [{ status: 403, body: "Forbidden" }]);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("403");
    expect(result.reason).toContain("6375");
    expect(result.reason).toContain("Administration read");
  });

  it("passes when an active ~ALL policy allows both required events", () => {
    const result = classify(listResponse(1), [detailResponse()]);

    expect(result.pass).toBe(true);
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

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("workflow_run");
    expect(result.reason).toContain("repo-event-policy");
  });

  it("fails when enforcement is disabled", () => {
    const result = classify(listResponse(1), [detailResponse({ enforcement: "disabled" })]);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("active");
  });

  it("rejects an unknown enforcement value even beside a qualifying policy", () => {
    const result = classify(listResponse(2), [
      detailResponse(),
      detailResponse({ id: 6376, enforcement: "evaluate" }),
    ]);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("6376");
    expect(result.reason).toContain("evaluate");
  });

  it("rejects missing enforcement even beside a qualifying policy", () => {
    const result = classify(listResponse(2), [
      detailResponse(),
      detailResponse({ id: 6376, enforcement: undefined }),
    ]);

    expect(result.pass).toBe(false);
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

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("~ALL");
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

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("6375");
    expect(result.reason).toMatch(/exclud|full coverage/i);
  });

  it("fails closed when the policy-list JSON is malformed", () => {
    const result = classify({ status: 200, body: "not JSON" }, []);

    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/JSON|malformed/i);
  });

  it("fails closed when a policy detail body is malformed", () => {
    const result = classify(listResponse(1), [{ status: 200, body: "{" }]);

    expect(result.pass).toBe(false);
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

    expect(result.pass).toBe(false);
    expect(result.reason).toContain("malformed restrict_action_events rule");
  });

  it.each([403, 500])("fails visibly for policy-list HTTP %s", (status) => {
    const result = classify({ status, body: "" }, []);

    expect(result.pass).toBe(false);
    expect(result.reason).toContain(String(status));
  });
});

describe("Actions event policy runner", () => {
  it("fetches policy details and returns a passing exit result", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport: PolicyTransport = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === POLICY_LIST_URL) {
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
      POLICY_LIST_URL,
      `${POLICY_LIST_URL}/6375`,
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: "Bearer offline-token" });
  });

  it("does not qualify list-only policy summaries without a successful detail fetch", async () => {
    const calls: string[] = [];
    const transport: PolicyTransport = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === POLICY_LIST_URL) {
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
    expect(calls).toEqual([POLICY_LIST_URL, `${POLICY_LIST_URL}/6375`]);
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

  it("explains the Administration read-token requirement on HTTP 403", async () => {
    const transport: PolicyTransport = async () => new Response("Forbidden", { status: 403 });

    if (runCheck === undefined) {
      expect(runCheck, "the injectable runner must be exported").toBeTypeOf("function");
      return;
    }
    const result = await runCheck("github-token", transport);

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("GITHUB_TOKEN");
    expect(result.message).toContain("Administration read");
    expect(result.message).toContain("maintainer-wired secret");
  });
});
