import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { BalanceCard } from "@/components/balance-card";
import type { DashboardProjection, RegisteredRepositoryProjection } from "@/lib/dashboard/queries";
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
          <>
            <p className="settlement-history-cue">
              The five newest proofs are below. Everything else — including work that merged and scored zero — is
              on the history page.
            </p>
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
          </>
        )}
        <Link className="text-link" href="/settlements">
          See the full settlement history
        </Link>
      </section>
      <section className="surface" aria-labelledby="open-claims-heading">
        <h2 id="open-claims-heading">Open claims</h2>
        {dashboard.openClaims.length === 0 ? <p>No open claims are reserving your ledger.</p> : (
          <ul>
            {dashboard.openClaims.map((claim) => (
              <li key={claim.id}>
                <a href={claim.url}>{claim.repositoryName} #{claim.issueNumber}: {claim.title}</a>
                {" · "}{claim.assigneeGitHubLogin}{" · "}{claim.openingName}: {claim.openingLabel}{" · reserve "}{claim.reservePoints}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="surface" aria-labelledby="registered-repositories-heading">
        <h2 id="registered-repositories-heading">Registered repositories</h2>
        {dashboard.registeredRepositories.length === 0 ? <p>No repositories are registered to this account.</p> : (
          <ul>
            {dashboard.registeredRepositories.map((repository) => {
              // Held in a name so the two clauses stay independent: a repository can be both
              // unavailable and behind on reconciliation, and the sponsor is owed both readings.
              const reconciliation = reconciliationPhrase(repository);
              return (
                <li key={repository.id}>
                  {repository.ownerName} · {repository.visibility} · {repository.active ? "active" : "inactive"}
                  {" · "}{repository.openingName} / {repository.actualName}
                  {repository.unavailableReason === null ? null : ` · ${unavailabilityPhrase(repository.unavailableReason)}`}
                  {reconciliation === null ? null : ` · ${reconciliation}`}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="surface" aria-labelledby="enforcement-notices-heading">
        <h2 id="enforcement-notices-heading">Enforcement notices</h2>
        {dashboard.enforcementNotices.length === 0 ? <p>No enforcement notices are recorded.</p> : (
          <ol>
            {dashboard.enforcementNotices.map((notice) => (
              <li key={notice.id}>{notice.createdAt.slice(0, 10)} · {notice.priorState} → {notice.newState} · {notice.reason}</li>
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}

/** The reason is a stored enum; the sponsor is owed the plain reading of it, whatever the schema later admits. */
function unavailabilityPhrase(reason: string): string {
  // The cases are the registered_repositories_unavailable_reason_check constraint;
  // a reason added there needs one here or it degrades to the bare default.
  switch (reason) {
    case "NOT_FOUND":
      return "unavailable: not found on GitHub or no longer public";
    case "NOT_PUBLIC":
      return "unavailable: no longer public";
    case "IDENTITY_MISMATCH":
      return "unavailable: identity mismatch";
    default:
      return "unavailable";
  }
}

/**
 * What the reconciliation queue currently owes this repository, or nothing when it owes it nothing.
 *
 * A failed job is not abandoned work waiting on the sponsor, but only while the repository is
 * active: reviving a FAILED row is the sweep's job alone, and the sweep enqueues active
 * repositories only. Nothing deletes the row when a repository is deactivated — the sole delete is
 * the worker's own success path — so a deactivated repository keeps a FAILED row no sweep will ever
 * pick up, and promising a retry there would be an untruth on a line that already reads "inactive".
 * A PENDING or RUNNING job still drains either way, because claiming one does not consult `active`.
 *
 * The queue holds no error message on purpose — an upstream GitHub failure can carry the sponsor's
 * token — so the date is all the detail there is, and it is the latest failure rather than the
 * first: every retry and every fail rewrites `last_failure_at` to the moment it happened.
 */
function reconciliationPhrase(repository: RegisteredRepositoryProjection): string | null {
  const failedAt = repository.reconciliationLastFailureAt;
  switch (repository.reconciliationState) {
    case "FAILED": {
      // The schema admits a failed job with no recorded time; "last failed null" is worse than silence.
      const when = failedAt === null ? "" : ` (last failed ${failedAt.toISOString().slice(0, 10)})`;
      return repository.active
        ? `reconciliation is failing${when}; Overflow keeps retrying`
        : `reconciliation is failing${when}; it will not be retried while the repository is inactive`;
    }
    case "PENDING":
    case "RUNNING":
      return failedAt === null ? "reconciliation queued" : "retrying reconciliation after a failure";
    case "IDLE":
      // No default: a state added to ReconciliationJobState should fail this build, not go unsaid.
      return null;
  }
}

export default async function DashboardPage() {
  const session = await requireMemberPageSession();
  try {
    const { getDashboard } = await import("@/lib/dashboard/queries");
    const dashboard = await getDashboard(session.user.id);
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
