import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { IssueCard } from "@/components/issue-card";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

type IssuesPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function IssuesPage({ searchParams }: IssuesPageProps = {}) {
  const session = await requireMemberPageSession();
  try {
    const { listEligibleIssues } = await import("@/lib/dashboard/queries");
    const query = searchParams === undefined ? {} : await searchParams;
    const repository = singleValue(query.repository);
    const openingLabel = singleValue(query.openingLabel);
    const requestedClaimState = singleValue(query.claimState);
    const claimState = requestedClaimState === "CLAIMED" || requestedClaimState === "ALL" ? requestedClaimState : "OPEN";
    const issues = await listEligibleIssues(session.user.id, { repository, openingLabel, claimState });
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="page-heading" aria-labelledby="eligible-issues-title">
          <p className="eyebrow">External cooperative work</p>
          <h1 id="eligible-issues-title">Eligible issues</h1>
          <p>Higher configured reserves appear first; ties keep the oldest issue first.</p>
        </section>
        <form className="surface" method="get" action="/issues" aria-label="Filter eligible issues">
          <label className="field">
            <span>Repository</span>
            <input name="repository" defaultValue={repository} placeholder="owner/name" />
          </label>
          <label className="field">
            <span>Offered rating label</span>
            <input name="openingLabel" defaultValue={openingLabel} />
          </label>
          <label className="field">
            <span>Claim state</span>
            <select name="claimState" defaultValue={claimState}>
              <option value="OPEN">Unclaimed</option>
              <option value="CLAIMED">Claimed</option>
              <option value="ALL">All</option>
            </select>
          </label>
          <button className="action-button" type="submit">Apply filters</button>
        </form>
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

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
