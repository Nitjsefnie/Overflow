import { afterAll, describe, expect, it, vi } from "vitest";
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
import { createModerationUnwritableClosuresGetHandler } from "@/app/api/moderation/unwritable-closures/route";
import { createSettlementOverrideListGetHandler } from "@/app/api/overrides/route";
import { defineMcpTools, type McpToolDependencies } from "@/lib/mcp/tools";
import {
  MCP_SERVER_VERSION,
  type ToolDefinition,
} from "@/lib/mcp/protocol";

// Bind the page/route graph to this file's mocks and release it afterward.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

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
  "unwritable_closures",
  "audit_open",
  "audit_decide",
  "correction_open",
  "correction_list",
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
    unwritableClosures: vi.fn(async () => Response.json({ ok: true })),
    auditOpen: vi.fn(async () => Response.json({ ok: true })),
    auditDecide: vi.fn(async () => Response.json({ ok: true })),
    correctionOpen: vi.fn(async () => Response.json({ ok: true })),
    correctionList: vi.fn(async () => Response.json({ ok: true })),
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
        // The value itself is guarded by tests/lib/api-version.test.ts;
        // this test pins the metadata shape around it.
        serverInfo: { name: "overflow", version: MCP_SERVER_VERSION },
      },
    });
  });

  it("answers tools/list with the twelve pinned tools and their schemas", async () => {
    const dependencies = endpointDependencies();

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(7, "tools/list")),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.tools).toHaveLength(12);
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      ...TOOL_NAMES,
    ]);
    for (const tool of body.result.tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeTypeOf("object");
    }
    for (const name of ["unwritable_closures", "correction_list"]) {
      const tool = body.result.tools.find((candidate: { name: string }) => candidate.name === name);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        properties: {},
        additionalProperties: false,
      });
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

  /** Drives one audit_open tool call and returns the request the route received. */
  async function synthesizedAuditOpen(headers: Record<string, string>): Promise<Request> {
    const auditOpen = vi.fn(async () => Response.json({ ok: true }));
    const dependencies = endpointDependencies({
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId, tokenId: memberId }),
      defineTools: vi.fn((incoming: Headers) => stubTools(incoming, { auditOpen })),
    });

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(4, "tools/call", { name: "audit_open", arguments: auditOpenArguments }), {
        authorization: `Bearer ${TOKEN}`,
        ...headers,
      }),
    );

    expect(response.status).toBe(200);
    expect(auditOpen).toHaveBeenCalledTimes(1);
    const [synthesized] = auditOpen.mock.calls[0] as unknown as [Request];
    return synthesized;
  }

  it("forwards the outer request's X-Real-IP to the wrapped route, so its journal names the real client", async () => {
    const synthesized = await synthesizedAuditOpen({ "x-real-ip": "203.0.113.7" });

    expect(synthesized.headers.get("x-real-ip")).toBe("203.0.113.7");
    expect(synthesized.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("never forwards X-Forwarded-For, nor invents an X-Real-IP from it", async () => {
    const synthesized = await synthesizedAuditOpen({ "x-forwarded-for": "203.0.113.7" });

    expect(synthesized.headers.get("x-forwarded-for")).toBeNull();
    expect(synthesized.headers.get("x-real-ip")).toBeNull();
  });

  it("forwards the outer request's proxy attestation beside the address it vouches for", async () => {
    const synthesized = await synthesizedAuditOpen({
      "x-real-ip": "203.0.113.7",
      "x-privileged-proxy-secret": "attestation-secret",
    });

    expect(synthesized.headers.get("x-privileged-proxy-secret")).toBe("attestation-secret");
    expect(synthesized.headers.get("x-real-ip")).toBe("203.0.113.7");
  });

  it("grows no proxy attestation header when the incoming request carried none", async () => {
    const synthesized = await synthesizedAuditOpen({ "x-real-ip": "203.0.113.7" });

    expect(synthesized.headers.get("x-privileged-proxy-secret")).toBeNull();
    expect([...synthesized.headers.keys()].sort()).toEqual([
      "authorization",
      "content-type",
      "x-real-ip",
    ]);
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
    // The challenge belongs to a 401 only; the 403 CSRF defense stays bare.
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });

  it("answers the misconfiguration refusal, not a discovery 401, when APP_URL is unset", async () => {
    // The fail-closed arm: with no parsable APP_URL the guard has already
    // refused with its own 500 before any discovery answer exists, and no
    // origin is available to advertise in WWW-Authenticate anyway.
    vi.stubEnv("APP_URL", "");
    const dependencies = endpointDependencies();
    const request = new Request(`${trustedOrigin}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc(1, "initialize"),
    });

    const response = await createMcpPostHandler(dependencies)(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(body).toEqual({
      error: {
        code: "MISCONFIGURED",
        message: "The server is not configured to accept this request.",
      },
    });
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });
});

describe("authentication discovery on the member gate's 401 answers", () => {
  it("carries the WWW-Authenticate challenge on the sign-in refusal for a cookie-less request", async () => {
    // The gate's "Sign in is required." 401 surfaces here as a bare Response.
    // RFC 7235 section 3.1 makes a challenge on a 401 a MUST, and this route
    // is where attaching it serves discovery — a client whose token was
    // rotated or revoked re-discovers the scheme from the challenge. A
    // browser-facing member route's sign-in redirect does that job instead.
    const dependencies = endpointDependencies({
      getSession: vi.fn().mockResolvedValue(null),
    });

    const response = await createMcpPostHandler(dependencies)(mcpRequest(rpc(1, "ping")));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${trustedOrigin}/.well-known/oauth-protected-resource"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    // The challenge is added to the gate's response, not swapped in: the
    // re-issued refusal keeps the headers the gate set, content-type included.
    expect(response.headers.get("content-type")?.startsWith("application/json")).toBe(true);
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });

  it("carries the same challenge on the bearer rejection for a token that authenticates no account", async () => {
    // The bearer path skips the origin guard by design, so an unknown token
    // reaches the gate's own rejection; the challenge rides it the same way.
    const dependencies = endpointDependencies();

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(1, "ping"), { authorization: `Bearer ${TOKEN}` }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." },
    });
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${trustedOrigin}/.well-known/oauth-protected-resource"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });

  it("leaves the bearer rejection challenge-less when no origin is available to advertise", async () => {
    // The fail-closed arm, mirroring the probe answer above: the bearer path
    // still reaches the gate's 401 with an unparsable APP_URL (the origin
    // guard is not consulted for a deliberately attached credential), but no
    // origin exists to advertise, so the 401 goes out unchanged.
    vi.stubEnv("APP_URL", "");
    const dependencies = endpointDependencies();

    const response = await createMcpPostHandler(dependencies)(
      mcpRequest(rpc(1, "ping"), { authorization: `Bearer ${TOKEN}` }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." },
    });
    expect(response.headers.get("www-authenticate")).toBeNull();
  });
});

describe("the challenge's 401-only boundary", () => {
  it("answers the gate's role refusal with 403 and no challenge", async () => {
    // A 403 is an authorization answer, not a scheme-discovery moment: the
    // account exists but holds no member role. The attach branch must leave
    // every non-401 refusal of the gate untouched.
    const dependencies = endpointDependencies({
      getCurrentRole: vi.fn().mockResolvedValue(null),
    });

    const response = await createMcpPostHandler(dependencies)(mcpRequest(rpc(1, "ping")));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });

  it("answers a session-reader outage with 502 and no challenge", async () => {
    // Same boundary on the outage arm: a 502 is not where a client learns the
    // accepted scheme, so the 502 goes out exactly as the gate built it.
    const dependencies = endpointDependencies({
      getSession: vi.fn().mockRejectedValue(new Error("database unavailable")),
    });

    const response = await createMcpPostHandler(dependencies)(mcpRequest(rpc(1, "ping")));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to authorize the member request." },
    });
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(dependencies.defineTools).not.toHaveBeenCalled();
  });
});

describe("transport-to-wrapped-route composition", () => {
  const unwritableQueues = {
    queue: [{
      id: "00000000-0000-4000-8000-000000000010",
      settlementId: "00000000-0000-4000-8000-000000000011",
      calibrationId: null,
      latestCorrection: null,
      viewerCanRequestCorrection: true,
    }],
    history: [],
  };
  const openCorrections = [{
    id: "00000000-0000-4000-8000-000000000012",
    settlementId: "00000000-0000-4000-8000-000000000011",
    state: "OPEN",
  }];

  function queueReadComposition(role: "MEMBER" | "MODERATOR"): McpRouteDependencies {
    const gate = {
      getSession: vi.fn().mockResolvedValue({ user: { id: memberId } }),
      findAccountByTokenHash: vi.fn().mockResolvedValue(null),
      getCurrentRole: vi.fn().mockResolvedValue(role),
    };
    return endpointDependencies({
      ...gate,
      defineTools: (headers: Headers) => defineMcpTools(backendDependencies({
        unwritableClosures: createModerationUnwritableClosuresGetHandler({
          ...gate,
          listUnwritableClosures: vi.fn().mockResolvedValue(unwritableQueues),
        }),
        correctionList: createSettlementOverrideListGetHandler({
          ...gate,
          listOpenRequests: vi.fn().mockResolvedValue(openCorrections),
        }),
      }), headers),
    });
  }

  it.each([
    ["unwritable_closures", unwritableQueues],
    ["correction_list", openCorrections],
  ])("returns the wrapped %s route's JSON as successful tool text", async (name, expected) => {
    const response = await createMcpPostHandler(queueReadComposition("MODERATOR"))(
      mcpRequest(rpc(20, "tools/call", { name, arguments: {} })),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }]);
    expect(body.result.isError).toBeUndefined();
  });

  it.each(["unwritable_closures", "correction_list"])(
    "returns the wrapped %s route's moderator refusal as an errored tool result",
    async (name) => {
      const response = await createMcpPostHandler(queueReadComposition("MEMBER"))(
        mcpRequest(rpc(21, "tools/call", { name, arguments: {} })),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 21,
        result: {
          content: [{ type: "text", text: JSON.stringify({
            error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
          }) }],
          isError: true,
        },
      });
    },
  );

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
    const bearerTokenId = "00000000-0000-4000-8000-00000000000b";
    const { endpoint, openAccountAudit } = auditOpenComposition({
      endpoint: {
        getSession: vi.fn().mockResolvedValue(null),
        findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId, tokenId: bearerTokenId }),
        getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
      },
      moderation: {
        findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId, tokenId: bearerTokenId }),
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
    // account through its own gate — resolving to the same token issuance — and
    // the write reaches the service in band, carrying the issuance reference.
    expect(response.status).toBe(200);
    expect(body.result.isError).toBeUndefined();
    expect(body.result.content).toEqual([
      { type: "text", text: JSON.stringify({ audit: openedAudit }) },
    ]);
    expect(openAccountAudit).toHaveBeenCalledExactlyOnceWith(
      { id: memberId, role: "MODERATOR" },
      auditOpenArguments,
      { kind: "token", tokenId: bearerTokenId },
    );
  });

  it("journals an MCP-originated write with the outer request's client address", async () => {
    const bearerTokenId = "00000000-0000-4000-8000-00000000000b";
    const gate = {
      getSession: vi.fn().mockResolvedValue(null),
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId, tokenId: bearerTokenId }),
      getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    };
    const { endpoint } = auditOpenComposition({ endpoint: gate, moderation: gate });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});

    try {
      await createMcpPostHandler(endpoint)(
        mcpRequest(rpc(10, "tools/call", { name: "audit_open", arguments: auditOpenArguments }), {
          authorization: `Bearer ${TOKEN}`,
          "x-real-ip": "2001:db8::17",
        }),
      );

      expect(consoleInfo).toHaveBeenCalledExactlyOnceWith("Privileged action", {
        action: "audit.open",
        actorId: memberId,
        credential: { kind: "token", tokenId: bearerTokenId },
        clientAddress: "2001:db8::17",
        clientAddressVerified: false,
        subject: { auditId: openedAudit.id, targetAccountId },
      });
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("marks the journal address verified when the outer MCP request carries the proxy attestation", async () => {
    const bearerTokenId = "00000000-0000-4000-8000-00000000000b";
    const gate = {
      getSession: vi.fn().mockResolvedValue(null),
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: memberId, tokenId: bearerTokenId }),
      getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
    };
    const { endpoint } = auditOpenComposition({ endpoint: gate, moderation: gate });
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const proxySecret = "mcp-proxy-secret-1044";
    vi.stubEnv("PRIVILEGED_PROXY_SECRET", proxySecret);

    try {
      await createMcpPostHandler(endpoint)(
        mcpRequest(rpc(11, "tools/call", { name: "audit_open", arguments: auditOpenArguments }), {
          authorization: `Bearer ${TOKEN}`,
          "x-real-ip": "2001:db8::17",
          "x-privileged-proxy-secret": proxySecret,
        }),
      );

      expect(consoleInfo).toHaveBeenCalledExactlyOnceWith("Privileged action", {
        action: "audit.open",
        actorId: memberId,
        credential: { kind: "token", tokenId: bearerTokenId },
        clientAddress: "2001:db8::17",
        clientAddressVerified: true,
        subject: { auditId: openedAudit.id, targetAccountId },
      });
    } finally {
      vi.unstubAllEnvs();
      consoleInfo.mockRestore();
    }
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
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${trustedOrigin}/.well-known/oauth-protected-resource"`,
    );
  });
});
