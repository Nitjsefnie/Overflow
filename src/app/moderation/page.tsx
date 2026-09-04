import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import type { OpenAuditProjection } from "@/lib/dashboard/queries";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

export default async function ModerationPage() {
  const session = await requireMemberPageSession();
  if (!isModeratorSession(session)) {
    redirect("/dashboard");
  }

  let audits: OpenAuditProjection[] | null;
  try {
    const { listOpenAudits } = await import("@/lib/dashboard/queries");
    audits = await listOpenAudits();
  } catch {
    audits = null;
  }

  return (
    <AppShell memberName={session.user.name} isModerator>
      <section className="page-heading" aria-labelledby="moderation-title">
        <p className="eyebrow">Moderator controls</p>
        <h1 id="moderation-title">Audit before changing a member’s state.</h1>
        <p>Open audits compare paired samples. The sequence is audit, warn, recalibrate, then ban when patterns persist.</p>
      </section>
      {audits === null ? (
        <section className="empty-state" aria-labelledby="audit-error-heading">
          <h2 id="audit-error-heading">The audit queue could not be loaded.</h2>
          <p>Check the ledger connection, then return to moderation.</p>
        </section>
      ) : audits.length === 0 ? (
        <section className="empty-state" aria-labelledby="no-audits-heading">
          <h2 id="no-audits-heading">No account audits are open.</h2>
          <p>Review calibration comparisons before opening a new audit.</p>
        </section>
      ) : (
        <section className="audit-queue surface shadow-offset" aria-labelledby="open-audits-heading">
          <h2 id="open-audits-heading">Open audits</h2>
          <ol>
            {audits.map((audit) => (
              <li key={audit.id}>
                <strong>{audit.targetLogin}</strong> · reported by {audit.reporterLogin} · {audit.settledSampleSize} settled pairs
                {audit.repositoryName === null ? " · all repositories" : ` · ${audit.repositoryName}`}
              </li>
            ))}
          </ol>
        </section>
      )}
    </AppShell>
  );
}
