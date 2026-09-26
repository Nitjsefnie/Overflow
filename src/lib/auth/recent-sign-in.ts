/** Maximum age of the last GitHub sign-in accepted for sensitive actions. */
export const REAUTHENTICATION_WINDOW_MS = 10 * 60 * 1000;

/**
 * A small allowance for disagreement between servers' clocks. The JWT callback
 * records the GitHub sign-in in whole epoch seconds on an Overflow server.
 */
export const AUTHENTICATION_CLOCK_SKEW_MS = 60 * 1000;

export function isRecentSignIn(authenticatedAt: number | null, nowMs: number): boolean {
  if (authenticatedAt === null) return false;
  const ageMs = nowMs - authenticatedAt * 1000;
  return ageMs >= -AUTHENTICATION_CLOCK_SKEW_MS && ageMs <= REAUTHENTICATION_WINDOW_MS;
}
