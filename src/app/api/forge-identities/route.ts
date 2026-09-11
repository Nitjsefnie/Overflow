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

export type ForgeIdentitiesRouteSession = {
  user: { id: string; role: UserRole };
};

export type ForgeIdentitiesRouteDependencies = {
  getSession: () => Promise<ForgeIdentitiesRouteSession | null>;
  createIdentityStore: () => ForgeIdentityStore;
  tokenEncryptionKey?: string;
  /** Injectable transport for the verification probe; production uses global fetch. */
  fetch?: typeof fetch;
  /** Claims past GitLab work for the freshly verified triple (fold store). */
  claimPastWork?: (input: { userId: string; instanceUrl: string; forgeUserId: number }) => Promise<void>;
};

const linkSchema = z
  .object({
    instanceUrl: z.string(),
    token: z.string().min(1),
  })
  .strict();

const unlinkSchema = z.object({ id: z.string() }).strict();

export function createForgeIdentitiesRouteDependencies(): ForgeIdentitiesRouteDependencies {
  return {
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
    const session = await dependencies.getSession();
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }
    const store = dependencies.createIdentityStore();
    const identities = await listForgeIdentities(store, session.user.id);
    return Response.json({ identities });
  };
}

export function createForgeIdentitiesPostHandler(dependencies: ForgeIdentitiesRouteDependencies) {
  return async function postForgeIdentity(request: Request): Promise<Response> {
    const session = await dependencies.getSession();
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }
    const input = await parseBody(request, linkSchema);
    if (input === null) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid forge identity link request.");
    }
    const tokenEncryptionKey = dependencies.tokenEncryptionKey;
    if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
      return errorResponse(503, "CONFIGURATION", "Token encryption is not configured.");
    }
    const store = dependencies.createIdentityStore();
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
    const session = await dependencies.getSession();
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }
    const input = await parseBody(request, unlinkSchema);
    if (input === null) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid forge identity unlink request.");
    }
    const store = dependencies.createIdentityStore();
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

async function parseBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | null> {
  try {
    const result = schema.safeParse(await request.json());
    return result.success ? (result.data as z.infer<T>) : null;
  } catch {
    return null;
  }
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
