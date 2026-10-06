import type { DashboardProjection } from "@/lib/dashboard/queries";

/**
 * The empty-ledger projection the dashboard's fixture states render: no
 * settlements, claims, repositories, notices, or open audit. Shared by every
 * suite that renders the dashboard or mocks its ledger read, so the shape has
 * one home.
 */
export function emptyDashboard(): DashboardProjection {
  return {
    settledBalance: 0,
    earnedTotal: 0,
    givenTotal: 0,
    reservedPoints: 0,
    availableHeadroom: 0,
    recentSettlements: [],
    openClaims: [],
    registeredRepositories: [],
    enforcementNotices: [],
    openAudit: null,
  };
}
