export type CalibrationPair = {
  githubRepositoryId: number;
  githubIssueId: number;
  githubPullRequestId: number;
  mergedAt: string;
  proofSha256: string;
  offeredDifficulty: number;
  settledDifficulty: number;
};

export type CalibrationSummary = {
  count: number;
  meanDelta: number;
  medianDelta: number;
};

export type CalibrationComparison = {
  selfWork: CalibrationSummary;
  outsider: CalibrationSummary;
  differenceBetweenMeans: number;
};

export class CalibrationStatisticsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CalibrationStatisticsError";
  }
}

export function summarizeCalibration(pairs: readonly CalibrationPair[]): CalibrationSummary {
  const deltas = pairs.map((pair) => {
    assertValidPair(pair);
    return pair.settledDifficulty - pair.offeredDifficulty;
  });

  if (deltas.length === 0) {
    return { count: 0, meanDelta: 0, medianDelta: 0 };
  }

  const ordered = [...deltas].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const medianDelta =
    ordered.length % 2 === 0
      ? (ordered[middle - 1]! + ordered[middle]!) / 2
      : ordered[middle]!;

  return {
    count: deltas.length,
    meanDelta: deltas.reduce((total, delta) => total + delta, 0) / deltas.length,
    medianDelta,
  };
}

export function compareCalibration(
  selfWorkPairs: readonly CalibrationPair[],
  outsiderPairs: readonly CalibrationPair[],
): CalibrationComparison {
  const selfWork = summarizeCalibration(selfWorkPairs);
  const outsider = summarizeCalibration(outsiderPairs);
  return {
    selfWork,
    outsider,
    differenceBetweenMeans: selfWork.meanDelta - outsider.meanDelta,
  };
}

function assertValidPair(pair: CalibrationPair): void {
  for (const [label, value] of [
    ["GitHub repository identifier", pair.githubRepositoryId],
    ["GitHub issue identifier", pair.githubIssueId],
    ["GitHub pull request identifier", pair.githubPullRequestId],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new CalibrationStatisticsError(`${label} must be a positive integer.`);
    }
  }

  for (const [label, value] of [
    ["Offered difficulty", pair.offeredDifficulty],
    ["Settled difficulty", pair.settledDifficulty],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > 10) {
      throw new CalibrationStatisticsError(`${label} must be an integer from 1 through 10.`);
    }
  }

  if (typeof pair.proofSha256 !== "string" || !/^[0-9a-f]{64}$/.test(pair.proofSha256)) {
    throw new CalibrationStatisticsError("GitHub proof fingerprint must be a lowercase SHA-256 digest.");
  }
  if (typeof pair.mergedAt !== "string" || Number.isNaN(Date.parse(pair.mergedAt))) {
    throw new CalibrationStatisticsError("GitHub merge time must be a valid timestamp.");
  }
}
