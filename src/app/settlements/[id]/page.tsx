import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

type SettlementPageProps = {
  params: Promise<{ id: string }>;
};

export default async function SettlementPage({ params }: SettlementPageProps) {
  const session = await requireMemberPageSession();
  const { id } = await params;
  try {
    const { getSettlementProof } = await import("@/lib/dashboard/queries");
    const settlement = await getSettlementProof(session.user.id, id);
    if (settlement === null) {
      return (
        <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
          <section className="empty-state" aria-labelledby="proof-not-found-heading">
            <h1 id="proof-not-found-heading">Settlement proof is not available.</h1>
            <p>Return to your ledger and choose a settlement that belongs to your account.</p>
            <Link className="text-link" href="/dashboard">
              Return to the ledger
            </Link>
          </section>
        </AppShell>
      );
    }
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <article className="proof-card surface shadow-offset" aria-labelledby="settlement-proof-heading">
          <p className="eyebrow">Settlement proof · {settlement.status}</p>
          <h1 id="settlement-proof-heading">{settlement.repositoryName} settlement</h1>
          <dl className="proof-grid">
            <div>
              <dt>Issue</dt>
              <dd>
                <a href={settlement.issueUrl}>
                  #{settlement.issueNumber} {settlement.issueTitle}
                </a>
              </dd>
            </div>
            <div>
              <dt>Pull request</dt>
              <dd>
                <a href={settlement.pullRequestUrl}>
                  #{settlement.pullRequestNumber} {settlement.pullRequestTitle}
                </a>
              </dd>
            </div>
            <div>
              <dt>Opening comparison</dt>
              <dd>{settlement.openingComparisonPoints}</dd>
            </div>
            <div>
              <dt>Settled points</dt>
              <dd>{settlement.settledPoints ?? "Awaiting settlement"}</dd>
            </div>
            <div>
              <dt>Review deduction</dt>
              <dd>{settlement.reviewRounds}</dd>
            </div>
            <div>
              <dt>Credits moved</dt>
              <dd>{settlement.credits}</dd>
            </div>
          </dl>
          <p className="proof-fingerprint">
            GitHub closing-link proof <code>{settlement.proofSha256}</code>
          </p>
        </article>
      </AppShell>
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="proof-error-heading">
          <h1 id="proof-error-heading">Settlement proof could not be loaded.</h1>
          <p>Check the ledger connection, then return to the dashboard.</p>
          <Link className="text-link" href="/dashboard">
            Return to the ledger
          </Link>
        </section>
      </AppShell>
    );
  }
}
