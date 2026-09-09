import type { CalibrationComparison } from "@/lib/calibration/statistics";
import {
  getCalibrationComparison,
  listSelfWorkCalibrations,
  type SelfWorkCalibrationProjection,
} from "@/lib/dashboard/queries";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  errorResponse,
  getProductionSession,
  requiredMemberSession,
  type MemberRouteDependencies,
} from "@/lib/security/member-route-auth";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export type CalibrationRouteDependencies = MemberRouteDependencies & {
  getCalibrationComparison: (accountId: string) => Promise<CalibrationComparison>;
  listSelfWorkCalibrations: (accountId: string) => Promise<SelfWorkCalibrationProjection[]>;
};

export function createCalibrationGetHandler(dependencies: CalibrationRouteDependencies) {
  return async function getCalibration(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded, like the issues board and
    // the settlement history: a programmatic GET sends no Origin header at all,
    // so guarding it would reject every script client. The member gate still
    // resolves a bearer credential from the headers.
    const session = await requiredMemberSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      // Sequential like the page that mirrors it: the comparison is what the
      // route is for, and a comparison failure means there is nothing to list
      // alongside.
      const comparison = await dependencies.getCalibrationComparison(session.user.id);
      const selfWork = await dependencies.listSelfWorkCalibrations(session.user.id);
      return Response.json({ comparison, selfWork });
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the calibration comparison.");
    }
  };
}

export const GET = createCalibrationGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  getCalibrationComparison,
  listSelfWorkCalibrations,
});
