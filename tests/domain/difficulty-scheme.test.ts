import { describe, expect, it } from "vitest";
import {
  parseActualDifficulty,
  parseOpeningDifficulty,
  validateDifficultyScheme,
  type DifficultyScheme,
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
