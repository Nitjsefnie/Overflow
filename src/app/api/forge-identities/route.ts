import { z } from "zod";
import { getSql } from "@/lib/db/client";
import {
  ForgeIdentityError,
  linkForgeIdentity,
  listForgeIdentities,
  unlinkForgeIdentity,
} from "@/lib/forge/identities";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import type { ForgeIdentityStore } from "@/lib/forge/identities";
import type { UserRole } from "@/lib/db/types";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import {
  applyRouteRateGate,
  createRouteRateGate,
  EXPENSIVE_ROUTE_RATE_CLASSES,
  resolveRouteRateLimit,
  type RouteRateGate,
} from "@/lib/security/route-rate-limit";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { createRateLimiter } from "@/lib/webhooks/rate-limit";

/**
 * The link and unlink bodies carry one instance URL and token, or one identity
 * id, so 4 KiB bounds the read with room to spare (issue 661).
 */
const FORGE_IDENTITIES_BODY_LIMIT_BYTES = 4 * 1024; // 4 KiB

export type ForgeIdentitiesRouteSession = {
  user: { id: string; role: UserRole };
};

export type ForgeIdentitiesRouteDependencies = {
  getSession: () => Promise<ForgeIdentitiesRouteSession | null>;
  /**
   * The account's role read live at request time. A session JWT outlives the
   * account it was issued for (issue 733), so the write verbs re-read the row
   * rather than trusting the session: a null here is a deleted (or missing)
   * account.
   */
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createIdentityStore: () => ForgeIdentityStore;
  tokenEncryptionKey?: string;
  /** Injectable transport for the verification probe; production refuses non-public instances. */
  fetch?: typeof fetch;
  /** Claims past GitLab work for the freshly verified triple (fold store). */
  claimPastWork?: (input: { userId: string; instanceUrl: string; forgeUserId: number }) => Promise<void>;
  /**
   * The keyed expensive-route bound (issue 1054), checked by the write verbs
   * after every authorization refusal and before the body is read. GET — a
   * read of the caller's own rows — is not one of the expensive classes and
   * stays unbounded. The production wiring passes this file's module-scope
   * gate; a handler built without one — a test factory call — stays unbounded.
   */
  rateGate?: RouteRateGate;
};

// One keyed limiter per route file, born at the wall clock: its buckets are
// keyed by the acting credential identity and never evict (issue 1054).
const forgeIdentitiesRateLimiter = createRateLimiter({ nowMs: () => Date.now() });
const forgeIdentitiesRateGate = createRouteRateGate({
  className: "forge-identities",
  limiter: forgeIdentitiesRateLimiter,
  limits: resolveRouteRateLimit(process.env, EXPENSIVE_ROUTE_RATE_CLASSES.forgeIdentities),
});

const linkSchema = z
  .object({
    instanceUrl: z.string(),
    token: z.string().min(1),
  })
  .strict();

const unlinkSchema = z.object({ id: z.string().uuid() }).strict();

export function createForgeIdentitiesRouteDependencies(): ForgeIdentitiesRouteDependencies {
  return {
    getCurrentRole: getCurrentUserRole,
    rateGate: forgeIdentitiesRateGate,
    async getSession() {
      const { auth } = await import("@/auth");
      const session = await auth();
      const user = session?.user as { id?: unknown; role?: unknown } | undefined;
      if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) {
        return null;
      }
      return { user: { id: user.id, role: user.role } };
    },
    createIdentityStore: () => new PostgresForgeIdentityStore(getSql()),
    claimPastWork: async (input) => {
      const { claimForgeIdentity } = await import("@/lib/fold/postgres-store");
      await claimForgeIdentity(getSql(), {
        userId: input.userId,
        instanceUrl: input.instanceUrl,
        forgeUserId: input.forgeUserId,
      });
    },
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
  };
}

/**
 * The forge-identity API: list, link, unlink. Session-only — these routes move
 * the caller's own credentials, so a bearer token must never operate them on
 * another account's behalf. Responses never carry the encrypted token.
 */
export function createForgeIdentitiesGetHandler(dependencies: ForgeIdentitiesRouteDependencies) {
  return async function getForgeIdentities(): Promise<Response> {
    try {
      const session = await dependencies.getSession();
      if (session === null) {
        return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
      }
      const store = dependencies.createIdentityStore();
      const identities = await listForgeIdentities(store, session.user.id);
      return Response.json({ identities });
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
    }
  };
}

export function createForgeIdentitiesPostHandler(dependencies: ForgeIdentitiesRouteDependencies) {
  return async function postForgeIdentity(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) {
      return untrusted;
    }

    let session: ForgeIdentitiesRouteSession | null;
    try {
      session = await dependencies.getSession();
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
    }
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }
    const liveAccountRefusal = await refuseDeletedAccount(dependencies, session.user.id);
    if (liveAccountRefusal !== null) {
      return liveAccountRefusal;
    }
    const rateRefusal = applyRouteRateGate(dependencies.rateGate, { kind: "session" }, session.user.id);
    if (rateRefusal !== null) return rateRefusal;
    const input = await parseBody(request, linkSchema);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid forge identity link request.");
    }
    const tokenEncryptionKey = dependencies.tokenEncryptionKey;
    if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
      return errorResponse(503, "CONFIGURATION", "Token encryption is not configured.");
    }
    let store: ForgeIdentityStore;
    try {
      store = dependencies.createIdentityStore();
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
    }
    try {
      const identity = await linkForgeIdentity(
        { store, tokenEncryptionKey, fetch: dependencies.fetch, claimPastWork: dependencies.claimPastWork },
        { userId: session.user.id, instanceUrl: input.instanceUrl, token: input.token },
      );
      return Response.json({ identity }, { status: 201 });
    } catch (error) {
      return identityErrorResponse(error);
    }
  };
}

export function createForgeIdentitiesDeleteHandler(dependencies: ForgeIdentitiesRouteDependencies) {
  return async function deleteForgeIdentity(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) {
      return untrusted;
    }

    let session: ForgeIdentitiesRouteSession | null;
    try {
      session = await dependencies.getSession();
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
    }
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }
    const liveAccountRefusal = await refuseDeletedAccount(dependencies, session.user.id);
    if (liveAccountRefusal !== null) {
      return liveAccountRefusal;
    }
    const rateRefusal = applyRouteRateGate(dependencies.rateGate, { kind: "session" }, session.user.id);
    if (rateRefusal !== null) return rateRefusal;
    const input = await parseBody(request, unlinkSchema);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid forge identity unlink request.");
    }
    let store: ForgeIdentityStore;
    try {
      store = dependencies.createIdentityStore();
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
    }
    try {
      const deleted = await unlinkForgeIdentity(store, {
        userId: session.user.id,
        identityId: input.id,
      });
      if (!deleted) {
        return errorResponse(404, "NOT_FOUND", "No such forge identity is linked to this account.");
      }
      return Response.json({ deleted: true }, { status: 200 });
    } catch (error) {
      return identityErrorResponse(error);
    }
  };
}

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, FORGE_IDENTITIES_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = schema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? (result.data as z.infer<T>) : null;
  } catch {
    return null;
  }
}

/**
 * The live-account gate the write verbs run after the session check (issue
 * 733): the session JWT outlives the account it was issued for, so the route
 * re-reads the account's role the member gate reads before acting on the
 * session's account id. A null role is a deleted (or missing) account and
 * answers the member gate's 403 envelope; a lookup failure answers the same
 * 502 this route's own failures answer, with a fixed message naming no
 * request data. GET stays ungated — it reads the caller's own, already
 * scrubbed rows.
 */
async function refuseDeletedAccount(
  dependencies: ForgeIdentitiesRouteDependencies,
  userId: string,
): Promise<Response | null> {
  let role: UserRole | null;
  try {
    role = await dependencies.getCurrentRole(userId);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
  }
  return role === null
    ? errorResponse(403, "FORBIDDEN", "A member account is required.")
    : null;
}

function identityErrorResponse(error: unknown): Response {
  if (error instanceof ForgeIdentityError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return errorResponse(400, error.code, error.message);
      case "UNVERIFIED":
        return errorResponse(401, error.code, error.message);
      case "NOT_FOUND":
        return errorResponse(404, error.code, error.message);
      case "FORBIDDEN":
        return errorResponse(403, error.code, error.message);
      case "UPSTREAM_FAILURE":
        return errorResponse(502, error.code, error.message);
    }
  }
  return errorResponse(502, "UPSTREAM_FAILURE", "The forge identity operation could not complete.");
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export const GET = createForgeIdentitiesGetHandler(createForgeIdentitiesRouteDependencies());
export const POST = createForgeIdentitiesPostHandler(createForgeIdentitiesRouteDependencies());
export const DELETE = createForgeIdentitiesDeleteHandler(createForgeIdentitiesRouteDependencies());
