import { z } from "zod";

/**
 * The longest free-text reason the settlement-override and moderation APIs
 * accept, counted after trimming. The database CHECKs added by migration 049
 * enforce the same bound on every stored reason column, so a route's cap and
 * the stored row can never drift apart.
 */
export const MAX_REASON_LENGTH = 2000;

/**
 * The shared reason schema for the override and moderation routes: trimmed,
 * nonblank, and capped at MAX_REASON_LENGTH, with the length measured on the
 * trimmed value. Every route takes its reason (or recalibration plan) field
 * from this helper so no route carries its own cap spelling.
 *
 * A route whose blank-reason rejection the service owns — where an existing
 * contract hands a blank reason to the service's normalizer for its structured
 * INVALID_INPUT answer — passes `{ allowBlank: true }`: the schema still trims
 * and caps, but a blank value flows through to that normalizer untouched.
 */
export function reasonText(options?: { allowBlank?: boolean }): z.ZodString {
  const capped = z.string().trim().max(MAX_REASON_LENGTH);
  return options?.allowBlank === true ? capped : capped.min(1);
}
