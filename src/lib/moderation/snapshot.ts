import type { CalibrationPair } from "@/lib/calibration/statistics";
import type { CalibrationCohortSnapshot } from "@/lib/moderation/service";

/**
 * The stored snapshot an audit carries (issue 330), read back from its JSONB
 * columns: the pairs must be complete calibration pairs and the comparison a
 * complete one, since a credit adjustment is computed from exactly this
 * evidence. Parse failures are a null, which the callers refuse as drift.
 */
export function parseStoredSnapshot(audit: {
  cohort_definition: unknown;
  cohort_statistics: unknown;
}): CalibrationCohortSnapshot | null {
  if (
    typeof audit.cohort_definition !== "object" ||
    audit.cohort_definition === null ||
    typeof audit.cohort_statistics !== "object" ||
    audit.cohort_statistics === null
  ) {
    return null;
  }
  const definition = audit.cohort_definition as Record<string, unknown>;
  const comparison = audit.cohort_statistics as Record<string, unknown>;

  if (typeof definition["targetAccountId"] !== "string") {
    return null;
  }
  const repositoryId = definition["repositoryId"];
  if (repositoryId !== null && typeof repositoryId !== "string") {
    return null;
  }
  if (typeof definition["sampleStartedAt"] !== "string" || typeof definition["sampleEndedAt"] !== "string") {
    return null;
  }
  const selfWorkPairs = parseStoredPairs(definition["selfWorkPairs"]);
  const outsiderSettlementPairs = parseStoredPairs(definition["outsiderSettlementPairs"]);
  if (selfWorkPairs === null || outsiderSettlementPairs === null) {
    return null;
  }

  const selfWork = parseStoredSummary(comparison["selfWork"]);
  const outsider = parseStoredSummary(comparison["outsider"]);
  if (selfWork === null || outsider === null) {
    return null;
  }
  const differenceBetweenMeans = comparison["differenceBetweenMeans"];
  if (differenceBetweenMeans !== null && typeof differenceBetweenMeans !== "number") {
    return null;
  }

  return {
    targetAccountId: definition["targetAccountId"],
    repositoryId,
    sampleStartedAt: definition["sampleStartedAt"],
    sampleEndedAt: definition["sampleEndedAt"],
    selfWorkPairs,
    outsiderSettlementPairs,
    comparison: { selfWork, outsider, differenceBetweenMeans },
  };
}

function parseStoredPairs(value: unknown): CalibrationPair[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const pairs: CalibrationPair[] = [];
  const seenProofs = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const pair = entry as Record<string, unknown>;
    const proofSha256 = pair["proofSha256"];
    if (
      !isPositiveSafeInteger(pair["githubRepositoryId"]) ||
      !isPositiveSafeInteger(pair["githubIssueId"]) ||
      !isPositiveSafeInteger(pair["githubPullRequestId"]) ||
      !isDifficultyPoints(pair["offeredDifficulty"]) ||
      !isDifficultyPoints(pair["settledDifficulty"]) ||
      typeof proofSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(proofSha256) ||
      typeof pair["mergedAt"] !== "string" ||
      Number.isNaN(Date.parse(pair["mergedAt"]))
    ) {
      return null;
    }
    // A repeated proof inside one cohort list would compensate one settlement
    // twice (or inflate a self cohort it does not belong to), so a snapshot
    // carrying one is malformed evidence, refused before anything computes.
    if (seenProofs.has(proofSha256)) {
      return null;
    }
    seenProofs.add(proofSha256);
    pairs.push({
      githubRepositoryId: pair["githubRepositoryId"],
      githubIssueId: pair["githubIssueId"],
      githubPullRequestId: pair["githubPullRequestId"],
      mergedAt: pair["mergedAt"],
      proofSha256,
      offeredDifficulty: pair["offeredDifficulty"],
      settledDifficulty: pair["settledDifficulty"],
    });
  }
  return pairs;
}

function parseStoredSummary(value: unknown): CalibrationCohortSnapshot["comparison"]["selfWork"] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const summary = value as Record<string, unknown>;
  if (
    !isNonNegativeSafeInteger(summary["count"]) ||
    typeof summary["meanDelta"] !== "number" ||
    typeof summary["medianDelta"] !== "number"
  ) {
    return null;
  }
  return {
    count: summary["count"],
    meanDelta: summary["meanDelta"],
    medianDelta: summary["medianDelta"],
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDifficultyPoints(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}
