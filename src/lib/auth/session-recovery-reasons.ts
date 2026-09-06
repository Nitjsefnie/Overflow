/**
 * The reasons the member-page gate hands to `/session`.
 *
 * The gate writes one of these into the query string and the recovery page reads it
 * back, so both modules share this declaration rather than each spelling the word out:
 * renaming the literal on one side alone is what shows a visitor the wrong copy.
 *
 * This module imports nothing on purpose. `/session` is the screen shown when the
 * ledger cannot be reached, so nothing in its import graph may reach the database.
 */
export const SESSION_RECOVERY_REASONS = {
  /** The role lookup threw: the sign-in still holds, the ledger did not answer. */
  unavailable: "unavailable",
  /** The lookup answered, and no member record matches the sign-in. */
  stale: "stale",
} as const;

export type SessionRecoveryReason = (typeof SESSION_RECOVERY_REASONS)[keyof typeof SESSION_RECOVERY_REASONS];

export function toSessionRecoveryReason(value: unknown): SessionRecoveryReason | undefined {
  return Object.values(SESSION_RECOVERY_REASONS).find((reason) => reason === value);
}
