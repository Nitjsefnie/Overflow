import { describe, expect, it, vi } from "vitest";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";
import {
  createMcpPostHandler,
  type McpRouteDependencies,
} from "@/app/api/mcp/route";
import { defineMcpTools, type McpToolDependencies } from "@/lib/mcp/tools";
import type { ToolDefinition } from "@/lib/mcp/protocol";

const memberId = "00000000-0000-4000-8000-000000000004";

useTrustedOrigin();

// Matches the api-token pattern, so the bearer path passes hashApiToken.
const TOKEN = `ovf_${"A".repeat(43)}`;

const TOOL_NAMES = [
  "issues_board",
  "settlements_list",
  "settlement_get",
  "calibration_compare",
  "dashboard_summary",
  "moderation_queue",
  "audit_open",
  "audit_decide",
  "correction_open",
  "correction_decide",
] as const;

function rpc(id: number, method: string, params?: object): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

function backendDependencies(overrides: Partial<McpToolDependencies> = {}): McpToolDependencies {
  return {
    issuesBoard: vi.fn(async () => Response.json({ ok: true })),
    settlementsList: vi.fn(async () => Response.json({ ok: true })),
    settlementGet: vi.fn(async () => Response.json({ ok: true })),
    calibrationCompare: vi.fn(async () => Response.json({ ok: true })),
    dashboardSummary: vi.fn(async () => Response.json({ ok: true })),
    moderationQueue: vi.fn(async () => Response.json({ ok: true })),
    auditOpen: vi.fn(async () => Response.json({ ok: true })),
    auditDecide: vi.fn(async () => Response.json({ ok: true })),
    correctionOpen: vi.fn(async () => Response.json({ ok: true })),
    correctionDecide: vi.fn(async () => Response.json({ ok: true })),
    ...overrides,
  };
}

function stubTools(headers: Headers, overrides: Partial<McpToolDependencies> = {}): ToolDefinition[] {
  return defineMcpTools(backendDependencies(overrides), headers);
}

function endpointDependencies(
  overrides: Partial<McpRouteDependencies> = {},
): McpRouteDependencies {
  return {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    defineTools: vi.fn((headers: Headers) => stubTools(headers)),
    ...overrides,
  };
}

function mcpRequest(raw: string, headers: Record<string, string> = {}): Request {
  return new Request(`${trustedOrigin}/api/mcp`, {
    method: "POST",
    headers: { origin: trustedOrigin, "content-type": "application/json", ...headers },
    body: raw,
  });
}

describe("POST /api/mcp", () => {
  it("surfaces the member gate's 401 refusal as HTTP before any JSON-RPC work", async () => {
    const dependencies = endpointDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createMcpPostHandler(dependencies)(mcpRequest(rpc(1, "ping")));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });

  it("refuses a batch body with the -32600 error in-band at HTTP 200", async () => {
    const dependencies = endpointDependencies();
    const batch = JSON.stringify([rpc(1, "ping"), rpc(2, "ping")]);

    const response = await createMcpPostHandler(dependencies)(mcpRequest(batch));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Batch requests are not supported." },
    });
  });

  it("answers initialize with the pinned protocol version and server info", async () => {
    const dependencies = endpointDependencies();

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(1, "initialize")),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "overflow", version: "0.1.0" },
      },
    });
  });

  it("answers tools/list with the ten pinned tools and their schemas", async () => {
    const dependencies = endpointDependencies();

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(7, "tools/list")),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(10);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...TOOL_NAMES,
    ]);
    for (const tool of body.result.tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeTypeOf("object");
    }
  });

  it("answers tools/call by forwarding the arguments through the real registry to a stubbed backend", async () => {
    const envelope = {
      error: { code: "UPSTREAM_FAILURE", message: "Unable to load the moderation queue." },
    };
    const moderationQueue = vi.fn(async () => Response.json(envelope, { status: 502 }));
    const dependencies = endpointDependencies({
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId }),
      defineTools: vi.fn((headers: Headers) =>
        stubTools(headers, { moderationQueue }),
      ),
    });

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(3, "tools/call", { name: "moderation_queue", arguments: {} }), {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    const body = await response.json();

    // The bearer credential authenticated the request and reached the wrapped
    // route, whose 502 refusal surfaces in-band as a failed tool result.
    expect(response.status).toBe(200);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: JSON.stringify(envelope) }],
        isError: true,
      },
    });
    const [synthesized] = moderationQueue.mock.calls[0] as unknown[] as [Request][];
    expect(synthesized.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("answers a notification with 202 and an empty body", async () => {
    const dependencies = endpointDependencies();
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });

    const response = await createMcpPostHandler(dependencies)(mcpRequest(notification));

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
  });

  it("answers an unreadable request body with the 400 envelope", async () => {
    const dependencies = endpointDependencies();
    const request = new Request(`${trustedOrigin}/api/mcp`, {
      method: "POST",
      headers: { origin: trustedOrigin, "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      duplex: "half",
    } as RequestInit);

    const response = await createMcpPostHandler(dependencies)(request);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Unable to read the request body." },
    });
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });
});

describe("the route module's surface", () => {
  it("exports no GET handler, leaving Next to answer other methods with 405", async () => {
    const route = await import("@/app/api/mcp/route");
    expect(route.GET).toBeUndefined();
    expect(route.POST).toBeTypeOf("function");
  });
});
