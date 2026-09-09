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
import { listOpenAudits, type OpenAuditProjection } from "@/lib/dashboard/queries";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export type ModerationAuditsRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  listOpenAudits: () => Promise<OpenAuditProjection[]>;
};

export function createModerationAuditsGetHandler(dependencies: ModerationAuditsRouteDependencies) {
  return async function getModerationAudits(request: Request): Promise<Response> {
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
      return Response.json(await dependencies.listOpenAudits());
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the moderation queue.");
    }
  };
}

export const GET = createModerationAuditsGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  listOpenAudits,
});
