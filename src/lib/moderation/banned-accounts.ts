import type { DashboardSql } from "@/lib/dashboard/queries";
import { readNumber, readText } from "@/lib/dashboard/queries";
import { getSql } from "@/lib/db/client";

/**
 * One account whose enforcement state is BANNED — the moderation page's
 * reversal section renders one reversal control per entry (issue 1072). The
 * shape mirrors the dashboard's recalibrating-account projection: the
 * confirmed-pattern count is context for the moderator, never reset by a
 * reversal.
 */
export type BannedAccountProjection = {
  id: string;
  githubLogin: string;
  confirmedPatternCount: number;
};

type BannedAccountRow = {
  id: string;
  github_login: string;
  confirmed_miscalibration_count: number | string;
};

/**
 * The banned-account projection beside the dashboard's
 * `listRecalibratingAccounts`: same ordering, same validated row shape, one
 * enforcement state different. It lives outside the dashboard module because
 * it serves the moderation page's reversal controls (issue 1072), not a
 * dashboard surface.
 */
export async function listBannedAccounts(
  dependencies: { sql?: DashboardSql } = {},
): Promise<BannedAccountProjection[]> {
  const sql = dependencies.sql ?? (getSql() as unknown as DashboardSql);
  const rows = await sql<BannedAccountRow[]>`
    select id, github_login, confirmed_miscalibration_count
    from users
    where enforcement_state = 'BANNED'
    order by github_login, id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Banned account identifier"),
    githubLogin: readText(row.github_login, "Banned account login"),
    confirmedPatternCount: readNumber(row.confirmed_miscalibration_count, "Confirmed pattern count"),
  }));
}
