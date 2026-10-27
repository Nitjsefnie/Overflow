import { AppShell, PublicAppShell } from "@/components/app-shell";
import { formatInstant } from "@/lib/format-instant";
import { plural } from "@/lib/plural";
import type { SettledWorkStats } from "@/lib/public-stats";

export const dynamic = "force-dynamic";

function StatsSections({ stats }: { stats: SettledWorkStats }) {
  return (
    <>
      <section className="page-heading" aria-labelledby="stats-title">
        <h1 id="stats-title">Settled work</h1>
        <p>Read at <time dateTime={stats.readAt.toISOString()}>{formatInstant(stats.readAt)}</time>.</p>
        <p>Figures refresh on request at most once every 10 minutes.</p>
      </section>
      <section className="surface" aria-label="Settled work totals">
        <p><strong>{stats.pullRequests}</strong> {plural(stats.pullRequests, "settled pull request")}</p>
        <p>
          Merged pull requests settled through Overflow&apos;s ledger, excluding self-work and work by
          authors without an Overflow account.
        </p>
        <p><strong>{stats.contributors}</strong> {plural(stats.contributors, "contributor")}</p>
        <p>Distinct accounts with at least one settled pull request.</p>
        <p><strong>{stats.points}</strong> {plural(stats.points, "point")}</p>
        <p>The points those settlements moved to contributors.</p>
      </section>
    </>
  );
}

export default async function StatsPage() {
  const { auth } = await import("@/auth");
  const { getCurrentUserRole } = await import("@/lib/moderation/current-role");
  const { getSettledWorkStats } = await import("@/lib/public-stats");
  const session = await auth();
  const stats = await getSettledWorkStats();
  const user = session?.user as { id?: unknown; name?: unknown } | undefined;
  if (typeof user?.id === "string") {
    const currentRole = await getCurrentUserRole(user.id).catch(() => null);
    if (currentRole !== null) {
      const memberName = typeof user.name === "string" && user.name.trim().length > 0 ? user.name : "Member";
      return (
        <AppShell memberName={memberName} isModerator={currentRole === "MODERATOR"}>
          <StatsSections stats={stats} />
        </AppShell>
      );
    }
  }
  return (
    <PublicAppShell>
      <main className="page-content" id="main-content">
        <StatsSections stats={stats} />
      </main>
    </PublicAppShell>
  );
}
