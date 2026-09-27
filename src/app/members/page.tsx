import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { formatSigned } from "@/lib/format-signed";
import type { MemberStanding } from "@/lib/members/queries";

type MembersPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type MembersStandingsContentProps = {
  memberName: string;
  isModerator: boolean;
  viewerId: string;
  standings: MemberStanding[];
  /** The resolved page the reader is on, 1-based. */
  page: number;
  /** The resolved rows-per-page the page was served at. */
  pageSize: number;
  /** The raw query state the reader arrived with, carried into the pager links. */
  queryState: Record<string, string | string[] | undefined>;
};

export function MembersStandingsContent({
  memberName,
  isModerator,
  viewerId,
  standings,
  page,
  pageSize,
  queryState,
}: MembersStandingsContentProps) {
  const hasPrevious = page > 1;
  // A full page (== pageSize) means a next page may exist; a short page is
  // the last one.
  const hasNext = standings.length === pageSize;
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="members-standings-title">
        <p className="eyebrow">Contribution record</p>
        <h1 id="members-standings-title">How every account stands.</h1>
        <p>
          Earned counts the credits an account received for settled work; given counts the credits they
          paid as a sponsor when their repositories' issues closed. Only accounts holding at least one
          ledger entry are listed.
        </p>
      </section>
      {standings.length === 0 ? (
        <section className="empty-state" aria-labelledby="no-standings-heading">
          <h2 id="no-standings-heading">No ledger entry is recorded yet.</h2>
          <p>The standings grow as settled work moves credits between accounts.</p>
          <Link className="text-link" href="/issues">
            Find eligible issues
          </Link>
        </section>
      ) : (
        <section
          className="surface shadow-offset members-standings-card"
          aria-labelledby="members-standings-heading"
        >
          <h2 id="members-standings-heading">Member standings</h2>
          <ol className="standings-list" aria-label="Member standings">
            {standings.map((standing) => {
              const isSelf = standing.accountId === viewerId;
              return (
                <li
                  key={standing.accountId}
                  className={isSelf ? "standings-row standings-row-self" : "standings-row"}
                  aria-current={isSelf ? "true" : undefined}
                >
                  <p className="standings-login">
                    {standing.githubLogin}
                    {isSelf ? <span className="standings-self">You</span> : null}
                  </p>
                  <p className="mono-meta">
                    earned {standing.earnedTotal} · given {standing.givenTotal} · net{" "}
                    {formatSigned(standing.netBalance)}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      )}
      {hasPrevious || hasNext ? (
        <nav aria-label="Member standings pages">
          {hasPrevious ? (
            <Link className="text-link" href={standingsHref(queryState, page - 1)}>
              Previous page
            </Link>
          ) : null}
          {hasNext ? (
            <Link className="text-link" href={standingsHref(queryState, page + 1)}>
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </AppShell>
  );
}

export default async function MembersStandingsPage({ searchParams }: MembersPageProps = {}) {
  const session = await requireMemberPageSession();
  const query = searchParams === undefined ? {} : await searchParams;
  try {
    const { listMemberStandings, resolveMemberStandingsPage } = await import("@/lib/members/queries");
    const page = numericParam(query.page);
    const pageSize = numericParam(query.pageSize);
    const resolved = resolveMemberStandingsPage(page, pageSize);
    const standings = await listMemberStandings({ page: resolved.page, pageSize: resolved.pageSize });
    return (
      <MembersStandingsContent
        memberName={session.user.name}
        isModerator={isModeratorSession(session)}
        viewerId={session.user.id}
        standings={standings}
        page={resolved.page}
        pageSize={resolved.pageSize}
        queryState={query}
      />
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="members-standings-error-heading">
          <h1 id="members-standings-error-heading">The member standings could not be loaded.</h1>
          <p>Check the ledger connection, then try the standings again.</p>
          <Link className="text-link" href="/members">
            Retry the member standings
          </Link>
        </section>
      </AppShell>
    );
  }
}

/**
 * The page window's numbers straight from the query string: anything the
 * standings module would not read as a number stays undefined, so the module's
 * own defaults and clamp remain the only page arithmetic.
 */
function numericParam(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The pager's href for one page of the current standings view: every query
 * parameter the reader arrived with rides along unchanged, and only the page
 * itself is replaced (omitted for the first page).
 */
function standingsHref(queryState: Record<string, string | string[] | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryState)) {
    if (typeof value === "string") {
      params.set(key, value);
    }
  }
  if (page > 1) {
    params.set("page", String(page));
  } else {
    params.delete("page");
  }
  const queryString = params.toString();
  return queryString.length > 0 ? `/members?${queryString}` : "/members";
}
