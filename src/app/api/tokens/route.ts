import type { UserRole } from "@/lib/db/types";
import { mintApiToken } from "@/lib/security/api-token";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";
import { PostgresApiTokenStore, type ApiTokenSummary } from "@/lib/tokens/postgres-store";
import { isRecentSignIn } from "@/lib/auth/recent-sign-in";
import { getCurrentUserRole } from "@/lib/moderation/current-role";

export { REAUTHENTICATION_WINDOW_MS, AUTHENTICATION_CLOCK_SKEW_MS } from "@/lib/auth/recent-sign-in";

/**
 * Mints the Overflow-issued API token an account uses to drive Overflow from a
 * script. The token authenticates as the account on every route that accepts
 * a bearer token, moderation and override decisions included for a moderator;
 * the session-only routes (this one, forge identities, repository labels)
 * refuse it. It carries a delivery window until its holder first presents it
 * and a lifetime from that request, and the 201 body says where it stands.
 *
 * The 201 body is the only place in the product where a plaintext token ever
 * appears: the store receives its hash, nothing logs it, and no error carries
 * it. The member sees it once, in the browser that asked for it.
 *
 * Authentication is the cookie session alone. A token cannot mint its
 * successor, so regeneration stays a human act in a browser and a leaked token
 * cannot roll itself forward and lock its owner out.
 *
 * The session must also carry a GitHub sign-in completed within the last
 * {@link REAUTHENTICATION_WINDOW_MS}. A session stays valid long after the
 * sign-in that issued it, and a client holding only the session cookie cannot
 * complete a GitHub OAuth round trip; the account's owner can, and the token
 * panel offers that sign-in beside this refusal, requesting no scope. So
 * minting a credential that outlives the session asks for that round trip.
 */

export type ApiTokenRouteSession = {
  /** `authenticatedAt`: the last GitHub sign-in, epoch seconds; null when the JWT records none. */
  user: { id: string; role: UserRole; authenticatedAt: number | null };
};

export type ApiTokenIssuer = {
  issueToken(userId: string, tokenHash: Buffer): Promise<ApiTokenSummary>;
};

export type ApiTokenRouteDependencies = {
  getSession: () => Promise<ApiTokenRouteSession | null>;
  /**
   * The account's role read live at request time. A session JWT outlives the
   * account it was issued for (issue 733), so minting re-reads the row rather
   * than trusting the session: a null here is a deleted (or missing) account.
   */
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createTokenStore: () => Promise<ApiTokenIssuer>;
  /** The current instant in epoch milliseconds; `Date.now` unless a test pins it. */
  now?: () => number;
};

export type ApiTokenPostHandler = (request: Request) => Promise<Response>;

export function createApiTokenPostHandler(
  dependencies: ApiTokenRouteDependencies,
): ApiTokenPostHandler {
  // The request reaches the origin guard and nothing else: no other line of
  // this handler reads a header, so the route still cannot authenticate a
  // bearer credential and an API token still cannot mint its successor.
  return async function postApiToken(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) {
      return untrusted;
    }

    let session: ApiTokenRouteSession | null;
    try {
      session = await dependencies.getSession();
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to issue an API token.");
    }
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }

    // The live-account gate runs before anything account-scoped happens — in
    // particular before the recent-sign-in check, so a deleted account reads
    // the FORBIDDEN refusal, not the reauthentication one.
    let role: UserRole | null;
    try {
      role = await dependencies.getCurrentRole(session.user.id);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to issue an API token.");
    }
    if (role === null) {
      return errorResponse(403, "FORBIDDEN", "A member account is required.");
    }

    if (!isRecentSignIn(session.user.authenticatedAt, (dependencies.now ?? Date.now)())) {
      return errorResponse(
        403,
        "REAUTHENTICATION_REQUIRED",
        "Confirm your GitHub sign-in to issue an API token.",
      );
    }

    const { token, tokenHash } = mintApiToken();
    let createdAt: Date;
    let expiresAt: Date;
    let confirmedAt: Date | null;
    try {
      const store = await dependencies.createTokenStore();
      ({ createdAt, expiresAt, confirmedAt } = await store.issueToken(session.user.id, tokenHash));
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to issue an API token.");
    }

    // `confirmedAt` travels with the plaintext because it is what tells the
    // holder the token's clock has not started yet: the ninety days are measured
    // from the first request that authenticates with this value, and a mint is
    // always unconfirmed at the instant it is handed over. A client that knows
    // that can say so, instead of reading the delivery window as a lifetime.
    return Response.json(
      {
        token,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        confirmedAt: confirmedAt?.toISOString() ?? null,
      },
      { status: 201 },
    );
  };
}

export const POST = createApiTokenPostHandler({
  getCurrentRole: getCurrentUserRole,
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown; authenticatedAt?: unknown } | undefined;
    if (
      typeof user?.id !== "string" ||
      (user.role !== "MEMBER" && user.role !== "MODERATOR")
    ) {
      return null;
    }
    const authenticatedAt =
      typeof user.authenticatedAt === "number" && Number.isFinite(user.authenticatedAt)
        ? user.authenticatedAt
        : null;
    return { user: { id: user.id, role: user.role, authenticatedAt } };
  },
  async createTokenStore() {
    return new PostgresApiTokenStore();
  },
});

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
