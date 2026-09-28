import {
  errorResponse,
  getProductionSession,
} from "@/app/api/moderation/route";
import type { UserRole } from "@/lib/db/types";
import {
  requiredModeratorSession,
  type ModerationRouteSession,
} from "@/lib/moderation/route-auth";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { listUnwritableClosures, type UnwritableClosureQueues } from "@/lib/dashboard/queries";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export type ModerationUnwritableClosuresRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  listUnwritableClosures: (viewerId: string) => Promise<UnwritableClosureQueues>;
};

export function createModerationUnwritableClosuresGetHandler(
  dependencies: ModerationUnwritableClosuresRouteDependencies,
) {
  return async function getModerationUnwritableClosures(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the cohort preview:
    // rejectUntrustedRequest rejects a missing Origin header, but a
    // programmatic GET sends none at all, so applying it here would reject
    // every script client. The gate still resolves a bearer credential from
    // the headers.
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      return Response.json(await dependencies.listUnwritableClosures(session.user.id));
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the unwritable-closure queue.");
    }
  };
}

export const GET = createModerationUnwritableClosuresGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  listUnwritableClosures,
});
