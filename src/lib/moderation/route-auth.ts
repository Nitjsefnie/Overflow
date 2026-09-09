import type { UserRole } from "@/lib/db/types";
import {
  resolveRouteCredential,
  type RouteCredentialSession,
} from "@/lib/security/route-credential";

/**
 * The session shape the moderation routes hand the gate: only the user id is
 * load-bearing, and the role on it is deliberately not trusted.
 */
export type ModerationRouteSession = {
  user: { id: string; role?: UserRole };
};

export type AuthorizedModerationRouteSession = {
  user: { id: string; role: "MODERATOR" };
};

/**
 * What the moderator gate itself reads. A route with its own service type
 * satisfies this without having to describe its service as any one route's.
 */
export type ModerationSessionDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
};

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * The one moderator authorization gate behind every moderation route, and
 * behind the settlement-override decision route.
 *
 * The request's credential decides whose account is acting. A cookie session
 * and a bearer API token arrive by different paths and get different origin
 * treatment upstream of this gate (see guardByCredential), but once resolved
 * they authorize identically: the role is re-read from the database rather
 * than trusted — neither from the session nor from the token's account row —
 * because a session issued before a revocation still carries MODERATOR, and a
 * token's row is only as fresh as the moment it was read. A token therefore
 * fails exactly where its owner's session would fail.
 *
 * A backing-store failure while authorizing is the codebase's established
 * 502 UPSTREAM_FAILURE answer, not a 500: a 500 marks the whole request a
 * handler failure and erases the distinction between an authorization-dependency
 * outage and a moderation-handler bug. Session-lookup and role-lookup failures
 * keep separate catch blocks so neither can swallow the other's window.
 */
export async function requiredModeratorSession(
  request: Request,
  dependencies: ModerationSessionDependencies,
): Promise<AuthorizedModerationRouteSession | Response> {
  let credential: RouteCredentialSession | Response | null;
  try {
    credential = await resolveRouteCredential(request, dependencies);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the moderator request.");
  }
  if (credential instanceof Response) {
    return credential;
  }
  if (credential === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let currentRole: UserRole | null;
  try {
    currentRole = await dependencies.getCurrentRole(credential.user.id);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the moderator request.");
  }
  if (currentRole !== "MODERATOR") {
    return errorResponse(403, "FORBIDDEN", "Moderator authorization is required.");
  }

  return { user: { id: credential.user.id, role: currentRole } };
}
