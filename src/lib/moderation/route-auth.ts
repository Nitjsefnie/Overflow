import type { UserRole } from "@/lib/db/types";

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
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
};

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * The one moderator authorization gate behind every moderation route.
 *
 * The role is re-read from the database rather than trusted from the session,
 * because a session issued before a revocation still carries MODERATOR.
 *
 * A backing-store failure while authorizing is the codebase's established
 * 502 UPSTREAM_FAILURE answer, not a 500: a 500 marks the whole request a
 * handler failure and erases the distinction between an authorization-dependency
 * outage and a moderation-handler bug. Session-lookup and role-lookup failures
 * keep separate catch blocks so neither can swallow the other's window.
 */
export async function requiredModeratorSession(
  dependencies: ModerationSessionDependencies,
): Promise<AuthorizedModerationRouteSession | Response> {
  let session: ModerationRouteSession | null;
  try {
    session = await dependencies.getSession();
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the moderator request.");
  }
  if (session === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let currentRole: UserRole | null;
  try {
    currentRole = await dependencies.getCurrentRole(session.user.id);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the moderator request.");
  }
  if (currentRole !== "MODERATOR") {
    return errorResponse(403, "FORBIDDEN", "Moderator authorization is required.");
  }

  return { user: { id: session.user.id, role: currentRole } };
}
