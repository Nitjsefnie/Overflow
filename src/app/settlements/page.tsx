import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { SETTLEMENT_HISTORY_LIMIT, type SettlementHistoryProjection, type SettlementStatus } from "@/lib/dashboard/queries";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

type SettlementHistoryContentProps = {
  memberName: string;
  isModerator: boolean;
  settlements: SettlementHistoryProjection[];
};

export function SettlementHistoryContent({ memberName, isModerator, settlements }: SettlementHistoryContentProps) {
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="settlement-history-title">
        <p className="eyebrow">Closing-link evidence</p>
        <h1 id="settlement-history-title">Every settlement on your ledger.</h1>
        <p>
          Newest first, and nothing is filtered out: work that merged and scored zero is listed beside work that
          paid. The list holds the most recent {SETTLEMENT_HISTORY_LIMIT} settlements.
        </p>
      </section>
      {settlements.length === 0 ? (
        <section className="empty-state" aria-labelledby="no-settlements-heading">
          <h2 id="no-settlements-heading">No settlement is recorded against this account yet.</h2>
          <p>A settlement appears here once a merged pull request closes an issue your account is party to.</p>
          <Link className="text-link" href="/issues">
            Find eligible issues
          </Link>
        </section>
      ) : (
        <section className="surface shadow-offset settlement-history-card" aria-labelledby="settlement-history-heading">
          <h2 id="settlement-history-heading">Settlement history</h2>
          <ol className="settlement-history-list" aria-label="Settlement history">
            {settlements.map((settlement) => (
              <li key={settlement.id}>
                <article className="settlement-history-row">
                  <p className="settlement-history-status">
                    <span className={statusClassName(settlement.status)}>{statusLabel(settlement.status)}</span>
                    <span className="mono-meta">
                      {settlement.repositoryName} · {settlement.settledAt.slice(0, 10)}
                    </span>
                  </p>
                  <p className="settlement-history-links">
                    <a href={settlement.issueUrl}>
                      Issue #{settlement.issueNumber}: {settlement.issueTitle}
                    </a>
                  </p>
                  <p className="mono-meta">
                    {settlement.credits} credits · review deduction {settlement.reviewRounds} · balance effect{" "}
                    {formatSigned(settlement.balanceEffect)}
                  </p>
                  <p className="settlement-history-note">{statusExplanation(settlement.status)}</p>
                  <Link className="text-link" href={`/settlements/${settlement.id}`}>
                    View proof for issue #{settlement.issueNumber}
                  </Link>
                </article>
              </li>
            ))}
          </ol>
        </section>
      )}
    </AppShell>
  );
}

export default async function SettlementHistoryPage() {
  const session = await requireMemberPageSession();
  try {
    const { listSettlementHistory } = await import("@/lib/dashboard/queries");
    const settlements = await listSettlementHistory(session.user.id);
    return (
      <SettlementHistoryContent
        memberName={session.user.name}
        isModerator={isModeratorSession(session)}
        settlements={settlements}
      />
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="settlement-history-error-heading">
          <h1 id="settlement-history-error-heading">Your settlement history could not be loaded.</h1>
          <p>Check the ledger connection, then try this history again.</p>
          <Link className="text-link" href="/settlements">
            Retry the settlement history
          </Link>
        </section>
      </AppShell>
    );
  }
}

function statusLabel(status: SettlementStatus): string {
  if (status === "SETTLED") {
    return "Settled";
  }
  if (status === "UNCLAIMED") {
    return "Awaiting a claim";
  }
  return "Found · scored zero";
}

function statusClassName(status: SettlementStatus): string {
  return `settlement-status settlement-status-${status.toLowerCase()}`;
}

function statusExplanation(status: SettlementStatus): string {
  if (status === "SETTLED") {
    return "Settled from the issue owner's actual-catalog label, less one point for each distinct review round.";
  }
  if (status === "UNCLAIMED") {
    return "Priced and recorded, waiting for the contributor to claim their GitHub identity before credits move.";
  }
  return "Found and scored zero: the merge was recorded, but the settled label or its rationale comment was missing or landed outside the evidence window, so no credits moved.";
}

function formatSigned(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : value > 0 ? `+${value}` : "0";
}
