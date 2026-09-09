const deltaFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * A signed delta with at most two fractional digits, so a mean of seven
 * integer deltas reads "−0.57" rather than its raw float.
 *
 * The sign is applied outside Intl: a negative whose magnitude rounds to zero
 * would otherwise render as a minus sign in front of nothing, so it is pinned
 * to a bare "0". This is the module's sign contract, and
 * {@link formatUnsigned} applies the same pin to unsigned figures.
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

/**
 * An unsigned figure with at most two fractional digits, under the same sign
 * contract as its signed twin: a negative whose magnitude formats to "0"
 * returns "0"; any other negative returns the minus sign followed by the
 * magnitude; everything else returns the plain magnitude.
 */
export function formatUnsigned(value: number): string {
  const magnitude = deltaFormat.format(Math.abs(value));
  if (value < 0) {
    return magnitude === "0" ? "0" : `−${magnitude}`;
  }
  return magnitude;
}
