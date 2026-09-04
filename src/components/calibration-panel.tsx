import type { CalibrationComparison } from "@/lib/calibration/statistics";

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

function formatSigned(value: number): string {
  if (value > 0) {
    return `+${value}`;
  }
  if (value < 0) {
    return `−${Math.abs(value)}`;
  }
  return "0";
}
