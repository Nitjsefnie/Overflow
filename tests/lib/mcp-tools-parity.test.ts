import { describe, expect, it } from "vitest";
import { z } from "zod";
import { auditActionSchema } from "@/app/api/moderation/[id]/route";
import { openAccountAuditSchema } from "@/app/api/moderation/route";
import { decisionSchema } from "@/app/api/overrides/[id]/route";
import { overrideRequestSchema } from "@/app/api/overrides/route";
import {
  defineMcpTools,
  type McpToolDependencies,
  type WrappedRouteHandler,
} from "@/lib/mcp/tools";

function stubReturning(body: unknown): WrappedRouteHandler {
  return async () => Response.json(body);
}

function dependencies(): McpToolDependencies {
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
  };
}

function advertisedInputSchema(toolName: string): Record<string, unknown> {
  const tools = defineMcpTools(dependencies(), new Headers());
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) {
    throw new Error(`no tool named ${toolName}`);
  }
  return tool.inputSchema;
}

/**
 * The same strip tools.ts's publicJsonSchema applies: zod stamps its dialect
 * key on the rendered schema and the advertised contract carries none.
 */
function publicJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * The route schemas exclude the path id — the wrapped routes read it from the
 * URL segment — while the tool accepts it as an argument and moves it to the
 * path. Id first, so the rendered `required` order matches the restatement.
 */
function withPathId<Shape extends { [key: string]: z.ZodType }>(arm: { shape: Shape }) {
  return z.object({ id: z.string().uuid(), ...arm.shape }).strict();
}

/**
 * `.map` widens the route's non-empty arm tuple to a plain array; at runtime
 * it is still that tuple mirrored member for member, which is the shape
 * discriminatedUnion's parameter demands.
 */
type DiscriminableArms = Parameters<typeof z.discriminatedUnion>[1];

function withPathIdArms(
  arms: readonly { shape: { [key: string]: z.ZodType } }[],
): DiscriminableArms {
  // `.map` erases tuple-ness in the type system only; the runtime value is
  // the route's own non-empty arm tuple mirrored member for member.
  return arms.map(withPathId) as unknown as DiscriminableArms;
}

describe("MCP tool schema parity with the wrapped routes", () => {
  it("audit_open advertises the moderation route's open-audit schema", () => {
    expect(advertisedInputSchema("audit_open")).toEqual(publicJsonSchema(openAccountAuditSchema));
  });

  it("audit_decide advertises the audit-action schema with the path id merged in", () => {
    const expected = z.discriminatedUnion("action", withPathIdArms(auditActionSchema.options));
    expect(advertisedInputSchema("audit_decide")).toEqual(publicJsonSchema(expected));
  });

  it("correction_open advertises the overrides route's request schema", () => {
    expect(advertisedInputSchema("correction_open")).toEqual(
      publicJsonSchema(overrideRequestSchema),
    );
  });

  it("correction_decide advertises the decision schema with the path id merged in", () => {
    const expected = z.discriminatedUnion("action", withPathIdArms(decisionSchema.options));
    expect(advertisedInputSchema("correction_decide")).toEqual(publicJsonSchema(expected));
  });
});
