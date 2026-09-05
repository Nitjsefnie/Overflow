import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import {
  SettlementOverrideError,
  SettlementOverrideService,
  type SettlementOverrideRequest,
  type SettlementOverrideTarget,
} from "@/lib/overrides/service";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

// Strict on both sides of the union, so a body naming a settlement and a
// calibration at once matches neither: one request corrects one priced outcome.
const overrideRequestSchema = z.union([
  z
    .object({
      settlementId: z.string().uuid(),
      reason: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      calibrationId: z.string().uuid(),
      reason: z.string().trim().min(1),
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
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<SettlementOverrideRequestService>;
};

export function createSettlementOverridePostHandler(dependencies: SettlementOverrideRouteDependencies) {
  return async function postSettlementOverride(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) {
      return untrusted;
    }

    const session = await requiredMemberSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseOverrideRequest(request);
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

/**
 * Confirms the signed-in account still exists, by reading it back from the
 * database rather than trusting the session. A session outlives the account it
 * was issued for; membership of a settlement is checked again in the store.
 */
export async function requiredMemberSession(
  dependencies: Pick<SettlementOverrideRouteDependencies, "getSession" | "getCurrentRole">,
): Promise<{ user: { id: string; role: UserRole } } | Response> {
  let session: SettlementOverrideRouteSession | null;
  try {
    session = await dependencies.getSession();
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the settlement correction request.");
  }
  if (session === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let role: UserRole | null;
  try {
    role = await dependencies.getCurrentRole(session.user.id);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the settlement correction request.");
  }
  if (role === null) {
    return errorResponse(403, "FORBIDDEN", "A member account is required.");
  }

  return { user: { id: session.user.id, role } };
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

export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function parseOverrideRequest(
  request: Request,
): Promise<{ target: SettlementOverrideTarget; reason: string } | null> {
  try {
    const parsed = overrideRequestSchema.safeParse(await request.json());
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

export async function getProductionSession(): Promise<SettlementOverrideRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (typeof user?.id !== "string") {
    return null;
  }
  return { user: { id: user.id, role: user.role as UserRole | undefined } };
}

export const POST = createSettlementOverridePostHandler({
  getSession: getProductionSession,
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new SettlementOverrideService(new PostgresSettlementOverrideStore());
  },
});
