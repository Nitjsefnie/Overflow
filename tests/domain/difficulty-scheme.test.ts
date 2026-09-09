import { describe, expect, it } from "vitest";
import {
  difficultySchemeInForceAt,
  parseActualDifficulty,
  parseOpeningDifficulty,
  validateDifficultyScheme,
  type DifficultyScheme,
  type DifficultySchemeVersion,
} from "@/lib/domain/difficulty-scheme";

function createScheme(): DifficultyScheme {
  return {
    openingName: "Size",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "size/S", comparisonPoints: 2, reservePoints: 2 },
      { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
      { label: "size/L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function secondScheme(): DifficultyScheme {
  const scheme = createScheme();
  return {
    ...scheme,
    actualLabels: scheme.actualLabels.map((label) => {
      if (label.label === "delivered/6") return { ...label, points: 7 };
      if (label.label === "delivered/7") return { ...label, points: 6 };
      return label;
    }),
  };
}

function version(scheme: DifficultyScheme, versionNumber: number, effectiveFrom: string): DifficultySchemeVersion {
  return { versionNumber, scheme, effectiveFrom };
}

describe("difficulty schemes", () => {
  it("validates a complete non-overlapping scheme", () => {
    expect(validateDifficultyScheme(createScheme())).toEqual({ ok: true });
  });

  it("resolves exactly one configured opening label", () => {
    expect(parseOpeningDifficulty(["bug", "size/M"], createScheme())).toEqual({
      kind: "ok",
      label: "size/M",
      comparisonPoints: 5,
      reservePoints: 5,
    });
  });

  it("marks multiple configured opening labels as ambiguous", () => {
    expect(parseOpeningDifficulty(["size/S", "size/L"], createScheme())).toEqual({
      kind: "ambiguous",
    });
  });

  it("resolves the configured actual points without using display names", () => {
    expect(parseActualDifficulty(["delivered/7"], createScheme())).toEqual({
      kind: "ok",
      label: "delivered/7",
      points: 7,
    });
  });

  it("returns none when a label is absent from the configured catalog", () => {
    expect(parseActualDifficulty(["bug", "delivered/eleven"], createScheme())).toEqual({
      kind: "none",
    });
  });

  it("rejects empty display names", () => {
    const scheme = createScheme();
    scheme.openingName = "   ";

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });

  it("rejects empty label text", () => {
    const scheme = createScheme();
    scheme.openingLabels[0].label = " ";

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });

  it("rejects duplicate label text within a catalog", () => {
    const scheme = createScheme();
    scheme.openingLabels[1].label = "size/S";

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });

  it("rejects labels that overlap the opening and actual catalogs", () => {
    const scheme = createScheme();
    scheme.actualLabels[0].label = "size/S";

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });

  it("rejects out-of-range mapping points", () => {
    const scheme = createScheme();
    scheme.openingLabels[0].reservePoints = 11;

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });

  it("rejects duplicate actual point mappings", () => {
    const scheme = createScheme();
    scheme.actualLabels[9].points = 9;

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });

  it("rejects actual catalogs that do not cover every point from one through ten", () => {
    const scheme = createScheme();
    scheme.actualLabels.pop();

    expect(validateDifficultyScheme(scheme)).toMatchObject({ ok: false });
  });
});

describe("selecting the difficulty catalog in force at an instant", () => {
  const current = secondScheme();

  it("keeps the sole registered catalog governing when no version history exists", () => {
    const registered = createScheme();

    expect(difficultySchemeInForceAt([], Date.parse("2026-09-01T00:00:00.000Z"), registered)).toBe(registered);
  });

  it("selects the latest version whose effective instant is at or before the given instant", () => {
    const versions = [
      version(createScheme(), 1, "2026-01-01T00:00:00.000Z"),
      version(current, 2, "2026-09-01T00:00:00.000Z"),
    ];

    expect(difficultySchemeInForceAt(versions, Date.parse("2026-08-31T23:59:59.999Z"), current)).toBe(versions[0]!.scheme);
    expect(difficultySchemeInForceAt(versions, Date.parse("2026-09-01T00:00:00.000Z"), current)).toBe(current);
  });

  it("lets the earliest version govern instants before the first version began", () => {
    const versions = [
      version(createScheme(), 1, "2026-01-01T00:00:00.000Z"),
      version(current, 2, "2026-09-01T00:00:00.000Z"),
    ];

    expect(difficultySchemeInForceAt(versions, Date.parse("2025-01-01T00:00:00.000Z"), current)).toBe(versions[0]!.scheme);
  });

  it("selects by time order rather than list order", () => {
    const versions = [
      version(current, 2, "2026-09-01T00:00:00.000Z"),
      version(createScheme(), 1, "2026-01-01T00:00:00.000Z"),
    ];

    expect(difficultySchemeInForceAt(versions, Date.parse("2026-08-31T23:59:59.999Z"), current)).toBe(versions[1]!.scheme);
    expect(difficultySchemeInForceAt(versions, Date.parse("2026-09-01T00:00:00.000Z"), current)).toBe(current);
  });

  it("ignores a version carrying an unreadable effective instant and falls back to the usable ones", () => {
    const versions = [
      version(createScheme(), 1, "2026-01-01T00:00:00.000Z"),
      version(secondScheme(), 2, "not-a-timestamp"),
    ];

    expect(difficultySchemeInForceAt(versions, Date.parse("2026-08-01T00:00:00.000Z"), current)).toBe(versions[0]!.scheme);
  });
});
