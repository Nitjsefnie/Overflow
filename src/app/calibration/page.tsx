import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { CalibrationPanel } from "@/components/calibration-panel";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

export default async function CalibrationPage() {
  const session = await requireMemberPageSession();
  try {
    const { getCalibrationComparison } = await import("@/lib/dashboard/queries");
    const comparison = await getCalibrationComparison(session.user.id);
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <CalibrationPanel comparison={comparison} />
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
