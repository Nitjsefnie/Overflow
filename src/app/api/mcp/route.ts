import { dispatchJsonRpc } from "@/lib/mcp/protocol";
import {
  defineMcpTools,
  type McpToolDependencies,
  type WrappedRouteHandler,
} from "@/lib/mcp/tools";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { AccountModerationService } from "@/lib/moderation/service";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import { SettlementOverrideService } from "@/lib/overrides/service";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteDependencies,
} from "@/lib/security/member-route-auth";
import { guardByCredential } from "@/lib/security/route-credential";
import { readTrustedOrigin } from "@/lib/security/request-origin";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { createModerationPostHandler } from "@/app/api/moderation/route";
import { createModerationAuditPatchHandler } from "@/app/api/moderation/[id]/route";
import { createModerationAuditsGetHandler } from "@/app/api/moderation/audits/route";
import { createIssuesGetHandler } from "@/app/api/issues/route";
import { createSettlementsGetHandler } from "@/app/api/settlements/route";
import { createSettlementProofGetHandler } from "@/app/api/settlements/[id]/route";
import { createCalibrationGetHandler } from "@/app/api/calibration/route";
import { createDashboardGetHandler } from "@/app/api/dashboard/route";
import { createSettlementOverridePostHandler } from "@/app/api/overrides/route";
import { createSettlementOverridePatchHandler } from "@/app/api/overrides/[id]/route";
import {
  listEligibleIssues,
  listSettlementHistory,
  getSettlementProof,
  getCalibrationComparison,
  getCalibrationComparisonByRepository,
  listSelfWorkCalibrations,
  getDashboard,
  listOpenAudits,
} from "@/lib/dashboard/queries";

/**
 * The registry hands a wrapped handler an optional generic params context;
 * the three path-segment routes require their own `{ id }` one. The registry
 * always supplies it for an id-taking tool, so the narrowing is by
 * construction and a missing context is a tool failure, not a silent read of
 * an undefined path.
 */
type PathIdContext = { params: Promise<{ id: string }> };

function withPathId(handler: (request: Request, context: PathIdContext) => Promise<Response>): WrappedRouteHandler {
  return async (request, context) => {
    if (context === undefined) {
      throw new Error("This tool requires a path parameter the registry did not supply.");
    }
    return handler(request, context as PathIdContext);
  };
}

/**
 * The discovery header pair every 401 this route answers with carries: the
 * challenge names the accepted scheme and points at this resource's RFC 9728
 * protected-resource metadata, and the answer is never cached.
 */
function discoveryHeaders(origin: string): Record<string, string> {
  return {
    "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    "Cache-Control": "no-store",
  };
}

/**
 * The ten wrapped route handlers, wired from the same factories and stores the
 * route files wire their own exports from. One deliberate exception the whole
 * record shares: every handler takes the member gate's production session
 * reader — the moderation-family ones included — because the session types are
 * structurally compatible and the gate's database role re-read stays the
 * single authorization authority.
 */
const productionToolDependencies: McpToolDependencies = {
  issuesBoard: createIssuesGetHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    listEligibleIssues,
  }),
  settlementsList: createSettlementsGetHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    listSettlementHistory,
  }),
  settlementGet: withPathId(createSettlementProofGetHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    getSettlementProof,
    async createCorrectionsService() {
      return new SettlementOverrideService(new PostgresSettlementOverrideStore());
    },
  })),
  calibrationCompare: createCalibrationGetHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    getCalibrationComparison,
    getCalibrationComparisonByRepository,
    listSelfWorkCalibrations,
  }),
  dashboardSummary: createDashboardGetHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    getDashboard,
  }),
  moderationQueue: createModerationAuditsGetHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    listOpenAudits,
  }),
  auditOpen: createModerationPostHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    async createService() {
      return new AccountModerationService(new PostgresModerationStore());
    },
  }),
  auditDecide: withPathId(createModerationAuditPatchHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    async createService() {
      return new AccountModerationService(new PostgresModerationStore());
    },
  })),
  correctionOpen: createSettlementOverridePostHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    async createService() {
      return new SettlementOverrideService(new PostgresSettlementOverrideStore());
    },
  }),
  correctionDecide: withPathId(createSettlementOverridePatchHandler({
    getSession: getProductionSession,
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    async createService() {
      return new SettlementOverrideService(new PostgresSettlementOverrideStore());
    },
  })),
};

export type McpRouteDependencies = MemberRouteDependencies & {
  /** Builds the ten tools against one incoming request's credential headers. */
  defineTools: (credentialHeaders: Headers) => ReturnType<typeof defineMcpTools>;
};

/**
 * The MCP transport: one JSON-RPC request per POST, gated exactly like the
 * routes it fronts. The credential guard runs first (a bearer request is
 * exempt from the origin check, a cookie request is not), then the member
 * gate. A refusal from either surfaces as-is, with two discovery exceptions
 * on this route: a request that carries neither a bearer credential nor a
 * session cookie nor an allowed Origin is a programmatic client's
 * unauthenticated probe, so its 403 is replaced by a 401 whose
 * WWW-Authenticate points at this resource's RFC 9728 metadata; and the
 * member gate's own 401 arms — the cookie-less "Sign in is required."
 * refusal and the bearer rejection "The supplied API token was not
 * accepted." — carry the same challenge where they surface here, so a client
 * whose token was rotated or revoked can re-discover the scheme (RFC 7235
 * section 3.1 makes the challenge on a 401 a MUST). An unparsable APP_URL
 * leaves any 401 unchanged — no origin to advertise, fail closed. JSON-RPC
 * results and errors go out in-band at HTTP 200, and a notification — no id,
 * nothing to answer — is HTTP 202 with no body.
 */
export function createMcpPostHandler(dependencies: McpRouteDependencies) {
  return async function postMcp(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      // On this route the guard's 403 is only ever the origin guard's, and a
      // request that reached it with no Cookie header carries no browser
      // session — the cookie case keeps the 403, which is the CSRF defense.
      // An unparsable APP_URL never reaches this branch at all: the origin
      // guard refuses it with its own 500 first. The null-check below is
      // belt-and-braces against a future widening of this gate, so a widened
      // refusal still stands rather than a discovery answer with no origin
      // to advertise.
      if (refusal.status === 403 && request.headers.get("cookie") === null) {
        const origin = readTrustedOrigin();
        if (origin !== null) {
          return Response.json(
            {
              error: {
                code: "UNAUTHENTICATED",
                message: "Provide a bearer API token.",
              },
            },
            { status: 401, headers: discoveryHeaders(origin) },
          );
        }
      }
      return refusal;
    }

    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      // Both of the gate's 401 arms surface here as bare responses, so this
      // return point is where the route attaches the same challenge the probe
      // answer carries. The other refusals pass through untouched: the 403 is
      // the CSRF or role defense and the 502 is an outage, and neither is a
      // scheme discovery moment. An unparsable APP_URL fails closed — no
      // origin to advertise, so the 401 goes out unchanged.
      if (session.status !== 401) {
        return session;
      }
      const origin = readTrustedOrigin();
      if (origin === null) {
        return session;
      }
      const headers = new Headers(session.headers);
      for (const [name, value] of Object.entries(discoveryHeaders(origin))) {
        headers.set(name, value);
      }
      return new Response(session.body, { status: session.status, headers });
    }

    let raw: string;
    try {
      raw = await request.text();
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "Unable to read the request body.");
    }

    const outcome = await dispatchJsonRpc(raw, dependencies.defineTools(request.headers));
    if (outcome === null || outcome.status === 202) {
      return new Response(null, { status: 202 });
    }
    return Response.json(outcome.body);
  };
}

export const POST = createMcpPostHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  defineTools: (headers) => defineMcpTools(productionToolDependencies, headers),
});
