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
