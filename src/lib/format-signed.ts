const deltaFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * A signed delta with at most two fractional digits, so a mean of seven
 * integer deltas reads "−0.57" rather than its raw float.
 *
 * The sign is applied outside Intl: a negative whose magnitude rounds to zero
 * would otherwise render as a minus sign in front of nothing, so it is pinned
 * to a bare "0".
 */
export function formatSigned(value: number): string {
  const magnitude = deltaFormat.format(Math.abs(value));
  if (value > 0) {
    return `+${magnitude}`;
  }
  if (value < 0) {
    return magnitude === "0" ? "0" : `−${magnitude}`;
  }
  return "0";
}
