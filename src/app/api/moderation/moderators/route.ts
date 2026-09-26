import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { requiredModeratorSession } from "@/lib/moderation/route-auth";
import {
  AccountModerationService,
  ModerationServiceError,
  type ModeratorRoleChange,
  type ModeratorSummary,
} from "@/lib/moderation/service";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential, type RouteCredentialReference } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";

/**
 * The role-change body is one account id and a boolean, so 32 KiB bounds the
 * read with wide margin (issue 661).
 */
const MODERATOR_ROLE_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

const roleChangeSchema = z
  .object({
    targetAccountId: z.string().uuid(),
    moderator: z.boolean(),
  })
  .strict();

export type ModeratorRouteSession = {
  user: { id: string; role?: UserRole };
};

export type ModeratorRouteService = {
  listModerators(actor: { id: string; role: UserRole }): Promise<ModeratorSummary[]>;
  setModeratorRole(
    actor: { id: string; role: UserRole },
    targetAccountId: string,
    moderator: boolean,
    credential: RouteCredentialReference | null,
  ): Promise<ModeratorRoleChange>;
};

export type ModeratorRouteDependencies = {
  getSession: () => Promise<ModeratorRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<ModeratorRouteService>;
};

export function createModeratorGetHandler(dependencies: ModeratorRouteDependencies) {
  return async function getModerators(request: Request): Promise<Response> {
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const moderators = await (await dependencies.createService()).listModerators(session.user);
      return Response.json({ moderators });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

export function createModeratorPostHandler(dependencies: ModeratorRouteDependencies) {
  return async function postModerator(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    let rawBody: Buffer | null;
    try {
      rawBody = await readBodyWithinLimit(request, MODERATOR_ROLE_BODY_LIMIT_BYTES);
    } catch {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderator role request.");
    }
    if (rawBody === null) {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    let input: { targetAccountId: string; moderator: boolean };
    try {
      const parsed = roleChangeSchema.safeParse(JSON.parse(rawBody.toString("utf8")));
      if (!parsed.success) {
        return errorResponse(422, "INVALID_REQUEST", "Invalid moderator role request.");
      }
      input = parsed.data;
    } catch {
      return errorResponse(422, "INVALID_REQUEST", "Invalid moderator role request.");
    }

    try {
      const change = await (await dependencies.createService()).setModeratorRole(
        session.user,
        input.targetAccountId,
        input.moderator,
        session.credential,
      );
      logPrivilegedAction({
        action: input.moderator ? "moderator-role.grant" : "moderator-role.revoke",
        actorId: session.user.id,
        credential: session.credential,
        clientAddress: readClientAddress(request),
        subject: { targetAccountId: input.targetAccountId },
      });
      return Response.json({ change });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

function moderationErrorResponse(error: unknown): Response {
  if (!(error instanceof ModerationServiceError)) {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to complete the moderator request.");
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

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

async function getProductionSession(): Promise<ModeratorRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (typeof user?.id !== "string") {
    return null;
  }
  return { user: { id: user.id, role: user.role as UserRole | undefined } };
}

const productionDependencies: ModeratorRouteDependencies = {
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
};

export const GET = createModeratorGetHandler(productionDependencies);
export const POST = createModeratorPostHandler(productionDependencies);
