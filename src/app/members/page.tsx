import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import type { MemberStanding } from "@/lib/members/queries";

type MembersStandingsContentProps = {
  memberName: string;
  isModerator: boolean;
  viewerId: string;
  standings: MemberStanding[];
};

export function MembersStandingsContent({ memberName, isModerator, viewerId, standings }: MembersStandingsContentProps) {
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
    </AppShell>
  );
}

export default async function MembersStandingsPage() {
  const session = await requireMemberPageSession();
  try {
    const { listMemberStandings } = await import("@/lib/members/queries");
    const standings = await listMemberStandings();
    return (
      <MembersStandingsContent
        memberName={session.user.name}
        isModerator={isModeratorSession(session)}
        viewerId={session.user.id}
        standings={standings}
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

function formatSigned(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : value > 0 ? `+${value}` : "0";
}
