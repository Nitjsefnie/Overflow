/**
 * How long an Overflow-issued API token authenticates once its holder is known
 * to have it.
 *
 * The one statement of the lifetime in code: the store writes the expiry from
 * it and the token panel states it, so the copy cannot drift from the
 * credential. The column default is the delivery window below, not this
 * lifetime: the default serves only a writer that predates the column, and a
 * token it mints is one nobody has confirmed. The clock starts at the first
 * request that authenticates with the value, not at generation; until then the
 * token carries {@link API_TOKEN_DELIVERY_WINDOW_MINUTES} instead.
 *
 * Kept free of database imports because the panel is a client component.
 */
export const API_TOKEN_LIFETIME_DAYS = 90;

/**
 * How long an issued token authenticates before its holder has confirmed
 * possession of it by using it.
 *
 * The plaintext exists in exactly one response, and the store writes the hash
 * before that response is sent. A token nobody has ever presented is one whose
 * value may never have arrived — the response was lost with the process that
 * minted it — and its holder cannot revoke a value they never received. So the
 * ninety days above are measured from the first authenticated use, and this
 * window is what an unconfirmed token gets instead: long enough for the
 * response to land and the holder's first request to follow it, short enough
 * that an orphaned credential does not outlive the acknowledgement it missed.
 *
 * Like the lifetime, it lives here so no copy can drift from the credential.
 */
export const API_TOKEN_DELIVERY_WINDOW_MINUTES = 30;
