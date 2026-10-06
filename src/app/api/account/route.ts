import { deleteAccount, type AccountDeletionOutcome } from "@/lib/accounts/deletion";
import { findLiveAccountIdentity } from "@/lib/accounts/self-service";
import { isRecentSignIn } from "@/lib/auth/recent-sign-in";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

/**
 * The DELETE body is one JSON object carrying a single short confirmation
 * login, so 4 KiB bounds the read with room to spare (issue 661).
 */
const ACCOUNT_DELETE_BODY_LIMIT_BYTES = 4 * 1024; // 4 KiB

/**
 * The one operator journal line a deletion writes when it leaves the instance
 * without a live moderator. Fixed text on purpose: it names the gap and the
 * operator's recovery path, and carries no personal data — no login, no
 * account id, no GitHub user id, nothing about who deleted (issue 1122).
 */
const NO_LIVE_MODERATOR_JOURNAL =
  "Account deletion left no live moderator. Recovery: add a GitHub user id to MODERATOR_GITHUB_USER_IDS; the list promotes its holder at their next sign-in.";

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
    } catch (error) {
      console.error("Account delete session failed.", error);
      return upstreamFailure();
    }
    if (session === null) return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    if (!isRecentSignIn(session.user.authenticatedAt, (dependencies.now ?? Date.now)())) {
      return errorResponse(403, "REAUTHENTICATION_REQUIRED", "Confirm your GitHub sign-in to delete your account.");
    }

    let rawBody: Buffer | null;
    try {
      rawBody = await readBodyWithinLimit(request, ACCOUNT_DELETE_BODY_LIMIT_BYTES);
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "A confirmation login is required.");
    }
    if (rawBody === null) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return errorResponse(400, "INVALID_REQUEST", "A confirmation login is required.");
    }
    if (body === null || typeof body !== "object" || Array.isArray(body) ||
        typeof (body as Record<string, unknown>).confirmLogin !== "string") {
      return errorResponse(400, "INVALID_REQUEST", "A confirmation login is required.");
    }
    const confirmLogin = (body as { confirmLogin: string }).confirmLogin;

    let sql: SqlClient;
    let identity: Identity | null;
    try {
      sql = dependencies.getSql();
      identity = await (dependencies.findIdentity ?? findLiveAccountIdentity)(sql, session.user.id);
    } catch (error) {
      console.error("Account delete lookup failed.", error);
      return upstreamFailure();
    }
    if (identity === null) return errorResponse(403, "FORBIDDEN", "A member account is required.");
    if (confirmLogin.trim().toLowerCase() !== identity.githubLogin.trim().toLowerCase()) {
      return errorResponse(400, "CONFIRMATION_MISMATCH", "The confirmation login does not match your account.");
    }

    let outcome: AccountDeletionOutcome;
    try {
      outcome = await (dependencies.deleteAccount ?? deleteAccount)(sql, identity.githubUserId, { confirm: true });
    } catch (error) {
      console.error("Account delete operation failed.", error);
      return upstreamFailure();
    }
    switch (outcome.kind) {
      case "SPONSOR_BLOCKED":
        return Response.json({ error: { code: "SPONSOR_BLOCKED", message: "Unregister your sponsored repositories before deleting your account.", repositories: outcome.repositories } }, { status: 409 });
      case "UNKNOWN_ACCOUNT":
        return errorResponse(403, "FORBIDDEN", "A member account is required.");
      case "PLANNED":
        console.error("Account delete outcome failed.", new Error("Unexpected planned account deletion outcome."));
        return upstreamFailure();
      case "DELETED":
        // The deletion succeeded; the journal line records the coverage gap it
        // left behind. It never blocks or fails the deletion.
        if (outcome.leftNoLiveModerator) {
          console.warn(NO_LIVE_MODERATOR_JOURNAL);
        }
        try {
          await dependencies.endSession();
          return Response.json({ deleted: true });
        } catch (error) {
          console.error("Account deleted, but ending the browser session failed.", error);
          return Response.json({ deleted: true, sessionEnded: false });
        }
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
