import type { UserRole } from "@/lib/db/types";
import {
  resolveRouteCredential,
  type RouteCredentialSession,
} from "@/lib/security/route-credential";

/**
 * The session shape member-gated routes hand the gate: only the user id is
 * load-bearing, and any role on it is deliberately not trusted.
 */
export type MemberRouteSession = {
  user: { id: string; role?: UserRole };
};

/**
 * The authorization dependencies the member gate itself reads. A route with
 * its own dependencies type satisfies this structurally, without having to
 * describe its service as any one route's.
 */
export type MemberRouteDependencies = {
  getSession: () => Promise<MemberRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
};

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * The member credential gate a route runs before its own work: the resolved
 * credential's account must still exist, confirmed by reading its role back
 * from the database rather than trusting the credential. A session outlives
 * the account it was issued for, and a token's account row is only as fresh
 * as the moment it was read.
 */
export async function requiredMemberSession(
  request: Request,
  dependencies: MemberRouteDependencies,
): Promise<{ user: { id: string; role: UserRole } } | Response> {
  let credential: RouteCredentialSession | Response | null;
  try {
    credential = await resolveRouteCredential(request, dependencies);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the member request.");
  }
  if (credential instanceof Response) {
    return credential;
  }
  if (credential === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let role: UserRole | null;
  try {
    role = await dependencies.getCurrentRole(credential.user.id);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the member request.");
  }
  if (role === null) {
    return errorResponse(403, "FORBIDDEN", "A member account is required.");
  }

  return { user: { id: credential.user.id, role } };
}
