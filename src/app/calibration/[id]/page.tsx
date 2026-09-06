import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { SettlementCorrections } from "@/components/settlement-corrections";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import type { SettlementOverrideRequest } from "@/lib/overrides/service";
import { UNLABELLED_POINTS } from "@/lib/overrides/unlabelled-points";

type CalibrationProofPageProps = {
  params: Promise<{ id: string }>;
};

/**
 * The proof behind a closure the sponsor was calibrated on, and their recourse
 * against it.
 *
 * A sponsor who closes their own issue is both parties, so the fold records a
 * calibration instead of a settlement and no credits move. Nothing else on the
 * product shows that row, which left the one account entitled to correct it
 * with no way to reach it.
 */
export default async function CalibrationProofPage({ params }: CalibrationProofPageProps) {
  const session = await requireMemberPageSession();
  const { id } = await params;
  try {
    const { getSelfWorkCalibrationProof } = await import("@/lib/dashboard/queries");
    const calibration = await getSelfWorkCalibrationProof(session.user.id, id);
    if (calibration === null) {
      return (
        <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
          <section className="empty-state" aria-labelledby="calibration-proof-not-found-heading">
            <h1 id="calibration-proof-not-found-heading">Calibration proof is not available.</h1>
            <p>Return to your calibration and choose a closure your own account was calibrated on.</p>
            <Link className="text-link" href="/calibration">
              Return to the calibration comparison
            </Link>
          </section>
        </AppShell>
      );
    }
    const corrections = await listCorrections(session.user.id, calibration.id);
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <article className="proof-card surface shadow-offset" aria-labelledby="calibration-proof-heading">
          <p className="eyebrow">Self-work calibration proof</p>
          <h1 id="calibration-proof-heading">{calibration.repositoryName} calibration</h1>
          <dl className="proof-grid">
            <div>
              <dt>Issue</dt>
              <dd>
                <a href={calibration.issueUrl}>
                  #{calibration.issueNumber} {calibration.issueTitle}
                </a>
              </dd>
            </div>
            <div>
              <dt>Pull request</dt>
              <dd>
                <a href={calibration.pullRequestUrl}>
                  #{calibration.pullRequestNumber} {calibration.pullRequestTitle}
                </a>
              </dd>
            </div>
            <div>
              <dt>{calibration.openingName ?? "Opening comparison"}</dt>
              <dd>{calibration.openingLabel ?? "Unknown label"} · {calibration.openingComparisonPoints}</dd>
            </div>
            <div>
              <dt>{calibration.actualName ?? "Actual difficulty"}</dt>
              <dd>
                {calibration.actualPoints === null
                  ? "Never recorded"
                  : `${calibration.actualLabel ?? UNLABELLED_POINTS} · ${calibration.actualPoints}`}
              </dd>
            </div>
            <div>
              <dt>Merged</dt>
              <dd>{calibration.mergedAt ?? "Unavailable"}</dd>
            </div>
            <div>
              <dt>Merge commit</dt>
              <dd><code>{calibration.mergeCommitOid ?? "Unavailable"}</code></dd>
            </div>
          </dl>
          <p className="proof-fingerprint">
            You closed this issue yourself, so the fold recorded a calibration and no credits moved. The figures
            above are the pair your calibration comparison is drawn from.
          </p>
          {calibration.actualPoints === null ? (
            <p className="proof-fingerprint">
              The settled evidence for this closure was rejected, so no actual figure was ever recorded and this
              closure is missing from your comparison. A moderator can record one on a correction request.
            </p>
          ) : null}
          <p className="proof-fingerprint">
            GitHub closing-link proof <code>{calibration.proofSha256 ?? "Unavailable"}</code>
          </p>
        </article>
        <SettlementCorrections
          target={{ kind: "calibration", calibrationId: calibration.id }}
          requests={corrections}
        />
      </AppShell>
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="calibration-proof-error-heading">
          <h1 id="calibration-proof-error-heading">Calibration proof could not be loaded.</h1>
          <p>Check the ledger connection, then return to the dashboard.</p>
          <Link className="text-link" href="/dashboard">
            Return to the ledger
          </Link>
        </section>
      </AppShell>
    );
  }
}

/**
 * The correction requests already raised against this calibration.
 *
 * A failure here loses the correction history, not the proof, so the page still
 * renders its evidence rather than falling back to the error state.
 */
async function listCorrections(
  viewerId: string,
  calibrationId: string,
): Promise<SettlementOverrideRequest[]> {
  try {
    const { PostgresSettlementOverrideStore } = await import("@/lib/overrides/postgres-store");
    const { SettlementOverrideService } = await import("@/lib/overrides/service");
    const service = new SettlementOverrideService(new PostgresSettlementOverrideStore());
    return await service.listRequestsForCalibration({ id: viewerId }, calibrationId);
  } catch {
    return [];
  }
}
