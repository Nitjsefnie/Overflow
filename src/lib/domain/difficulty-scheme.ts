export type OpeningDifficultyLabel = {
  label: string;
  comparisonPoints: number;
  reservePoints: number;
};

export type ActualDifficultyLabel = {
  label: string;
  points: number;
};

export type DifficultyScheme = {
  openingName: string;
  actualName: string;
  openingLabels: OpeningDifficultyLabel[];
  actualLabels: ActualDifficultyLabel[];
};

export type DifficultySchemeValidation = { ok: true } | { ok: false; reason: string };

/**
 * One entry of a repository's catalog history (issue 180): the catalog this
 * repository's sponsor registered or appended, and the instant from which it
 * governs. `effectiveFrom` is ISO-8601, held as text so the value survives the
 * store-to-fold boundary exactly as the fold reads it.
 */
export type DifficultySchemeVersion = {
  versionNumber: number;
  scheme: DifficultyScheme;
  effectiveFrom: string;
};

export type ActualDifficulty =
  | { kind: "ok"; label: string; points: number }
  | { kind: "none" | "ambiguous" };

const minimumPoints = 1;
const maximumPoints = 10;

export function validateDifficultyScheme(scheme: DifficultyScheme): DifficultySchemeValidation {
  if (scheme.openingName.trim().length === 0 || scheme.actualName.trim().length === 0) {
    return { ok: false, reason: "Display names must not be empty." };
  }

  if (scheme.openingLabels.length === 0) {
    return { ok: false, reason: "At least one opening label is required." };
  }

  const labels = new Set<string>();
  for (const openingLabel of scheme.openingLabels) {
    if (openingLabel.label.trim().length === 0) {
      return { ok: false, reason: "Opening label text must not be empty." };
    }

    if (labels.has(openingLabel.label)) {
      return { ok: false, reason: "Difficulty label text must be unique." };
    }

    if (!isPointsValue(openingLabel.comparisonPoints) || !isPointsValue(openingLabel.reservePoints)) {
      return { ok: false, reason: "Opening point mappings must be integers from one through ten." };
    }

    labels.add(openingLabel.label);
  }

  const actualPoints = new Set<number>();
  for (const actualLabel of scheme.actualLabels) {
    if (actualLabel.label.trim().length === 0) {
      return { ok: false, reason: "Actual label text must not be empty." };
    }

    if (labels.has(actualLabel.label)) {
      return { ok: false, reason: "Difficulty label text must be unique across catalogs." };
    }

    if (!isPointsValue(actualLabel.points)) {
      return { ok: false, reason: "Actual point mappings must be integers from one through ten." };
    }

    if (actualPoints.has(actualLabel.points)) {
      return { ok: false, reason: "Actual point mappings must be unique." };
    }

    labels.add(actualLabel.label);
    actualPoints.add(actualLabel.points);
  }

  for (let points = minimumPoints; points <= maximumPoints; points += 1) {
    if (!actualPoints.has(points)) {
      return { ok: false, reason: "Actual labels must cover points one through ten exactly once." };
    }
  }

  return { ok: true };
}

function isPointsValue(value: number): boolean {
  return Number.isInteger(value) && value >= minimumPoints && value <= maximumPoints;
}

/**
 * The catalog in force at an instant, for closures whose evidence window closed
 * then (issue 180): the latest version that began governing at or before the
 * instant, the earliest version for instants before any began, and the current
 * catalog when the repository carries no readable version history at all —
 * which is the one-catalog behavior every repository had before versioning.
 *
 * The caller supplies the instant; nothing here reads the clock, so a
 * re-derivation run of the same evidence selects the same version forever,
 * whatever a sponsor appends later. Appends are additive: later versions begin
 * governing; no earlier version's window is ever rewritten.
 */
export function difficultySchemeInForceAt(
  versions: readonly DifficultySchemeVersion[],
  at: number,
  current: DifficultyScheme,
): DifficultyScheme {
  const readable = [...versions]
    .map((version) => ({ version, effectiveAt: Date.parse(version.effectiveFrom) }))
    .filter((entry) => Number.isFinite(entry.effectiveAt))
    .sort((left, right) => left.effectiveAt - right.effectiveAt || left.version.versionNumber - right.version.versionNumber);
  if (readable.length === 0) {
    return current;
  }
  let inForce = readable[0]!.version.scheme;
  for (const entry of readable) {
    if (entry.effectiveAt <= at) {
      inForce = entry.version.scheme;
    }
  }
  return inForce;
}
