import { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import {
  AccountModerationService,
  ModerationServiceError,
  type ModeratorRoleChange,
  type ModeratorSummary,
} from "@/lib/moderation/service";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

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
  ): Promise<ModeratorRoleChange>;
};

export type ModeratorRouteDependencies = {
  getSession: () => Promise<ModeratorRouteSession | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<ModeratorRouteService>;
};

export function createModeratorGetHandler(dependencies: ModeratorRouteDependencies) {
  return async function getModerators(): Promise<Response> {
    const session = await requiredModeratorSession(dependencies);
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
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) {
      return untrusted;
    }

    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    let input: { targetAccountId: string; moderator: boolean };
    try {
      const parsed = roleChangeSchema.safeParse(await request.json());
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
      );
      return Response.json({ change });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

// The role is re-read from the database rather than trusted from the session,
// because a session issued before a revocation still carries MODERATOR.
async function requiredModeratorSession(
  dependencies: ModeratorRouteDependencies,
): Promise<{ user: { id: string; role: "MODERATOR" } } | Response> {
  let session: ModeratorRouteSession | null;
  try {
    session = await dependencies.getSession();
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the moderator request.");
  }
  if (session === null) {
    return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
  }

  let role: UserRole | null;
  try {
    role = await dependencies.getCurrentRole(session.user.id);
  } catch {
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to authorize the moderator request.");
  }
  if (role !== "MODERATOR") {
    return errorResponse(403, "FORBIDDEN", "Moderator permission is required.");
  }

  return { user: { id: session.user.id, role: "MODERATOR" } };
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
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new AccountModerationService(new PostgresModerationStore());
  },
};

export const GET = createModeratorGetHandler(productionDependencies);
export const POST = createModeratorPostHandler(productionDependencies);
