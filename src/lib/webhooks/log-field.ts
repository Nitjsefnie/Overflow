// A webhook delivery's identifiers — the receipt key, the execution UUID, the
// repository's full name — are request-derived text, and a parser accepts
// them with internal line breaks, terminal escapes and unbounded length. This
// helper turns one such string into a single bounded token for a log line, so
// an identifier can neither forge a second line, drive the operator's
// terminal, visually reorder the line, nor flood it.
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
