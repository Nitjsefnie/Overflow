import Link from "next/link";
import type {
  CalibrationComparison,
  CalibrationSummary,
  RepositoryCalibrationEntry,
} from "@/lib/calibration/statistics";
import type { SelfWorkCalibrationProjection } from "@/lib/dashboard/queries";
import { formatSigned } from "@/lib/format-signed";
import { plural } from "@/lib/plural";

type CalibrationPanelProps = {
  comparison: CalibrationComparison;
  byRepository?: readonly RepositoryCalibrationEntry[];
};

export function CalibrationPanel({ comparison, byRepository = [] }: CalibrationPanelProps) {
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
          <h2 id="self-work-heading">Self-work sample · {comparison.selfWork.count} {plural(comparison.selfWork.count, "pair")}</h2>
          {comparison.selfWork.count === 0 ? (
            <p>No self-work pairs yet</p>
          ) : (
            <>
              <p>Mean delta {formatSigned(comparison.selfWork.meanDelta)}</p>
              <p>Median delta {formatSigned(comparison.selfWork.medianDelta)}</p>
            </>
          )}
        </section>
        <section aria-labelledby="outsider-heading">
          <h2 id="outsider-heading">Outsider settlement sample · {comparison.outsider.count} {plural(comparison.outsider.count, "pair")}</h2>
          {comparison.outsider.count === 0 ? (
            <p>No outsider settlements yet</p>
          ) : (
            <>
              <p>Mean delta {formatSigned(comparison.outsider.meanDelta)}</p>
              <p>Median delta {formatSigned(comparison.outsider.medianDelta)}</p>
            </>
          )}
        </section>
      </div>
      {!noSamples ? (
        <p className="calibration-scale-limitation">
          Deltas are measured on the opening scale of each repository. Where a scale spaces its comparison
          points wider than one step — for example 1, 3, 5, 8, 10 — even a perfectly judged closure can carry a
          delta the scale forces: an issue worth 4 can only ever be offered 3 or 5. The reported mean and
          median delta do not separate that forced amount from judgment error.
        </p>
      ) : null}
      {comparison.differenceBetweenMeans === null ? (
        <p className="calibration-difference">A difference between means needs at least one pair in both samples.</p>
      ) : (
        <p className="calibration-difference">Difference between means {formatSigned(comparison.differenceBetweenMeans)}</p>
      )}
      {byRepository.length === 0 ? null : (
        <section aria-labelledby="calibration-by-repository-heading">
          <h2 id="calibration-by-repository-heading">Calibration by repository</h2>
          {byRepository.map((entry) => (
            <RepositoryCalibration key={entry.githubRepositoryId} entry={entry} />
          ))}
        </section>
      )}
    </section>
  );
}

/**
 * One repository's comparison, on that repository's own opening scale.
 *
 * The figure above pools both registered repositories, which do not offer the
 * same scale, so the pooled mean averages two different measurements. This
 * section is what lets a member read each one separately.
 */
function RepositoryCalibration({ entry }: { entry: RepositoryCalibrationEntry }) {
  const { repositoryName, comparison } = entry;
  return (
    <section aria-label={`${repositoryName} calibration`}>
      <h3>{repositoryName}</h3>
      <div className="calibration-grid">
        <RepositoryCohort
          label={`${repositoryName} self-work sample`}
          heading="Self-work sample"
          summary={comparison.selfWork}
          emptyCopy="No self-work pairs yet"
        />
        <RepositoryCohort
          label={`${repositoryName} outsider settlement sample`}
          heading="Outsider settlement sample"
          summary={comparison.outsider}
          emptyCopy="No outsider settlements yet"
        />
      </div>
      {comparison.differenceBetweenMeans === null ? (
        <p className="calibration-difference">A difference between means needs at least one pair in both samples.</p>
      ) : (
        <p className="calibration-difference">
          Difference between means {formatSigned(comparison.differenceBetweenMeans)}
        </p>
      )}
    </section>
  );
}

type RepositoryCohortProps = {
  label: string;
  heading: string;
  summary: CalibrationSummary;
  emptyCopy: string;
};

/**
 * One cohort of one repository's comparison.
 *
 * A cohort with no pairs carries a mean of nought only because there is nothing
 * to average; printing that nought here would read as a measured perfect
 * calibration, so the absence is named instead.
 */
function RepositoryCohort({ label, heading, summary, emptyCopy }: RepositoryCohortProps) {
  return (
    <section aria-label={label}>
      <h4>
        {heading} · {summary.count} {plural(summary.count, "pair")}
      </h4>
      {summary.count === 0 ? (
        <p>{emptyCopy}</p>
      ) : (
        <>
          <p>Mean delta {formatSigned(summary.meanDelta)}</p>
          <p>Median delta {formatSigned(summary.medianDelta)}</p>
        </>
      )}
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
