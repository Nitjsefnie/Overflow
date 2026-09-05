import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";

/**
 * A scheme `is_valid_repository_difficulty_scheme` accepts: distinct opening labels with
 * comparison and reserve points in 1..10, and actual labels covering each of 1..10 exactly once
 * without colliding with an opening label.
 */
export function validDifficultyScheme(): DifficultyScheme {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}
