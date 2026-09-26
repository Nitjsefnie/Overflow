import type { UserRole } from "@/lib/db/types";
import { mintApiToken } from "@/lib/security/api-token";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";
import { PostgresApiTokenStore, type ApiTokenSummary } from "@/lib/tokens/postgres-store";

/**
 * Mints the Overflow-issued API token an account uses to drive Overflow from a
 * script. The token authenticates as the account: every action the owner's
 * role permits over the API, moderation and override decisions included for a
 * moderator. It expires a fixed lifetime after it is minted, and the 201 body
 * says when.
 *
 * The 201 body is the only place in the product where a plaintext token ever
 * appears: the store receives its hash, nothing logs it, and no error carries
 * it. The member sees it once, in the browser that asked for it.
 *
 * Authentication is the cookie session alone. A token cannot mint its
 * successor, so regeneration stays a human act in a browser and a leaked token
 * cannot roll itself forward and lock its owner out.
 */

export type ApiTokenRouteSession = {
  user: { id: string; role: UserRole };
};

export type ApiTokenIssuer = {
  issueToken(userId: string, tokenHash: Buffer): Promise<ApiTokenSummary>;
};

export type ApiTokenRouteDependencies = {
  getSession: () => Promise<ApiTokenRouteSession | null>;
  createTokenStore: () => Promise<ApiTokenIssuer>;
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

    const { token, tokenHash } = mintApiToken();
    let createdAt: Date;
    let expiresAt: Date;
    try {
      const store = await dependencies.createTokenStore();
      ({ createdAt, expiresAt } = await store.issueToken(session.user.id, tokenHash));
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to issue an API token.");
    }

    return Response.json(
      { token, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString() },
      { status: 201 },
    );
  };
}

export const POST = createApiTokenPostHandler({
  async getSession() {
    const { auth } = await import("@/auth");
    const session = await auth();
    const user = session?.user as { id?: unknown; role?: unknown } | undefined;
    if (
      typeof user?.id !== "string" ||
      (user.role !== "MEMBER" && user.role !== "MODERATOR")
    ) {
      return null;
    }
    return { user: { id: user.id, role: user.role } };
  },
  async createTokenStore() {
    return new PostgresApiTokenStore();
  },
});

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
