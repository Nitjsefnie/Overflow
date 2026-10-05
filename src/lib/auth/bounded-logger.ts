import { logField } from "@/lib/webhooks/log-field";

/**
 * One bounded line for an error @auth/core reports. The service journal is
 * size-bounded, and a request whose session cookie cannot be decrypted used
 * to cost it a multi-line, ANSI-coloured error block per request — the
 * @auth/core default logger prints the error name, then the cause's full
 * stack, then the cause's details, and colours each with terminal escapes.
 * The `logger` option on the NextAuth configuration is the single lever for
 * every @auth/core error path (the core merges the configured members over
 * its defaults and calls one `logger.error` per error), so this module is
 * what `src/auth.ts` passes there.
 *
 * The line carries three things and nothing else:
 *
 * - the fixed `[auth][error]` prefix, so journal greps for Auth.js errors
 *   keep working;
 * - the error's class name (`error.name` — `JWTSessionError` for the
 *   undecryptable-session path), so the class is named as the ruling asks;
 * - the underlying cause's message (the @auth/core `cause.err` shape, or the
 *   error's own message when there is no cause), the one variable text —
 *   never the stack, never the details object, and never the cookie: the
 *   cookie's value reaches no Auth.js error on this path (the undecryptable
 *   token is read by @auth/core, which fails decryption without echoing the
 *   token into the error), and even a hypothetical message that carried it
 *   is bounded and escaped by the encoder before it is written.
 *
 * Everything variable goes through `logField` (the webhook log-field
 * encoder): control characters, terminal escapes and bidi marks become
 * visible \uXXXX escapes, quotes are escaped, a lone surrogate is escaped,
 * and the kept text is capped at 256 code units with a visible truncation
 * marker, so the line can neither gain a second line, drive an operator's
 * terminal, reorder visually, nor flood the journal. `AUTH_ERROR_LOG_LINE_MAX`
 * is the hard cap on the composed line, enforced as a final slice.
 */

export const AUTH_ERROR_LOG_LINE_MAX = 512;

export function boundedAuthErrorLine(error: unknown): string {
  const label = error instanceof Error ? error.name : `non-error (${typeof error})`;
  const detail = causeDetail(error);
  const variable = detail === "" ? label : `${label}: ${detail}`;
  const line = `[auth][error] ${logField(variable)}`;
  return line.length > AUTH_ERROR_LOG_LINE_MAX ? line.slice(0, AUTH_ERROR_LOG_LINE_MAX) : line;
}

/**
 * The one variable text the line carries: the message of the error @auth/core
 * attached as its cause (`new JWTSessionError(e)` stores the thrown error at
 * `cause.err`), or the error's own message when there is no such cause.
 * Never the stack and never the details object — both are what made the
 * default output a multi-line block.
 */
function causeDetail(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== null && typeof cause === "object" && "err" in cause) {
    const err = (cause as { err?: unknown }).err;
    if (err instanceof Error) return err.message;
  }
  return error.message;
}
