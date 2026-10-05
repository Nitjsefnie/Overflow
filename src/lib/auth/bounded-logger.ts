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
 * is the hard cap on the composed line, enforced as a final truncation that
 * never splits an escape, the marker, or a surrogate pair.
 */

export const AUTH_ERROR_LOG_LINE_MAX = 512;

export function boundedAuthErrorLine(error: unknown): string {
  const label = error instanceof Error ? error.name : `non-error (${typeof error})`;
  const detail = causeDetail(error);
  const variable = detail === "" ? label : `${label}: ${detail}`;
  const line = `[auth][error] ${logField(variable)}`;
  return truncateBoundedLine(line);
}

/**
 * The hard cap on a composed line, enforced as a final step. Kept separate
 * and exported because it is a behaviour of its own: the cut must never
 * split a `\uXXXX` escape, logField's truncation marker, or a surrogate
 * pair — a cut that did would leave a lone surrogate or a misleading
 * fragment in an otherwise control-free line.
 */
export function truncateBoundedLine(line: string): string {
  if (line.length <= AUTH_ERROR_LOG_LINE_MAX) return line;
  // Room for the closing ellipsis.
  let cut = AUTH_ERROR_LOG_LINE_MAX - 1;
  // A `…` that logField appended as its own truncation marker is dropped
  // whole when the cut would land inside the marker — `… (+12` states
  // nothing — and the ellipsis appended below keeps the truncation visible.
  // A `…` inside the kept text could be mistaken for the marker here; cutting
  // at one only drops more of the line, never makes the result unsafe.
  const markerStart = line.lastIndexOf("…", cut);
  if (
    markerStart !== -1 && markerStart > cut - MARKER_MAX_CODE_UNITS
    && partialMarkerAt(line, markerStart, cut)
  ) {
    cut = markerStart;
  }
  // Never split a surrogate pair at the cut.
  if (
    cut > 0 && cut < line.length
    && isHighSurrogate(line.charCodeAt(cut - 1)) && isLowSurrogate(line.charCodeAt(cut))
  ) {
    cut -= 1;
  }
  // Never leave a partial escape sequence — a trailing `\`, `\u`, `\u0`, ….
  cut = backOverPartialEscape(line, cut);
  return `${line.slice(0, cut)}…`;
}

/** The widest `… (+9007199254740991 more)`-shaped marker, with slack. */
const MARKER_MAX_CODE_UNITS = 32;

/**
 * True when the units between `markerStart` and `cut` are a proper prefix of
 * logField's truncation marker ` (+123 more)` — ` (+`, ` (+12`, ` (+123 mor`,
 * and so on — so the cut drops the half-stated marker whole.
 */
function partialMarkerAt(line: string, markerStart: number, cut: number): boolean {
  const tail = line.slice(markerStart + 1, cut);
  if (tail === "" || tail === " ") return tail === " ";
  if (!tail.startsWith(" (+")) return false;
  let index = 3;
  while (index < tail.length && tail.charCodeAt(index) >= 0x30 && tail.charCodeAt(index) <= 0x39) {
    index += 1;
  }
  if (index === tail.length) return true;
  if (tail[index] !== " ") return false;
  return "more".startsWith(tail.slice(index + 1));
}

/**
 * The cut of a partial `\uXXXX` escape moves back to the escape's backslash,
 * dropping the fragment whole. A complete escape (`\"`, `\\`, `\uXXXX`) or
 * any other unit ends the backward scan.
 */
function backOverPartialEscape(line: string, cut: number): number {
  const window = Math.min(6, cut);
  for (let back = 1; back <= window; back += 1) {
    const index = cut - back;
    if (line.charCodeAt(index) !== 0x5c) continue;
    const tail = line.slice(index + 1, cut);
    if (tail === "" || /^u[0-9a-fA-F]{0,3}$/.test(tail)) return index;
    return cut;
  }
  return cut;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
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
