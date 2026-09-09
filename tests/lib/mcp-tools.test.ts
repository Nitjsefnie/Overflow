import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/mcp/protocol";
import {
  defineMcpTools,
  type McpToolDependencies,
  type WrappedRouteHandler,
} from "@/lib/mcp/tools";

const REQUEST_ID = "12345678-1234-4234-8234-123456789abc";

const CANNED_TEXT = JSON.stringify({ ok: true });

type RouteContext = { params: Promise<Record<string, string>> };

function stubReturning(body: unknown, status = 200): WrappedRouteHandler {
  return vi.fn(async () => Response.json(body, { status }));
}

function throwingHandler(message: string): WrappedRouteHandler {
  return vi.fn(async () => {
    throw new Error(message);
  });
}

function dependencies(overrides: Partial<McpToolDependencies> = {}): McpToolDependencies {
  return {
    issuesBoard: stubReturning({ ok: true }),
    settlementsList: stubReturning({ ok: true }),
    settlementGet: stubReturning({ ok: true }),
    calibrationCompare: stubReturning({ ok: true }),
    dashboardSummary: stubReturning({ ok: true }),
    moderationQueue: stubReturning({ ok: true }),
    auditOpen: stubReturning({ ok: true }),
    auditDecide: stubReturning({ ok: true }),
    correctionOpen: stubReturning({ ok: true }),
    correctionDecide: stubReturning({ ok: true }),
    ...overrides,
  };
}

function toolNamed(tools: readonly ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`no tool named ${name}`);
  }
  return tool;
}

function mockCalls(mock: WrappedRouteHandler): unknown[][] {
  return (mock as unknown as { mock: { calls: unknown[][] } }).mock.calls;
}

function calledOnce(mock: WrappedRouteHandler): unknown[] {
  expect(mock).toHaveBeenCalledOnce();
  return mockCalls(mock)[0]! as unknown[];
}

describe("defineMcpTools", () => {
  it("defines exactly the ten pinned tools in routing-table order", () => {
    const tools = defineMcpTools(dependencies(), new Headers());
    expect(tools.map((tool) => tool.name)).toEqual([
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
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  describe("forwarding to the wrapped routes", () => {
    it("issues_board sends a filtered GET to /api/issues", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "issues_board").call({
        repository: "Nitjsefnie/Overflow",
        claimState: "OPEN",
      });

      const [request] = calledOnce(deps.issuesBoard) as [Request];
      expect(request.method).toBe("GET");
      const url = new URL(request.url);
      expect(`${url.origin}${url.pathname}`).toBe("http://mcp.internal/api/issues");
      expect(url.searchParams.get("repository")).toBe("Nitjsefnie/Overflow");
      expect(url.searchParams.get("claimState")).toBe("OPEN");
      expect(request.body).toBeNull();
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("settlements_list sends a plain GET to /api/settlements", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "settlements_list").call({});

      const [request] = calledOnce(deps.settlementsList) as [Request];
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://mcp.internal/api/settlements");
      expect(request.body).toBeNull();
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("settlement_get sends a GET to /api/settlements/<id> with the params context", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "settlement_get").call({ id: REQUEST_ID });

      const [request, context] = calledOnce(deps.settlementGet) as [Request, RouteContext];
      expect(request.method).toBe("GET");
      expect(request.url).toBe(`http://mcp.internal/api/settlements/${REQUEST_ID}`);
      expect(request.body).toBeNull();
      expect(await context.params).toEqual({ id: REQUEST_ID });
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("calibration_compare sends a plain GET to /api/calibration", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "calibration_compare").call({});

      const [request] = calledOnce(deps.calibrationCompare) as [Request];
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://mcp.internal/api/calibration");
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("dashboard_summary sends a plain GET to /api/dashboard", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "dashboard_summary").call({});

      const [request] = calledOnce(deps.dashboardSummary) as [Request];
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://mcp.internal/api/dashboard");
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("moderation_queue sends a plain GET to /api/moderation/audits", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "moderation_queue").call({});

      const [request] = calledOnce(deps.moderationQueue) as [Request];
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://mcp.internal/api/moderation/audits");
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("audit_open sends a POST to /api/moderation with the audit arguments as the JSON body", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const args = {
        targetAccountId: REQUEST_ID,
        repositoryId: REQUEST_ID,
        sampleStartedAt: "2026-09-01T00:00:00.000Z",
        sampleEndedAt: "2026-09-08T00:00:00.000Z",
        reason: "calibration drifted",
      };
      const result = await toolNamed(tools, "audit_open").call(args);

      const [request] = calledOnce(deps.auditOpen) as [Request];
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://mcp.internal/api/moderation");
      expect(await request.json()).toEqual(args);
      expect(request.headers.get("content-type")).toBe("application/json");
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("audit_decide sends a PATCH to /api/moderation/<id> with the action body and the params context", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "audit_decide").call({
        id: REQUEST_ID,
        action: "dismiss",
        reason: "no drift",
      });

      const [request, context] = calledOnce(deps.auditDecide) as [Request, RouteContext];
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe(`http://mcp.internal/api/moderation/${REQUEST_ID}`);
      expect(await request.json()).toEqual({ action: "dismiss", reason: "no drift" });
      expect(await context.params).toEqual({ id: REQUEST_ID });
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("correction_open sends a POST to /api/overrides with the correction arguments as the JSON body", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const args = { settlementId: REQUEST_ID, reason: "points drifted" };
      const result = await toolNamed(tools, "correction_open").call(args);

      const [request] = calledOnce(deps.correctionOpen) as [Request];
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://mcp.internal/api/overrides");
      expect(await request.json()).toEqual(args);
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });

    it("correction_decide sends a PATCH to /api/overrides/<id> with the decision body and the params context", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "correction_decide").call({
        id: REQUEST_ID,
        action: "grant",
        settledPoints: 7,
        reason: "under-priced",
      });

      const [request, context] = calledOnce(deps.correctionDecide) as [Request, RouteContext];
      expect(request.method).toBe("PATCH");
      expect(request.url).toBe(`http://mcp.internal/api/overrides/${REQUEST_ID}`);
      expect(await request.json()).toEqual({
        action: "grant",
        settledPoints: 7,
        reason: "under-priced",
      });
      expect(await context.params).toEqual({ id: REQUEST_ID });
      expect(result).toEqual({ content: [{ type: "text", text: CANNED_TEXT }] });
    });
  });

  describe("request synthesis", () => {
    it("builds the issues_board query from the defined arguments only", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());

      await toolNamed(tools, "issues_board").call({});
      const [noArgs] = calledOnce(deps.issuesBoard) as [Request];
      expect(noArgs.url).toBe("http://mcp.internal/api/issues");

      await toolNamed(tools, "issues_board").call({ openingLabel: "good first issue" });
      const [oneArg] = mockCalls(deps.issuesBoard)[1]! as [Request];
      expect([...new URL(oneArg.url).searchParams.keys()]).toEqual(["openingLabel"]);
    });

    it("forwards authorization and cookie verbatim when the incoming request carried them", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(
        deps,
        new Headers({ authorization: "Bearer token-1", cookie: "session=abc" }),
      );
      await toolNamed(tools, "settlements_list").call({});

      const [request] = calledOnce(deps.settlementsList) as [Request];
      expect([...request.headers.keys()].sort()).toEqual(["authorization", "cookie"]);
      expect(request.headers.get("authorization")).toBe("Bearer token-1");
      expect(request.headers.get("cookie")).toBe("session=abc");
    });

    it("leaves the forwarded headers off when the incoming request lacked them", async () => {
      const deps = dependencies();
      const tools = defineMcpTools(deps, new Headers());
      await toolNamed(tools, "settlements_list").call({});

      const [request] = calledOnce(deps.settlementsList) as [Request];
      expect([...request.headers.keys()]).toEqual([]);
    });
  });

  describe("result mapping", () => {
    it("maps a refused route response to isError with the envelope text", async () => {
      const envelope = {
        error: { code: "INVALID_REQUEST", message: "Invalid moderation request." },
      };
      // 400 pins the inclusive boundary; the others pin the envelope text on
      // the refusals the wrapped routes actually emit.
      for (const status of [400, 422, 500]) {
        const deps = dependencies({ moderationQueue: stubReturning(envelope, status) });
        const tools = defineMcpTools(deps, new Headers());
        const result = await toolNamed(tools, "moderation_queue").call({});

        expect(result).toEqual({
          content: [{ type: "text", text: JSON.stringify(envelope) }],
          isError: true,
        });
      }
    });

    it("maps a throwing handler to isError with the error message", async () => {
      const deps = dependencies({ correctionOpen: throwingHandler("upstream down") });
      const tools = defineMcpTools(deps, new Headers());
      const result = await toolNamed(tools, "correction_open").call({
        settlementId: REQUEST_ID,
        reason: "drift",
      });

      expect(result).toEqual({ content: [{ type: "text", text: "upstream down" }], isError: true });
    });
  });

  describe("input schemas", () => {
    function schemasByName(): Record<string, Record<string, unknown>> {
      return Object.fromEntries(
        defineMcpTools(dependencies(), new Headers()).map((tool) => [tool.name, tool.inputSchema]),
      );
    }

    function properties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
      return schema.properties as Record<string, Record<string, unknown>>;
    }

    function unionArms(schema: Record<string, unknown>): Record<string, unknown>[] {
      const arms = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[];
      expect(Array.isArray(arms), "union schema exposes anyOf/oneOf").toBe(true);
      return arms;
    }

    it("strips the $schema dialect key from every tool's input schema", () => {
      const schemas = schemasByName();
      for (const [name, schema] of Object.entries(schemas)) {
        expect(schema, name).not.toHaveProperty("$schema");
      }
    });

    it("keeps the exposed objects strict", () => {
      const schemas = schemasByName();
      for (const name of [
        "issues_board",
        "settlements_list",
        "settlement_get",
        "calibration_compare",
        "dashboard_summary",
        "moderation_queue",
        "audit_open",
      ]) {
        expect(schemas[name]!.additionalProperties, name).toBe(false);
      }
      for (const name of ["audit_decide", "correction_open", "correction_decide"]) {
        for (const arm of unionArms(schemas[name]!)) {
          expect(arm.additionalProperties, name).toBe(false);
        }
      }
    });

    it("mirrors the wrapped routes' argument shapes", () => {
      const schemas = schemasByName();

      expect(schemas.settlement_get!.required).toEqual(["id"]);
      expect(properties(schemas.settlement_get!).id!.format).toBe("uuid");

      expect(properties(schemas.issues_board!).claimState!.enum).toEqual([
        "OPEN",
        "CLAIMED",
        "ALL",
      ]);
      expect(schemas.issues_board!.required).toBeUndefined();

      expect(schemas.audit_open!.required).toEqual([
        "targetAccountId",
        "sampleStartedAt",
        "sampleEndedAt",
        "reason",
      ]);
      expect(properties(schemas.audit_open!).targetAccountId!.format).toBe("uuid");
      expect(properties(schemas.audit_open!).repositoryId!.format).toBe("uuid");

      const grantArm = unionArms(schemas.correction_decide!).find(
        (arm) => (properties(arm).action!.const as string) === "grant",
      );
      expect(grantArm).toBeDefined();
      expect(properties(grantArm!).settledPoints).toEqual({
        type: "integer",
        minimum: 1,
        maximum: 10,
      });

      const settlementArm = unionArms(schemas.correction_open!).find(
        (arm) => "settlementId" in (arm.properties as object),
      );
      expect(settlementArm).toBeDefined();
      expect(properties(settlementArm!).settlementId!.format).toBe("uuid");
    });
  });
});
