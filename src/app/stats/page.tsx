import { AppShell, PublicAppShell } from "@/components/app-shell";
import { formatInstant } from "@/lib/format-instant";
import { formatUnsigned } from "@/lib/format-signed";
import { plural } from "@/lib/plural";
import { REGISTRATION_REFUSAL_LABELS, type OwnerProgressStats, type SettledWorkStats } from "@/lib/public-stats";
import type { RegistrationRefusalKind } from "@/lib/stats/registration-attempts";

function StatsSections({ stats, progress, refreshMinutes }: { stats: SettledWorkStats; progress: OwnerProgressStats | null; refreshMinutes: number }) {
  const meanReviewRounds = stats.meanReviewRounds === null ? null : formatUnsigned(stats.meanReviewRounds);
  return (
    <>
      <section className="page-heading" aria-labelledby="stats-title">
        <h1 id="stats-title">Statistics</h1>
        <p>Settled work read at <time dateTime={stats.readAt.toISOString()}>{formatInstant(stats.readAt)}</time>.</p>
        <p>Figures refresh on request at most once every <time dateTime={`PT${refreshMinutes}M`}>{refreshMinutes} {plural(refreshMinutes, "minute")}</time>.</p>
      </section>
      <section className="surface" aria-label="Settled work totals">
        <h2>Settled work</h2>
        <p><strong>{stats.pullRequests}</strong> {plural(stats.pullRequests, "settled pull request")}</p>
        <p>
          Merged pull requests settled through Overflow&apos;s ledger, excluding self-work and work by
          authors without an Overflow account.
        </p>
        <p><strong>{stats.contributors}</strong> {plural(stats.contributors, "contributor")}</p>
        <p>Distinct accounts with at least one settled pull request.</p>
        <p><strong>{stats.points}</strong> {plural(stats.points, "point")}</p>
        <p>The points those settlements moved to contributors.</p>
        <p><strong>{stats.noRoundPullRequests}</strong> {plural(stats.noRoundPullRequests, "settled pull request")} merged with no changes-requested review round</p>
        <p>Settled pull requests with no changes-requested review standing when they merged.</p>
        {meanReviewRounds === null ? (
          <p role="status">No settled pull requests yet, so there is no mean.</p>
        ) : (
          // The unit follows the figure as shown: 1.004 displays "1" and reads "round".
          <p><strong>{meanReviewRounds}</strong> changes-requested review {meanReviewRounds === "1" ? "round" : "rounds"} per settled pull request, on average</p>
        )}
        <p>Each settled pull request counts once, however many issues it closed.</p>
      </section>
      <section className="surface" aria-label="Owner progress">
        <h2>Owner progress</h2>
        {progress === null ? (
          <p role="status">Owner progress is unavailable. Please try again later.</p>
        ) : (
          <>
            <p><strong>{progress.registrationStarts}</strong> webhook-route registration {plural(progress.registrationStarts, "sign-in")} started.</p>
            <p>
              <strong>{progress.repositories}</strong> {plural(progress.repositories, "repository", "repositories")} ever registered
              (<strong>{progress.githubRepositories}</strong> GitHub, <strong>{progress.gitlabRepositories}</strong> GitLab).
              App-route registrations start with their registration request.
            </p>
            <p><strong>{progress.listedIssue}</strong> {plural(progress.listedIssue, "repository", "repositories")} listed an issue.</p>
            <p><strong>{progress.contributorReviewed}</strong> {plural(progress.contributorReviewed, "repository", "repositories")} had a contributor pull request reviewed.</p>
            <p><strong>{progress.listedSecondIssue}</strong> {plural(progress.listedSecondIssue, "repository", "repositories")} listed a second issue.</p>
            <h3>Refused registration attempts by step</h3>
            {(Object.entries(REGISTRATION_REFUSAL_LABELS) as [RegistrationRefusalKind, string][]).map(([kind, label]) => (
              <p key={kind}><strong>{progress.refusedAttempts[kind]}</strong> {plural(progress.refusedAttempts[kind], "attempt")} — {label}</p>
            ))}
          </>
        )}
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
  const { getSettledWorkStats, getOwnerProgressStats, SETTLED_WORK_REFRESH_MINUTES } = await import("@/lib/public-stats");
  const session = await auth();
  const stats = await getSettledWorkStats();
  const progress = await getOwnerProgressStats().catch(() => null);
  const user = session?.user as { id?: unknown; name?: unknown } | undefined;
  if (typeof user?.id === "string") {
    const currentRole = await getCurrentUserRole(user.id).catch(() => null);
    if (currentRole !== null) {
      const memberName = typeof user.name === "string" && user.name.trim().length > 0 ? user.name : "Member";
      return (
        <AppShell memberName={memberName} isModerator={currentRole === "MODERATOR"}>
          <StatsSections stats={stats} progress={progress} refreshMinutes={SETTLED_WORK_REFRESH_MINUTES} />
        </AppShell>
      );
    }
  }
  return (
    <PublicAppShell>
      <main className="page-content" id="main-content">
        <StatsSections stats={stats} progress={progress} refreshMinutes={SETTLED_WORK_REFRESH_MINUTES} />
      </main>
    </PublicAppShell>
  );
}
