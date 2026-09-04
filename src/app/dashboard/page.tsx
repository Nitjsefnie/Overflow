import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BalanceCard } from "@/components/balance-card";
import type { DashboardProjection } from "@/lib/dashboard/queries";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

type DashboardContentProps = {
  memberName: string;
  isModerator: boolean;
  dashboard: DashboardProjection;
};

export function DashboardContent({ memberName, isModerator, dashboard }: DashboardContentProps) {
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="dashboard-title">
        <p className="eyebrow">Member dashboard</p>
        <h1 id="dashboard-title">Keep the ledger in view.</h1>
        <p>Headroom is settled balance minus reservations on open work assigned to outside contributors.</p>
      </section>
      <div className="dashboard-grid">
        <BalanceCard dashboard={dashboard} />
        <aside className="surface ledger-note" aria-labelledby="next-move-heading">
          <p className="eyebrow">Next move</p>
          <h2 id="next-move-heading">Offer work with a visible reserve.</h2>
          <p>Register a repository, name its catalogs, and let reconciliation provide the evidence.</p>
          <Link className="text-link" href="/repositories/new">
            Register one repository
          </Link>
        </aside>
      </div>
      <section className="recent-settlements surface shadow-offset" aria-labelledby="recent-settlements-heading">
        <p className="eyebrow">Closing-link evidence</p>
        <h2 id="recent-settlements-heading">Recent settlement proofs</h2>
        {dashboard.recentSettlements.length === 0 ? (
          <p className="empty-copy">No settlement proof belongs to this ledger yet. Complete eligible work to add one.</p>
        ) : (
          <ol className="recent-settlement-list">
            {dashboard.recentSettlements.map((settlement) => (
              <li key={settlement.id}>
                <article className="recent-settlement">
                  <p className="mono-meta">{settlement.repositoryName} · closing-link proof</p>
                  <p className="recent-settlement-links">
                    <a href={settlement.issueUrl}>Issue #{settlement.issueNumber}: {settlement.issueTitle}</a>
                    <a href={settlement.pullRequestUrl}>
                      Pull request #{settlement.pullRequestNumber}: {settlement.pullRequestTitle}
                    </a>
                  </p>
                  <p className="mono-meta">{settlement.credits} credits · review deduction {settlement.reviewRounds}</p>
                  <Link className="text-link" href={`/settlements/${settlement.id}`}>
                    View proof for issue #{settlement.issueNumber}
                  </Link>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}

export default async function DashboardPage() {
  const session = await requireMemberPageSession();
  try {
    const { getDashboard, readConfiguredCreditFloor } = await import("@/lib/dashboard/queries");
    const dashboard = await getDashboard(session.user.id, { creditFloor: readConfiguredCreditFloor() });
    return (
      <DashboardContent
        memberName={session.user.name}
        isModerator={isModeratorSession(session)}
        dashboard={dashboard}
      />
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="dashboard-error-title">
          <p className="eyebrow">Ledger unavailable</p>
          <h1 id="dashboard-error-title">The ledger could not be loaded.</h1>
          <p>Check the database connection, then refresh this dashboard.</p>
          <Link className="text-link" href="/dashboard">
            Try the ledger again
          </Link>
        </section>
      </AppShell>
    );
  }
}
