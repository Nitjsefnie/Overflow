import type { OpeningDifficultyLabel } from "@/lib/domain/difficulty-scheme";

// Mirrors the opening catalog registered by Nitjsefnie/Overflow.
export const OVERFLOW_OPENING_CATALOG: readonly (OpeningDifficultyLabel & { example: string })[] = [
  { label: "offered: trivial", comparisonPoints: 1, reservePoints: 1, example: "Correct a typo in a label." },
  { label: "offered: small", comparisonPoints: 3, reservePoints: 3, example: "Add a validation message to a form." },
  { label: "offered: medium", comparisonPoints: 5, reservePoints: 5, example: "Add a filter to the issues board." },
  { label: "offered: large", comparisonPoints: 8, reservePoints: 8, example: "Add a dashboard workflow backed by an API." },
  { label: "offered: deep", comparisonPoints: 10, reservePoints: 10, example: "Redesign a contributor workflow across the dashboard, API, and database." },
];
