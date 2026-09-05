import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  settlementOverrideErrorResponse,
  type SettlementOverrideRouteSession,
} from "@/app/api/overrides/route";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import {
  SettlementOverrideService,
  type SettlementOverrideDecisionInput,
  type SettlementOverrideRequest,
} from "@/lib/overrides/service";

const decisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("grant"),
      settledPoints: z.number().int().min(1).max(10),
      reason: z.string().trim().min(1),
    })
    .strict(),
  z.object({ action: z.literal("decline"), reason: z.string().trim().min(1) }).strict(),
]);

export type SettlementOverrideDecisionContext = {
  params: Promise<{ id: string }>;
};

export type SettlementOverrideDecisionService = {
  decideRequest(
    moderator: { id: string; role: UserRole },
    requestId: string,
    decision: SettlementOverrideDecisionInput,
  ): Promise<SettlementOverrideRequest>;
};

export type SettlementOverrideDecisionDependencies = {
  getSession: () => Promise<SettlementOverrideRouteSession | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<SettlementOverrideDecisionService>;
};

export function createSettlementOverridePatchHandler(
  dependencies: SettlementOverrideDecisionDependencies,
) {
  return async function patchSettlementOverride(
    request: Request,
    context: SettlementOverrideDecisionContext,
  ): Promise<Response> {
    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    const requestId = await readRequestId(context);
    if (requestId === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid settlement correction decision.");
    }
    const decision = await parseDecision(request);
    if (decision === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid settlement correction decision.");
    }

    try {
      const service = await dependencies.createService();
      const decided = await service.decideRequest(session.user, requestId, decision);
      return Response.json({ request: decided });
    } catch (error) {
      return settlementOverrideErrorResponse(error);
    }
  };
}

// The role is re-read from the database rather than trusted from the session,
// because a session issued before a revocation still carries MODERATOR.
async function requiredModeratorSession(
  dependencies: SettlementOverrideDecisionDependencies,
): Promise<{ user: { id: string; role: "MODERATOR" } } | Response> {
  let session: SettlementOverrideRouteSession | null;
  try {
    session = await dependencies.getSession();
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the settlement correction decision.");
  }
  if (session === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let role: UserRole | null;
  try {
    role = await dependencies.getCurrentRole(session.user.id);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the settlement correction decision.");
  }
  if (role !== "MODERATOR") {
    return errorResponse(403, "FORBIDDEN", "Moderator authorization is required.");
  }

  return { user: { id: session.user.id, role: "MODERATOR" } };
}

async function readRequestId(context: SettlementOverrideDecisionContext): Promise<string | null> {
  try {
    const { id } = await context.params;
    return z.string().uuid().safeParse(id).success ? id : null;
  } catch {
    return null;
  }
}

async function parseDecision(request: Request): Promise<SettlementOverrideDecisionInput | null> {
  try {
    const parsed = decisionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return null;
    }
    return parsed.data.action === "grant"
      ? { decision: "GRANT", settledPoints: parsed.data.settledPoints, reason: parsed.data.reason }
      : { decision: "DECLINE", reason: parsed.data.reason };
  } catch {
    return null;
  }
}

export const PATCH = createSettlementOverridePatchHandler({
  getSession: getProductionSession,
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SettlementOverrideService(new PostgresSettlementOverrideStore());
  },
});
