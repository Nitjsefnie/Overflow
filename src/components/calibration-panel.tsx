import Link from "next/link";
import type { CalibrationComparison } from "@/lib/calibration/statistics";
import type { SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";

type CalibrationPanelProps = {
  comparison: CalibrationComparison;
};

export function CalibrationPanel({ comparison }: CalibrationPanelProps) {
  const noSamples = comparison.selfWork.count === 0 && comparison.outsider.count === 0;
  return (
    <section className="calibration-panel surface shadow-offset" aria-labelledby="calibration-heading">
      <p className="eyebrow">Paired calibration evidence</p>
      <h1 id="calibration-heading">Calibration comparison</h1>
      {noSamples ? (
        <p className="empty-copy">Complete paired work to establish calibration.</p>
      ) : null}
      <div className="calibration-grid">
        <section aria-labelledby="self-work-heading">
          <h2 id="self-work-heading">Self-work sample · {comparison.selfWork.count} pairs</h2>
          <p>Mean delta {formatSigned(comparison.selfWork.meanDelta)}</p>
          <p>Median delta {formatSigned(comparison.selfWork.medianDelta)}</p>
        </section>
        <section aria-labelledby="outsider-heading">
          <h2 id="outsider-heading">Outsider settlement sample · {comparison.outsider.count} pairs</h2>
          <p>Mean delta {formatSigned(comparison.outsider.meanDelta)}</p>
          <p>Median delta {formatSigned(comparison.outsider.medianDelta)}</p>
        </section>
      </div>
      <p className="calibration-difference">Difference between means {formatSigned(comparison.differenceBetweenMeans)}</p>
    </section>
  );
}

type SelfWorkCalibrationListProps = {
  calibrations: readonly SelfWorkCalibrationProjection[];
};

/**
 * The closures the account was calibrated on, each linking to its proof.
 *
 * The comparison above is an aggregate, so a closure that recorded no actual
 * figure is invisible in it: it contributes no pair. Listing the closures
 * individually is what lets the sponsor find that one and correct it.
 */
export function SelfWorkCalibrationList({ calibrations }: SelfWorkCalibrationListProps) {
  if (calibrations.length === 0) {
    return (
      <section className="empty-state" aria-labelledby="no-self-work-calibrations-heading">
        <h2 id="no-self-work-calibrations-heading">No closure of your own has been calibrated yet.</h2>
        <p>A calibration is recorded when a merged pull request of yours closes an issue you sponsored.</p>
      </section>
    );
  }

  return (
    <section className="surface shadow-offset settlement-history-card" aria-labelledby="self-work-calibrations-heading">
      <h2 id="self-work-calibrations-heading">Closures calibrated against your own work</h2>
      <ol className="settlement-history-list" aria-label="Self-work calibrations">
        {calibrations.map((calibration) => (
          <li key={calibration.id}>
            <article className="settlement-history-row">
              <p className="settlement-history-status">
                <span className="mono-meta">
                  {calibration.repositoryName} · {calibration.mergedAt?.slice(0, 10) ?? "merge date unavailable"}
                </span>
              </p>
              <p className="settlement-history-links">
                Issue #{calibration.issueNumber}: {calibration.issueTitle}
              </p>
              <p className="mono-meta">
                Opening comparison {calibration.openingComparisonPoints} · actual{" "}
                {calibration.actualPoints ?? "never recorded"}
              </p>
              {calibration.actualPoints === null ? (
                <p className="settlement-history-note">
                  The settled evidence for this closure was rejected, so no actual figure was recorded. Open the
                  proof to request a correction.
                </p>
              ) : null}
              <Link className="text-link" href={`/calibration/${calibration.id}`}>
                View proof for issue #{calibration.issueNumber}
              </Link>
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatSigned(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  if (value < 0) {
    return `−${Math.abs(value)}`;
  }
  return "0";
}
