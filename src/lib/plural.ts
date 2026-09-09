/**
 * A count and its noun, read together.
 *
 * English plurals collapse at one, so a count interpolated in front of a noun
 * needs the noun's plural form to follow the count: "1 credits" reads as a
 * defect, not as a rule. Zero and every other count take the plural form —
 * "0 credits" is a true reading of an empty balance — and an irregular noun
 * passes its plural form explicitly.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : pluralForm ?? `${singular}s`;
}
