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
 * gate; a refusal from either surfaces as-is. JSON-RPC results and errors go
 * out in-band at HTTP 200, and a notification — no id, nothing to answer —
 * is HTTP 202 with no body.
 */
export function createMcpPostHandler(dependencies: McpRouteDependencies) {
  return async function postMcp(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
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
