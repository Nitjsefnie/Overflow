import { getSql } from "@/lib/db/client";

/**
 * A deliberately small SQL boundary that keeps member standings easy to
 * exercise without a database, shaped like the dashboard query module's.
 */
export type MemberStandingsSql = {
  <T extends readonly unknown[] = readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

/**
 * One account's contribution record, exposed as aggregates only: the member
 * identifier is the `github_login` alone, and no per-issue or per-settlement
 * detail rides beside it.
 */
export type MemberStanding = {
  accountId: string;
  githubLogin: string;
  earnedTotal: number;
  givenTotal: number;
  netBalance: number;
};

export type MemberStandingsQueryDependencies = {
  sql?: MemberStandingsSql;
};

/**
 * The page window a standings reader asks for. An unpaginated request reads
 * as the first page at the default size, exactly as the issues board reads
 * one: a page holding exactly `pageSize` rows is a full page, and a full page
 * means a next page may exist.
 */
export type MemberStandingsQuery = {
  /** 1-based page. Undefined, non-finite and non-positive values read as the first page. */
  page?: number;
  /** Rows per page. Undefined and non-finite values read as the default; out-of-range values clamp to 1..500. */
  pageSize?: number;
};

/**
 * The standings page shape for an unpaginated client: the first page at the
 * default size. Documented next to the board's numbers so the two lists page
 * alike.
 */
export const MEMBER_STANDINGS_DEFAULT_PAGE_SIZE = 200;

/** The largest page size the standings serve; anything above clamps back to it. */
export const MEMBER_STANDINGS_MAX_PAGE_SIZE = 500;

/**
 * The one clamp every standings caller passes through: whatever page and page
 * size reach the query, the SQL is always paged with a limit inside the
 * documented range and an offset no caller can steer outside it.
 */
export function resolveMemberStandingsPage(
  page: number | undefined,
  pageSize: number | undefined,
): { page: number; pageSize: number } {
  const resolvedPageSize =
    pageSize === undefined || !Number.isFinite(pageSize)
      ? MEMBER_STANDINGS_DEFAULT_PAGE_SIZE
      : Math.min(MEMBER_STANDINGS_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
  const resolvedPage =
    page === undefined || !Number.isFinite(page) ? 1 : Math.max(1, Math.floor(page));
  return { page: resolvedPage, pageSize: resolvedPageSize };
}

type MemberStandingsRow = {
  id: string;
  github_login: string;
  earned_total: number | string;
  given_total: number | string;
};

/**
 * Every account holding at least one ledger entry, busiest first, one page at
 * a time.
 *
 * The INNER JOIN is the roster rule: an account with no settled work — and no
 * sponsored settlement — has no contribution record to show and is not listed.
 * The two totals reuse the dashboard projection's arithmetic exactly, so a
 * member comparing this page against their own ledger sees the same numbers:
 * earned counts the credits received for settled work, and given counts the
 * credits paid as a sponsor when their repositories' issues closed.
 */
export async function listMemberStandings(
  query: MemberStandingsQuery = {},
  dependencies: MemberStandingsQueryDependencies = {},
): Promise<MemberStanding[]> {
  const sql = resolveSql(dependencies);
  const standingsPage = resolveMemberStandingsPage(query.page, query.pageSize);
  const rows = await sql<MemberStandingsRow[]>`
    select
      users.id,
      users.github_login,
      coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount > 0), 0)::integer as earned_total,
      abs(coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount < 0), 0))::integer as given_total
    from users
    join ledger_entries on ledger_entries.account_id = users.id
    group by users.id, users.github_login
    order by
      (
        coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount > 0), 0)
        + abs(coalesce(sum(ledger_entries.amount) filter (where ledger_entries.amount < 0), 0))
      ) desc,
      users.github_login asc,
      -- The unique page-cut tiebreaker: without a final total order a page
      -- boundary could drop or duplicate a row between requests.
      users.id asc
    limit ${standingsPage.pageSize} offset ${(standingsPage.page - 1) * standingsPage.pageSize}
  `;
  return rows.map((row) => {
    const earnedTotal = readNumber(row.earned_total, "Earned total");
    const givenTotal = readNumber(row.given_total, "Given total");
    return {
      accountId: readText(row.id, "Member account identifier"),
      githubLogin: readText(row.github_login, "Member login"),
      earnedTotal,
      givenTotal,
      netBalance: earnedTotal - givenTotal,
    };
  });
}

function resolveSql(dependencies: Pick<MemberStandingsQueryDependencies, "sql">): MemberStandingsSql {
  return dependencies.sql ?? (getSql() as unknown as MemberStandingsSql);
}

function readNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} was not a number.`);
  }
  return parsed;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} was not text.`);
  }
  return value;
}
