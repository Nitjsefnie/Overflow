// A webhook delivery's identifiers are request-derived text. The repository's
// full name comes from the payload, and the parsers accept it with internal
// line breaks, terminal escapes and at any length. The receipt key and the
// execution UUID come from headers, so they cannot carry a line feed and the
// parsers cap them at 255 characters, but they can still carry ESC and other
// control or bidi characters. This helper turns one such string into a single
// bounded token for a log line, so an identifier can neither forge a second
// line, drive the operator's terminal, visually reorder the line, nor flood
// it.
//
// The token is a JSON string literal of the kept prefix: `"` and `\` are
// backslash-escaped, and every code unit that could break or disguise the
// line is written as a \uXXXX escape, so JSON.parse of the quoted part
// returns exactly the kept text. At most MAX_LOGGED_CODE_UNITS UTF-16 code
// units are kept; a longer input gets an ellipsis and a count of the dropped
// code units after the closing quote. A surrogate without its partner — one
// the cut split, or one the input carried — is escaped like any other unsafe
// code unit, so the token never holds a lone surrogate.

const MAX_LOGGED_CODE_UNITS = 256;

export function logField(value: string): string {
  const kept = value.length > MAX_LOGGED_CODE_UNITS ? value.slice(0, MAX_LOGGED_CODE_UNITS) : value;
  let token = "\"";
  for (let index = 0; index < kept.length; index += 1) {
    const unit = kept.charCodeAt(index);
    if (isHighSurrogate(unit) && index + 1 < kept.length && isLowSurrogate(kept.charCodeAt(index + 1))) {
      token += kept[index] + kept[index + 1];
      index += 1;
    } else if (unit === 0x22 || unit === 0x5c) {
      token += `\\${kept[index]}`;
    } else if (mustEscape(unit)) {
      token += `\\u${unit.toString(16).padStart(4, "0")}`;
    } else {
      token += kept[index];
    }
  }
  token += "\"";
  const dropped = value.length - kept.length;
  return dropped > 0 ? `${token}… (+${dropped} more)` : token;
}

function mustEscape(unit: number): boolean {
  return unit <= 0x1f // C0 controls
    || (unit >= 0x7f && unit <= 0x9f) // DEL and C1 controls
    || unit === 0x2028 || unit === 0x2029 // line and paragraph separators
    || unit === 0x061c // Arabic letter mark, a bidi mark
    || unit === 0x200e || unit === 0x200f // bidi marks
    || (unit >= 0x202a && unit <= 0x202e) // bidi embeddings and overrides
    || (unit >= 0x2066 && unit <= 0x2069) // bidi isolates
    || isHighSurrogate(unit) || isLowSurrogate(unit); // reached only when unpaired
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

// An error's message reaches the journal through the console sink's rendering
// of the error object — the stack's first line carries the message raw, and
// the cause chain after it. Forge-supplied text can ride any message in that
// chain, so a thrown value rendered for a log line gets the same treatment as
// any other log field: one bounded single-line token per message, the chain
// flattened onto the same line, and nothing raw anywhere in the output.
//
// The chain walk follows `cause` (Error and plain objects alike), is bounded
// in depth so a deep chain cannot flood the line, and carries a visited set so
// a constructed cycle cannot loop it. Every segment render and the cause read
// itself are guarded, because a thrown value can be a Proxy or carry getters
// that refuse access — a reason that cannot be read still leaves the line.

const MAX_ERROR_CAUSE_DEPTH = 5;
const CHAIN_CONTINUES = "…";

export function errorLogToken(value: unknown): string {
  // The thrown value itself always renders; only a missing cause ends the
  // chain, so a thrown null or undefined still gets its logField rendering.
  const segments: string[] = [errorSegment(value)];
  const visited = new Set<unknown>([value]);
  let current = causeOf(value);
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    if (current === null || current === undefined) return segments.join("; ");
    if (visited.has(current)) {
      segments.push(CHAIN_CONTINUES);
      return segments.join("; ");
    }
    visited.add(current);
    segments.push(errorSegment(current));
    current = causeOf(current);
  }
  // The cap is reached with a live cause: the line names that the chain
  // continues beyond what it carries.
  if (current !== null && current !== undefined) segments.push(CHAIN_CONTINUES);
  return segments.join("; ");
}

function errorSegment(value: unknown): string {
  try {
    if (value instanceof Error) {
      // The name is class-controlled in practice but is an own property any
      // constructor can set to arbitrary text, so it is encoded like the
      // message — nothing in the token is raw.
      const name = typeof value.name === "string" && value.name !== "" ? value.name : "Error";
      const message = typeof value.message === "string" ? value.message : String(value.message);
      return `${logField(name)}: ${logField(message)}`;
    }
    return logField(String(value));
  } catch {
    return "\"<unrenderable>\"";
  }
}

function causeOf(value: unknown): unknown {
  try {
    return (value as { cause?: unknown }).cause;
  } catch {
    return undefined;
  }
}
