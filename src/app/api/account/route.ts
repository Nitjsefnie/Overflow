import { deleteAccount, type AccountDeletionOutcome } from "@/lib/accounts/deletion";
import { findLiveAccountIdentity } from "@/lib/accounts/self-service";
import { isRecentSignIn } from "@/lib/auth/recent-sign-in";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

type Session = { user: { id: string; authenticatedAt: number | null } };
type Identity = NonNullable<Awaited<ReturnType<typeof findLiveAccountIdentity>>>;

export type AccountDeleteRouteDependencies = {
  getSession: () => Promise<Session | null>;
  getSql: () => SqlClient;
  findIdentity?: (sql: SqlClient, userId: string) => Promise<Identity | null>;
  deleteAccount?: (sql: SqlClient, githubUserId: number, options: { confirm: boolean }) => Promise<AccountDeletionOutcome>;
  endSession: () => Promise<unknown>;
  now?: () => number;
};

export function createAccountDeleteHandler(dependencies: AccountDeleteRouteDependencies) {
  return async function deleteOwnAccount(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) return untrusted;

    let session: Session | null;
    try {
      session = await dependencies.getSession();
    } catch {
      return upstreamFailure();
    }
    if (session === null) return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    if (!isRecentSignIn(session.user.authenticatedAt, (dependencies.now ?? Date.now)())) {
      return errorResponse(403, "REAUTHENTICATION_REQUIRED", "Confirm your GitHub sign-in to delete your account.");
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "A confirmation login is required.");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body) ||
        typeof (body as Record<string, unknown>).confirmLogin !== "string") {
      return errorResponse(400, "INVALID_REQUEST", "A confirmation login is required.");
    }
    const confirmLogin = (body as { confirmLogin: string }).confirmLogin;

    try {
      const sql = dependencies.getSql();
      const identity = await (dependencies.findIdentity ?? findLiveAccountIdentity)(sql, session.user.id);
      if (identity === null) return errorResponse(403, "FORBIDDEN", "Account deletion is unavailable.");
      if (confirmLogin.trim().toLowerCase() !== identity.githubLogin.trim().toLowerCase()) {
        return errorResponse(400, "CONFIRMATION_MISMATCH", "The confirmation login does not match your account.");
      }
      const outcome = await (dependencies.deleteAccount ?? deleteAccount)(sql, identity.githubUserId, { confirm: true });
      switch (outcome.kind) {
        case "SPONSOR_BLOCKED":
          return Response.json({ error: { code: "SPONSOR_BLOCKED", message: "Unregister your sponsored repositories before deleting your account.", repositories: outcome.repositories } }, { status: 409 });
        case "UNKNOWN_ACCOUNT":
          return errorResponse(403, "FORBIDDEN", "Account deletion is unavailable.");
        case "PLANNED":
          return upstreamFailure();
        case "DELETED":
          try {
            await dependencies.endSession();
            return Response.json({ deleted: true });
          } catch {
            console.error("Account deleted, but ending the browser session failed.");
            return Response.json({ deleted: true, sessionEnded: false });
          }
      }
    } catch {
      return upstreamFailure();
    }
  };
}

function upstreamFailure(): Response {
  return errorResponse(502, "UPSTREAM_FAILURE", "Unable to delete account.");
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export const DELETE = createAccountDeleteHandler({
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown; authenticatedAt?: unknown } | undefined;
    if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) return null;
    const authenticatedAt = typeof user.authenticatedAt === "number" && Number.isFinite(user.authenticatedAt)
      ? user.authenticatedAt : null;
    return { user: { id: user.id, authenticatedAt } };
  },
  getSql,
  async endSession() {
    const { signOut } = await import("@/auth");
    await signOut({ redirect: false });
  },
});
