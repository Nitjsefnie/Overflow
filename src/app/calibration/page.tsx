import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { CalibrationPanel, SelfWorkCalibrationList } from "@/components/calibration-panel";
import type { SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

export default async function CalibrationPage() {
  const session = await requireMemberPageSession();
  try {
    const { getCalibrationComparison } = await import("@/lib/dashboard/queries");
    const comparison = await getCalibrationComparison(session.user.id);
    const calibrations = await listCalibrations(session.user.id);
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <CalibrationPanel comparison={comparison} />
        {calibrations === null ? (
          <p className="mono-meta">Your calibrated closures could not be loaded.</p>
        ) : (
          <SelfWorkCalibrationList calibrations={calibrations} />
        )}
      </AppShell>
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="calibration-error-heading">
          <h1 id="calibration-error-heading">Calibration samples could not be loaded.</h1>
          <p>Check the ledger connection, then retry the comparison.</p>
          <Link className="text-link" href="/calibration">
            Retry calibration
          </Link>
        </section>
      </AppShell>
    );
  }
}

/**
 * The closures this account was calibrated on, or null when they could not be
 * read.
 *
 * A failure here loses the list, not the comparison above it: the aggregate is
 * what the page is for, and it is already in hand by the time this runs.
 */
async function listCalibrations(accountId: string): Promise<SelfWorkCalibrationProjection[] | null> {
  try {
    const { listSelfWorkCalibrations } = await import("@/lib/dashboard/queries");
    return await listSelfWorkCalibrations(accountId);
  } catch {
    return null;
  }
}
