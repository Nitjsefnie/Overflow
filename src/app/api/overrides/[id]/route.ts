import { z } from "zod";
import {
  settlementOverrideErrorResponse,
  type SettlementOverrideRouteSession,
} from "@/app/api/overrides/route";
import {
  errorResponse,
  getProductionSession,
} from "@/lib/security/member-route-auth";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import {
  SettlementOverrideService,
  type SettlementOverrideDecisionInput,
  type SettlementOverrideRequest,
} from "@/lib/overrides/service";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * The decision body carries one reason capped at 2000 characters by
 * reasonText(); 2000 three-byte UTF-8 characters is ~6 KB, so the limit is
 * 8 KiB rather than the 4 KiB the small single-field bodies get, and a
 * legitimate max-length reason is never refused as oversize (issue 661).
 */
const OVERRIDE_DECISION_BODY_LIMIT_BYTES = 8 * 1024; // 8 KiB

export const decisionSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("grant"),
      settledPoints: z.number().int().min(1).max(10),
      reason: reasonText(),
    })
    .strict(),
  z.object({ action: z.literal("decline"), reason: reasonText() }).strict(),
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
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
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
    if (decision === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (decision === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid settlement correction decision.");
    }

    try {
      const service = await dependencies.createService();
      const decided = await service.decideRequest(session.user, requestId, decision);
      logPrivilegedAction({
        action: decision.decision === "GRANT" ? "settlement-override.grant" : "settlement-override.decline",
        actorId: session.user.id,
        credential: session.credential,
        ...readClientAddress(request),
        subject: { overrideRequestId: requestId, issueId: decided.issueId },
      });
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

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseDecision(
  request: Request,
): Promise<SettlementOverrideDecisionInput | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, OVERRIDE_DECISION_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const parsed = decisionSchema.safeParse(JSON.parse(body.toString("utf8")));
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
