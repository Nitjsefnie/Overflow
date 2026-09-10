import { describe, expect, it, vi } from "vitest";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";
import {
  createMcpPostHandler,
  POST as productionPost,
  type McpRouteDependencies,
} from "@/app/api/mcp/route";
import {
  createModerationPostHandler,
  type ModerationRouteDependencies,
} from "@/app/api/moderation/route";
import { defineMcpTools, type McpToolDependencies } from "@/lib/mcp/tools";
import type { ToolDefinition } from "@/lib/mcp/protocol";

// The production POST export reads the session through @/auth; the mock keeps
// its unauthenticated arm DB-free so the export itself can be driven.
vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

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

const targetAccountId = "00000000-0000-4000-8000-00000000000a";

const auditOpenArguments = {
  targetAccountId,
  sampleStartedAt: "2026-09-01T00:00:00.000Z",
  sampleEndedAt: "2026-09-09T00:00:00.000Z",
  reason: "A settle-to-claim pattern worth a moderator's review.",
};

// The minimal audit the service stub resolves to; the wrapped route wraps it
// in `{ audit }` verbatim, so the text assertion below pins the whole body.
const openedAudit = {
  id: "00000000-0000-4000-8000-00000000000b",
  targetAccountId,
  state: "OPEN",
};

/**
 * The full composition against one real wrapped route: the endpoint's
 * defineTools wires real defineMcpTools with auditOpen bound to a real
 * createModerationPostHandler, stubbing only the gate dependencies and the
 * moderation service. Everything else in the chain is production code.
 */
function auditOpenComposition(
  overrides: {
    endpoint?: Partial<McpRouteDependencies>;
    moderation?: Partial<ModerationRouteDependencies>;
  } = {},
): { endpoint: McpRouteDependencies; openAccountAudit: ReturnType<typeof vi.fn> } {
  const openAccountAudit = vi.fn().mockResolvedValue(openedAudit);
  const moderation: ModerationRouteDependencies = {
    getSession: vi.fn().mockResolvedValue(null),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    createService: vi.fn().mockResolvedValue({ openAccountAudit }),
    ...overrides.moderation,
  };
  const endpoint: McpRouteDependencies = {
    getSession: vi.fn().mockResolvedValue({ user: { id: memberId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue(null),
    getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
    defineTools: (headers: Headers) =>
      defineMcpTools(
        { ...backendDependencies(), auditOpen: createModerationPostHandler(moderation) },
        headers,
      ),
    ...overrides.endpoint,
  };
  return { endpoint, openAccountAudit };
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
    const [synthesized] = moderationQueue.mock.calls[0] as unknown as [Request];
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

describe("authentication discovery for a credential-less request", () => {
  it("answers a POST with no Origin header and no Cookie with 401 pointing at the protected-resource metadata", async () => {
    const dependencies = endpointDependencies();
    // A real MCP client sends no Origin header and no credential on its first
    // probe, which used to surface only the origin guard's bare 403. The
    // discovery answer replaces that 403, and nothing downstream may run.
    const request = new Request(`${trustedOrigin}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc(1, "initialize"),
    });

    const response = await createMcpPostHandler(dependencies)(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${trustedOrigin}/.well-known/oauth-protected-resource"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Provide a bearer API token." },
    });
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });

  it("keeps the origin guard's 403 for the same request when it carries a session cookie", async () => {
    const dependencies = endpointDependencies();
    // The cookie is what a browser attaches for its own session, so the origin
    // guard's 403 is the CSRF defense and the discovery answer must not replace it.
    const request = new Request(`${trustedOrigin}/api/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "authjs.session-token=x",
      },
      body: rpc(1, "initialize"),
    });

    const response = await createMcpPostHandler(dependencies)(request);
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });
});

describe("transport-to-wrapped-route composition", () => {
  it("surfaces the wrapped moderation route's origin refusal as a failed tool result for a cookie-authenticated write", async () => {
    const { endpoint } = auditOpenComposition();

    const response = await createMcpPostHandler(endpoint)(
      mcpRequest(rpc(8, "tools/call", { name: "audit_open", arguments: auditOpenArguments })),
    );
    const body = await response.json();

    // The MCP request itself is origin-trusted and cookie-authenticated, so it
    // passes the transport guard and the member gate; the wrapped route then
    // re-runs its own guard on the synthesized request, which carries no Origin
    // header from http://mcp.internal, and its origin refusal is what the
    // client reads as a failed tool result.
    expect(response.status).toBe(200);
    expect(body).toEqual({
      jsonrpc: "2.0",
      id: 8,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
            }),
          },
        ],
        isError: true,
      },
    });
  });

  it("carries the bearer credential through both gates to the wrapped moderation service", async () => {
    const { endpoint, openAccountAudit } = auditOpenComposition({
      endpoint: {
        getSession: vi.fn().mockResolvedValue(null),
        findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId }),
        getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
      },
      moderation: {
        findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId }),
        getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
      },
    });

    const response = await createMcpPostHandler(endpoint)(
      mcpRequest(rpc(9, "tools/call", { name: "audit_open", arguments: auditOpenArguments }), {
        authorization: `Bearer ${TOKEN}`,
      }),
    );
    const body = await response.json();

    // The bearer credential authenticates the MCP request and is forwarded on
    // the synthesized request, so the wrapped route authenticates the same
    // account through its own gate and the write reaches the service in band.
    expect(response.status).toBe(200);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toEqual([
      { type: "text", text: JSON.stringify({ audit: openedAudit }) },
    ]);
    expect(openAccountAudit).toHaveBeenCalledExactlyOnceWith(
      { id: memberId, role: "MODERATOR" },
      auditOpenArguments,
    );
  });
});

describe("the route module's surface", () => {
  it("exports no GET handler, leaving Next to answer other methods with 405", async () => {
    const route: Record<string, unknown> = await import("@/app/api/mcp/route");
    expect(route.GET).toBeUndefined();
    expect(route.POST).toBeTypeOf("function");
  });

  it("answers an unauthenticated POST with the 401 envelope through the module's own export", async () => {
    // getProductionSession resolves no session here (@/auth is mocked), so the
    // gate refuses before any store is constructed; the export itself is what
    // the kill pins.
    const response = await productionPost(mcpRequest(rpc(1, "ping")));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });
});
