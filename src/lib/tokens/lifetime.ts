/**
 * How long an Overflow-issued API token authenticates, counted from the moment
 * it is generated or regenerated.
 *
 * The one statement of the lifetime in code: the store writes the expiry from
 * it and the token panel states it, so the copy cannot drift from the
 * credential. Migration 046 repeats the value as the column default, which
 * only a writer that predates the column relies on.
 * Kept free of database imports because the panel is a client component.
 */
export const API_TOKEN_LIFETIME_DAYS = 90;
