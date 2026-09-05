import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import type {
  EnforcementHistoryProjection,
  OpenAuditProjection,
  RecalibratingAccountProjection,
  UnwritableClosureProjection,
} from "@/lib/dashboard/queries";
import {
  isModeratorSession,
  requireMemberPageSession,
  type MemberPageSession,
} from "@/lib/dashboard/session";
import type { OpenSettlementOverrideRequest } from "@/lib/overrides/service";

export default async function ModerationPage() {
  const session = await requireMemberPageSession();
  if (!isModeratorSession(session)) {
    redirect("/dashboard");
  }

  const { ModerationControls, RecalibrationPlanControl } = await import("@/components/moderation-controls");
  const { ModeratorRoster } = await import("@/components/moderator-roster");
  const { SettlementOverrideQueue } = await import("@/components/settlement-override-queue");
  const { UnwritableClosureQueue } = await import("@/components/unwritable-closure-queue");

  let audits: OpenAuditProjection[] | null;
  let history: EnforcementHistoryProjection[] = [];
  let recalibratingAccounts: RecalibratingAccountProjection[] = [];
  let moderators: { accountId: string; githubLogin: string; isConfigured: boolean }[] = [];
  const settlementCorrections = await listSettlementCorrections(session.user);
  const unwritableClosures = await loadUnwritableClosures();
  try {
    const { listEnforcementHistory, listOpenAudits, listRecalibratingAccounts } = await import("@/lib/dashboard/queries");
    const { PostgresModerationStore } = await import("@/lib/moderation/postgres-store");
    [audits, history, recalibratingAccounts, moderators] = await Promise.all([
      listOpenAudits(),
      listEnforcementHistory(),
      listRecalibratingAccounts(),
      new PostgresModerationStore().listModerators(),
    ]);
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
                <p>
                  <strong>{audit.targetLogin}</strong> · reported by {audit.reporterLogin} · {audit.settledSampleSize} settled pairs
                  {audit.repositoryName === null ? " · all repositories" : ` · ${audit.repositoryName}`}
                </p>
                <p>Window: {audit.sampleStartedAt ?? "unknown"} to {audit.sampleEndedAt ?? "unknown"}</p>
                <details>
                  <summary>Reproducible cohort evidence and statistics</summary>
                  <pre>{JSON.stringify({ definition: audit.cohortDefinition, statistics: audit.cohortStatistics }, null, 2)}</pre>
                </details>
                <ModerationControls auditId={audit.id} targetLogin={audit.targetLogin} />
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="surface override-card" aria-labelledby="settlement-corrections-heading">
        <p className="eyebrow">Reported settlements</p>
        <h2 id="settlement-corrections-heading">Settlement corrections</h2>
        <p>
          A settlement is derived from GitHub history, so reconciliation cannot repair one whose evidence never
          existed. Granting a correction records the settled points to apply instead; credits are recomputed
          from those points and the review rounds the fold counted, and the correction is reapplied on every
          later reconciliation.
        </p>
        {settlementCorrections === null ? (
          <p>The settlement correction queue could not be loaded.</p>
        ) : (
          <SettlementOverrideQueue requests={settlementCorrections} />
        )}
      </section>
      <section className="surface override-card" aria-labelledby="unwritable-closures-heading">
        <p className="eyebrow">Closures that settled nothing</p>
        <h2 id="unwritable-closures-heading">Rejected settlement evidence</h2>
        <p>
          A closed issue with a merged pull request settles nothing when its label or rationale missed the
          evidence window. The reason is recorded here so a moderator can review it, and a member or the
          sponsor can request a correction from the settlement page.
        </p>
        {unwritableClosures === null ? (
          <p>The closure queue could not be loaded.</p>
        ) : (
          <UnwritableClosureQueue closures={unwritableClosures} />
        )}
      </section>
      <section className="surface" aria-labelledby="recalibrating-heading">
        <h2 id="recalibrating-heading">Recalibration plans and reactivation</h2>
        {recalibratingAccounts.length === 0 ? <p>No accounts are recalibrating.</p> : (
          <ol>
            {recalibratingAccounts.map((account) => (
              <li key={account.id}>
                <p><strong>{account.githubLogin}</strong> · {account.confirmedPatternCount} confirmed patterns</p>
                <RecalibrationPlanControl targetAccountId={account.id} targetLogin={account.githubLogin} />
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="surface moderation-card" aria-labelledby="moderators-heading">
        <p className="eyebrow">Who can moderate</p>
        <h2 id="moderators-heading">Moderators</h2>
        <p>
          Moderator status is granted here and recorded with who changed it. An account named in the deployment
          configuration is promoted again at its next sign-in, so removing it from that list is part of revoking
          it for good.
        </p>
        <ModeratorRoster moderators={moderators} currentAccountId={session.user.id} />
      </section>
      <section className="surface" aria-labelledby="enforcement-history-heading">
        <h2 id="enforcement-history-heading">Enforcement history</h2>
        {history.length === 0 ? <p>No enforcement events are recorded.</p> : (
          <ol>
            {history.map((event) => (
              <li key={event.id}>
                {event.createdAt} · {event.targetLogin}: {event.priorState} → {event.newState} · {event.reason}
                {event.recalibrationPlan === null ? null : <pre>{JSON.stringify(event.recalibrationPlan, null, 2)}</pre>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}

/**
 * The open correction queue, or null when it could not be read.
 *
 * The actor carries the role `requireMemberPageSession` re-read from the
 * database, so the queue is authorized by the same check the decision route
 * makes rather than by having reached this page.
 */
async function listSettlementCorrections(
  moderator: MemberPageSession["user"],
): Promise<OpenSettlementOverrideRequest[] | null> {
  try {
    const { PostgresSettlementOverrideStore } = await import("@/lib/overrides/postgres-store");
    const { SettlementOverrideService } = await import("@/lib/overrides/service");
    const service = new SettlementOverrideService(new PostgresSettlementOverrideStore());
    return await service.listOpenRequests({ id: moderator.id, role: moderator.role });
  } catch {
    return null;
  }
}

async function loadUnwritableClosures(): Promise<UnwritableClosureProjection[] | null> {
  try {
    const { listUnwritableClosures } = await import("@/lib/dashboard/queries");
    return await listUnwritableClosures();
  } catch {
    return null;
  }
}
