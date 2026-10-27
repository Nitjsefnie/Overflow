import { AppShell, PublicAppShell } from "@/components/app-shell";
import { formatInstant } from "@/lib/format-instant";
import { plural } from "@/lib/plural";
import type { SettledWorkStats } from "@/lib/public-stats";

function StatsSections({ stats, refreshMinutes }: { stats: SettledWorkStats; refreshMinutes: number }) {
  return (
    <>
      <section className="page-heading" aria-labelledby="stats-title">
        <h1 id="stats-title">Settled work</h1>
        <p>Read at <time dateTime={stats.readAt.toISOString()}>{formatInstant(stats.readAt)}</time>.</p>
        <p>Figures refresh on request at most once every <time dateTime={`PT${refreshMinutes}M`}>{refreshMinutes} {plural(refreshMinutes, "minute")}</time>.</p>
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
  // Resolve these at call time, like @/auth above: the suite runs with
  // `isolate: false`, and a static import freezes to the real module when
  // another test file renders this page first in the shared worker.
  const { getCurrentUserRole } = await import("@/lib/moderation/current-role");
  const { getSettledWorkStats, SETTLED_WORK_REFRESH_MINUTES } = await import("@/lib/public-stats");
  const session = await auth();
  const stats = await getSettledWorkStats();
  const user = session?.user as { id?: unknown; name?: unknown } | undefined;
  if (typeof user?.id === "string") {
    const currentRole = await getCurrentUserRole(user.id).catch(() => null);
    if (currentRole !== null) {
      const memberName = typeof user.name === "string" && user.name.trim().length > 0 ? user.name : "Member";
      return (
        <AppShell memberName={memberName} isModerator={currentRole === "MODERATOR"}>
          <StatsSections stats={stats} refreshMinutes={SETTLED_WORK_REFRESH_MINUTES} />
        </AppShell>
      );
    }
  }
  return (
    <PublicAppShell>
      <main className="page-content" id="main-content">
        <StatsSections stats={stats} refreshMinutes={SETTLED_WORK_REFRESH_MINUTES} />
      </main>
    </PublicAppShell>
  );
}
