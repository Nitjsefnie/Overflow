import { readNumber, resolveSql, type DashboardQueryDependencies } from "@/lib/dashboard/queries";

export type SettledWorkStats = {
  pullRequests: number;
  contributors: number;
  points: number;
  readAt: Date;
};

/** How long a reading is reused; the stats page states this same number to visitors. */
export const SETTLED_WORK_REFRESH_MINUTES = 10;

export function createSettledWorkReader(
  dependencies: Pick<DashboardQueryDependencies, "sql"> & { now?: () => number } = {},
) {
  const now = dependencies.now ?? Date.now;
  let cached: SettledWorkStats | undefined;
  let inFlight: Promise<SettledWorkStats> | undefined;
  return async () => {
    if (inFlight !== undefined) return inFlight;
    if (cached !== undefined && now() - cached.readAt.getTime() < SETTLED_WORK_REFRESH_MINUTES * 60 * 1000) return cached;
    inFlight = (async () => {
      const sql = resolveSql(dependencies);
      const [row] = await sql<{ pull_requests: string; contributors: string; points: string }[]>`
        select count(distinct settlements.pull_request_id) as pull_requests,
          count(distinct settlements.creditor_id) as contributors,
          coalesce(sum(settlements.credits), 0) as points
        from settlements
        where settlements.status = 'SETTLED'
      `;
      const result = {
        pullRequests: readNumber(row.pull_requests, "Settled pull requests"),
        contributors: readNumber(row.contributors, "Settled contributors"),
        points: readNumber(row.points, "Settled points"),
        readAt: new Date(now()),
      };
      cached = result;
      return result;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

export const getSettledWorkStats = createSettledWorkReader();
