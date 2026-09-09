/**
 * The MCP tool registry: one tool per pinned route of the existing HTTP API.
 * Each tool is a thin adapter that synthesizes an internal Request for its
 * wrapped route handler and maps the Response back onto the MCP tool-result
 * envelope, so the routes stay the single authority for validation and
 * behavior and the MCP surface cannot drift from the HTTP one.
 */

import { z } from "zod";
import type { ToolCallResult, ToolDefinition } from "@/lib/mcp/protocol";

const MCP_REQUEST_ORIGIN = "http://mcp.internal";

/** The headers of the incoming MCP request a synthesized request carries. */
const CREDENTIAL_HEADER_NAMES = ["authorization", "cookie"] as const;

export type WrappedRouteContext = {
  params: Promise<Record<string, string>>;
};

export type WrappedRouteHandler = (
  request: Request,
  context?: WrappedRouteContext,
) => Promise<Response>;

/**
 * One wrapped handler per tool backend, keyed by what the tool drives. The
 * moderation queue's route arrives with Task 3; until then its key exists so
 * the registry's shape is final and Task 4 can wire the transport without
 * this module changing again.
 */
export interface McpToolDependencies {
  issuesBoard: WrappedRouteHandler;
  settlementsList: WrappedRouteHandler;
  settlementGet: WrappedRouteHandler;
  calibrationCompare: WrappedRouteHandler;
  dashboardSummary: WrappedRouteHandler;
  moderationQueue: WrappedRouteHandler;
  auditOpen: WrappedRouteHandler;
  auditDecide: WrappedRouteHandler;
  correctionOpen: WrappedRouteHandler;
  correctionDecide: WrappedRouteHandler;
}

// The argument shapes below mirror the wrapped routes' own zod schemas —
// overrides/route.ts, overrides/[id]/route.ts, moderation/route.ts and
// moderation/[id]/route.ts. They are restated, not imported, because the
// routes keep their schemas private; a change to a route schema must be
// copied here or the MCP client sees the wrong contract.
const issuesBoardSchema = z
  .object({
    repository: z.string().optional(),
    openingLabel: z.string().optional(),
    claimState: z.enum(["OPEN", "CLAIMED", "ALL"]).optional(),
  })
  .strict();

const noArgumentsSchema = z.object({}).strict();

const settlementGetSchema = z.object({ id: z.string().uuid() }).strict();

const auditOpenSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    repositoryId: z.string().uuid().optional(),
    sampleStartedAt: z.string(),
    sampleEndedAt: z.string(),
    reason: z.string(),
  })
  .strict();

const auditDecideSchema = z.discriminatedUnion("action", [
  z.object({ id: z.string().uuid(), action: z.literal("dismiss"), reason: z.string() }).strict(),
  z
    .object({ id: z.string().uuid(), action: z.literal("substantiate"), reason: z.string() })
    .strict(),
]);

const correctionOpenSchema = z.union([
  z.object({ settlementId: z.string().uuid(), reason: z.string().trim().min(1) }).strict(),
  z.object({ calibrationId: z.string().uuid(), reason: z.string().trim().min(1) }).strict(),
]);

const correctionDecideSchema = z.discriminatedUnion("action", [
  z
    .object({
      id: z.string().uuid(),
      action: z.literal("grant"),
      settledPoints: z.number().int().min(1).max(10),
      reason: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({ id: z.string().uuid(), action: z.literal("decline"), reason: z.string().trim().min(1) })
    .strict(),
]);

interface RouteToolSpec {
  name: string;
  description: string;
  schema: z.ZodType;
  method: "GET" | "POST" | "PATCH";
  handler: WrappedRouteHandler;
  pathFor: (args: Record<string, unknown>) => string;
  /**
   * The argument that names the wrapped route's path segment. It becomes the
   * params context and is kept out of the body, which the route would
   * otherwise refuse as a strict-schema violation.
   */
  idArg?: string;
}

/**
 * Builds the ten tools fresh for one incoming request: they close over that
 * request's credential headers, so nothing here outlives the call.
 */
export function defineMcpTools(
  dependencies: McpToolDependencies,
  credentialHeaders: Headers,
): ToolDefinition[] {
  const credentials = forwardedCredentials(credentialHeaders);

  return [
    defineRouteTool(
      {
        name: "issues_board",
        description:
          "List the eligible issues on the claim board, optionally filtered by repository, opening label or claim state.",
        schema: issuesBoardSchema,
        method: "GET",
        handler: dependencies.issuesBoard,
        pathFor: (args) => withQuery("/api/issues", args, ["repository", "openingLabel", "claimState"]),
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "settlements_list",
        description: "List the calling account's priced settlements.",
        schema: noArgumentsSchema,
        method: "GET",
        handler: dependencies.settlementsList,
        pathFor: () => "/api/settlements",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "settlement_get",
        description: "Fetch one settlement's proof by its id.",
        schema: settlementGetSchema,
        method: "GET",
        handler: dependencies.settlementGet,
        pathFor: (args) => `/api/settlements/${args.id}`,
        idArg: "id",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "calibration_compare",
        description: "Fetch the calibration comparison for the calling account.",
        schema: noArgumentsSchema,
        method: "GET",
        handler: dependencies.calibrationCompare,
        pathFor: () => "/api/calibration",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "dashboard_summary",
        description: "Fetch the calling account's dashboard summary.",
        schema: noArgumentsSchema,
        method: "GET",
        handler: dependencies.dashboardSummary,
        pathFor: () => "/api/dashboard",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "moderation_queue",
        description: "List the account audits currently open in the moderation queue.",
        schema: noArgumentsSchema,
        method: "GET",
        handler: dependencies.moderationQueue,
        pathFor: () => "/api/moderation/audits",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "audit_open",
        description: "Open an account audit over a calibration sample.",
        schema: auditOpenSchema,
        method: "POST",
        handler: dependencies.auditOpen,
        pathFor: () => "/api/moderation",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "audit_decide",
        description: "Dismiss or substantiate an open account audit.",
        schema: auditDecideSchema,
        method: "PATCH",
        handler: dependencies.auditDecide,
        pathFor: (args) => `/api/moderation/${args.id}`,
        idArg: "id",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "correction_open",
        description: "Request a correction to a priced settlement or calibration outcome.",
        schema: correctionOpenSchema,
        method: "POST",
        handler: dependencies.correctionOpen,
        pathFor: () => "/api/overrides",
      },
      credentials,
    ),
    defineRouteTool(
      {
        name: "correction_decide",
        description: "Grant or decline a settlement correction request.",
        schema: correctionDecideSchema,
        method: "PATCH",
        handler: dependencies.correctionDecide,
        pathFor: (args) => `/api/overrides/${args.id}`,
        idArg: "id",
      },
      credentials,
    ),
  ];
}

function defineRouteTool(spec: RouteToolSpec, credentials: Headers): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: publicJsonSchema(spec.schema),
    async call(args) {
      try {
        const writesBody = spec.method !== "GET";
        const request = new Request(`${MCP_REQUEST_ORIGIN}${spec.pathFor(args)}`, {
          method: spec.method,
          headers: writesBody ? withJsonContentType(credentials) : credentials,
          body: writesBody ? JSON.stringify(bodyFrom(spec, args)) : undefined,
        });
        const context = spec.idArg === undefined ? undefined : paramsContext(spec.idArg, args);
        const response = await spec.handler(request, context);
        const text = await response.text();
        const result: ToolCallResult = { content: [{ type: "text", text }] };
        if (response.status >= 400) {
          result.isError = true;
        }
        return result;
      } catch (error) {
        // A failed handler is a tool failure, not a transport one: it stays
        // in-band so the client can read the message.
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        };
      }
    },
  };
}

/**
 * Only the two credential headers cross the boundary, and only when the
 * incoming request actually carried them — never the rest of the MCP
 * transport's headers, which mean nothing to the wrapped routes.
 */
function forwardedCredentials(incoming: Headers): Headers {
  const forwarded = new Headers();
  for (const name of CREDENTIAL_HEADER_NAMES) {
    const value = incoming.get(name);
    if (value !== null) {
      forwarded.set(name, value);
    }
  }
  return forwarded;
}

/**
 * The media-type guard on the write routes accepts a JSON content type, and
 * the Request constructor would otherwise stamp a string body as text/plain.
 */
function withJsonContentType(credentials: Headers): Headers {
  const headers = new Headers(credentials);
  headers.set("content-type", "application/json");
  return headers;
}

function bodyFrom(spec: RouteToolSpec, args: Record<string, unknown>): Record<string, unknown> {
  if (spec.idArg === undefined) {
    return args;
  }
  const body = { ...args };
  delete body[spec.idArg];
  return body;
}

function paramsContext(
  idArg: string,
  args: Record<string, unknown>,
): WrappedRouteContext {
  return { params: Promise.resolve({ [idArg]: String(args[idArg]) }) };
}

/**
 * The issues route reads each filter only when the query names exactly one
 * value, so an argument the client omitted must produce no query key at all.
 */
function withQuery(
  path: string,
  args: Record<string, unknown>,
  argumentNames: readonly string[],
): string {
  const query = new URLSearchParams();
  for (const name of argumentNames) {
    const value = args[name];
    if (typeof value === "string") {
      query.set(name, value);
    }
  }
  const rendered = query.toString();
  return rendered === "" ? path : `${path}?${rendered}`;
}

/**
 * The advertised contract for tools/list. zod stamps its dialect key on the
 * rendered schema; a client expecting a bare JSON Schema object does not.
 */
function publicJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}
