import {
  listSettlementHistory,
  type SettlementHistoryProjection,
} from "@/lib/dashboard/queries";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteDependencies,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export type SettlementsRouteDependencies = MemberRouteDependencies & {
  listSettlementHistory: (accountId: string) => Promise<SettlementHistoryProjection[]>;
};

export function createSettlementsGetHandler(dependencies: SettlementsRouteDependencies) {
  return async function getSettlements(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the issues board: a
    // programmatic GET sends no Origin header at all, so guarding it would
    // reject every script client. The member gate still resolves a bearer
    // credential from the headers.
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const settlements = await dependencies.listSettlementHistory(session.user.id);
      return Response.json(settlements);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the settlement history.");
    }
  };
}

export const GET = createSettlementsGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  listSettlementHistory,
});
