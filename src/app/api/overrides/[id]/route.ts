import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  settlementOverrideErrorResponse,
  type SettlementOverrideRouteSession,
} from "@/app/api/overrides/route";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import {
  SettlementOverrideService,
  type SettlementOverrideDecisionInput,
  type SettlementOverrideRequest,
} from "@/lib/overrides/service";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

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
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string } | null>;
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
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
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
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SettlementOverrideService(new PostgresSettlementOverrideStore());
  },
});
