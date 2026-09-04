import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { IssueCard } from "@/components/issue-card";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

export default async function IssuesPage() {
  const session = await requireMemberPageSession();
  try {
    const { listEligibleIssues } = await import("@/lib/dashboard/queries");
    const issues = await listEligibleIssues(session.user.id);
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="page-heading" aria-labelledby="eligible-issues-title">
          <p className="eyebrow">External cooperative work</p>
          <h1 id="eligible-issues-title">Eligible issues</h1>
          <p>Higher configured reserves appear first; ties keep the oldest issue first.</p>
        </section>
        {issues.length > 0 ? (
          <div className="issue-list">
            {issues.map((issue) => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </div>
        ) : (
          <section className="empty-state" aria-labelledby="no-issues-heading">
            <h2 id="no-issues-heading">No eligible issues are open.</h2>
            <p>Check back after another repository publishes an unassigned issue, or register your own repository.</p>
            <Link className="text-link" href="/repositories/new">
              Register one repository
            </Link>
          </section>
        )}
      </AppShell>
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="issues-error-heading">
          <h1 id="issues-error-heading">Eligible issues could not be loaded.</h1>
          <p>Check the ledger connection, then try this list again.</p>
          <Link className="text-link" href="/issues">
            Retry eligible issues
          </Link>
        </section>
      </AppShell>
    );
  }
}
