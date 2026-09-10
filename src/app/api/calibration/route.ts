import type {
  CalibrationComparison,
  RepositoryCalibrationEntry,
} from "@/lib/calibration/statistics";
import {
  getCalibrationComparison,
  getCalibrationComparisonByRepository,
  listSelfWorkCalibrations,
  loadCalibrationCohorts,
  type CalibrationCohorts,
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
  loadCalibrationCohorts: (accountId: string) => Promise<CalibrationCohorts>;
  getCalibrationComparison: (cohorts: CalibrationCohorts) => CalibrationComparison;
  getCalibrationComparisonByRepository: (cohorts: CalibrationCohorts) => RepositoryCalibrationEntry[];
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

    // The comparison is what the route is for: its failure leaves nothing to
    // answer with, so it takes the route's 502. Both views derive from the one
    // cohort selection, so a failure anywhere in that — the load or a
    // derivation — is the same failure: answering without the breakdown would
    // hand back a figure the member cannot place.
    let comparison: CalibrationComparison;
    let byRepository: RepositoryCalibrationEntry[];
    try {
      const cohorts = await dependencies.loadCalibrationCohorts(session.user.id);
      comparison = dependencies.getCalibrationComparison(cohorts);
      byRepository = dependencies.getCalibrationComparisonByRepository(cohorts);
    } catch {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to load the calibration comparison.");
    }

    let selfWork: SelfWorkCalibrationProjection[] | null;
    try {
      selfWork = await dependencies.listSelfWorkCalibrations(session.user.id);
    } catch {
      // The comparison is still answerable when the calibration list is not:
      // the calibration page renders the same degradation.
      selfWork = null;
    }

    return Response.json({ comparison, byRepository, selfWork });
  };
}

export const GET = createCalibrationGetHandler({
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  getCalibrationComparison,
  getCalibrationComparisonByRepository,
  listSelfWorkCalibrations,
  loadCalibrationCohorts,
});
