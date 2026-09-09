import {
  getDashboard,
  type DashboardProjection,
} from "@/lib/dashboard/queries";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteDependencies,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export type DashboardRouteDependencies = MemberRouteDependencies & {
  getDashboard: (accountId: string) => Promise<DashboardProjection>;
};

/**
 * The one field of the projection JSON cannot carry: the page reads the
 * reconciliation failure time with `toISOString()` (dashboard/page.tsx), so
 * the API hands the same ISO string and `null` stays `null`. Every other
 * field passes through untouched.
 */
export function serializeDashboard(projection: DashboardProjection) {
  return {
    ...projection,
    registeredRepositories: projection.registeredRepositories.map((repository) => ({
      ...repository,
      reconciliationLastFailureAt: repository.reconciliationLastFailureAt
        ? repository.reconciliationLastFailureAt.toISOString()
        : null,
    })),
  };
}

export function createDashboardGetHandler(dependencies: DashboardRouteDependencies) {
  return async function getDashboard(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the calibration
    // comparison: a programmatic GET sends no Origin header at all, so
    // guarding it would reject every script client. The member gate still
    // resolves a bearer credential from the headers.
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    // The projection is the route's whole answer: its failure leaves nothing
    // to degrade to, so it takes the route's 502.
    let projection: DashboardProjection;
    try {
      projection = await dependencies.getDashboard(session.user.id);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the dashboard.");
    }

    return Response.json(serializeDashboard(projection));
  };
}

export const GET = createDashboardGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  getDashboard,
});
