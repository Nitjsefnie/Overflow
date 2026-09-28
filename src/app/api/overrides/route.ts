import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import {
  SettlementOverrideError,
  SettlementOverrideService,
  type OpenSettlementOverrideRequest,
  type SettlementOverrideRequest,
  type SettlementOverrideModerator,
  type SettlementOverrideTarget,
} from "@/lib/overrides/service";
import { guardByCredential } from "@/lib/security/route-credential";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { reasonText } from "@/lib/validation/reason";

/**
 * The correction body is one target id plus a reason reasonText() caps at
 * 2000 characters, so 32 KiB bounds the read with wide margin (issue 661).
 */
const OVERRIDES_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

// Strict on both sides of the union, so a body naming a settlement and a
// calibration at once matches neither: one request corrects one priced outcome.
export const overrideRequestSchema = z.union([
  z
    .object({
      settlementId: z.string().uuid(),
      reason: reasonText(),
    })
    .strict(),
  z
    .object({
      calibrationId: z.string().uuid(),
      reason: reasonText(),
    })
    .strict(),
]);

export type SettlementOverrideRouteSession = {
  user: { id: string; role?: UserRole };
};

export type SettlementOverrideRequestService = {
  requestOverride(
    requester: { id: string },
    input: { target: SettlementOverrideTarget; reason: string },
  ): Promise<SettlementOverrideRequest>;
};

export type SettlementOverrideRouteDependencies = {
  getSession: () => Promise<SettlementOverrideRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<SettlementOverrideRequestService>;
};

export type SettlementOverrideListRouteDependencies = {
  getSession: () => Promise<SettlementOverrideRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  listOpenRequests: (moderator: SettlementOverrideModerator) => Promise<OpenSettlementOverrideRequest[]>;
};

export function createSettlementOverrideListGetHandler(
  dependencies: SettlementOverrideListRouteDependencies,
) {
  return async function getSettlementOverrideList(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the cohort preview:
    // rejectUntrustedRequest rejects a missing Origin header, but a
    // programmatic GET sends none at all, so applying it here would reject
    // every script client. The gate still resolves a bearer credential from
    // the headers.
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      return Response.json(await dependencies.listOpenRequests(session.user));
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the open correction requests.");
    }
  };
}

export function createSettlementOverridePostHandler(dependencies: SettlementOverrideRouteDependencies) {
  return async function postSettlementOverride(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseOverrideRequest(request);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid settlement correction request.");
    }

    try {
      const service = await dependencies.createService();
      const recorded = await service.requestOverride({ id: session.user.id }, input);
      return Response.json({ request: recorded });
    } catch (error) {
      return settlementOverrideErrorResponse(error);
    }
  };
}

export function settlementOverrideErrorResponse(error: unknown): Response {
  if (!(error instanceof SettlementOverrideError)) {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to complete the settlement correction request.");
  }
  switch (error.code) {
    case "FORBIDDEN":
      return errorResponse(403, error.code, error.message);
    case "NOT_FOUND":
      return errorResponse(404, error.code, error.message);
    case "CONFLICT":
      return errorResponse(409, error.code, error.message);
    default:
      return errorResponse(422, error.code, error.message);
  }
}

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseOverrideRequest(
  request: Request,
): Promise<{ target: SettlementOverrideTarget; reason: string } | "tooLarge" | null> {
  try {
    const raw = await readBodyWithinLimit(request, OVERRIDES_BODY_LIMIT_BYTES);
    if (raw === null) {
      return "tooLarge";
    }
    const parsed = overrideRequestSchema.safeParse(JSON.parse(raw.toString("utf8")));
    if (!parsed.success) {
      return null;
    }
    const body = parsed.data;
    const target: SettlementOverrideTarget =
      "settlementId" in body
        ? { kind: "settlement", settlementId: body.settlementId }
        : { kind: "calibration", calibrationId: body.calibrationId };
    return { target, reason: body.reason };
  } catch {
    return null;
  }
}

export const POST = createSettlementOverridePostHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SettlementOverrideService(new PostgresSettlementOverrideStore());
  },
});

export const GET = createSettlementOverrideListGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  listOpenRequests: (moderator) =>
    new SettlementOverrideService(new PostgresSettlementOverrideStore()).listOpenRequests(moderator),
});
