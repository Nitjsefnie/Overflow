/**
 * Display labels for stored enum text the dashboard holds. The sponsor reads
 * sentence-case display text, never the stored form: a value the schema does
 * not admit degrades to "Unknown" rather than leaking stored text.
 */

/**
 * The stored repository visibility as display text. The cases mirror the
 * visibility GitHub reports for a registered repository; a value added there
 * needs one here or it degrades to the bare default.
 */
export function visibilityLabel(visibility: string): string {
  switch (visibility) {
    case "PUBLIC":
      return "Public";
    case "PRIVATE":
      return "Private";
    default:
      return "Unknown";
  }
}

/**
 * A stored enforcement state as display text. The cases mirror the
 * enforcement_state enum — 001 plus the UNDER_AUDIT and WARNED additions in
 * 006; a value added there needs one here or it degrades to the bare default.
 */
export function enforcementStateLabel(state: string): string {
  switch (state) {
    case "ACTIVE":
      return "Active";
    case "UNDER_AUDIT":
      return "Under audit";
    case "WARNED":
      return "Warned";
    case "RECALIBRATING":
      return "Recalibrating";
    case "BANNED":
      return "Banned";
    default:
      return "Unknown";
  }
}
