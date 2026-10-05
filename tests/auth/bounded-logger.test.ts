import { describe, expect, it } from "vitest";
import { AUTH_ERROR_LOG_LINE_MAX, boundedAuthErrorLine, truncateBoundedLine } from "@/lib/auth/bounded-logger";

/**
 * The bounded-line encoder for @auth/core errors, unit-pinned at its
 * adversarial edges. The end-to-end wiring (that the real NextAuth handlers
 * actually use it) lives in tests/auth/undecryptable-session-logging.test.ts;
 * this file pins what the line may carry for inputs the real path could
 * produce, including hostile ones: a cause message of any length, ANSI and
 * bidi escapes, control characters, stack frames, and cookie material.
 */

/** An @auth/core AuthError shape: name = class name, cause carries `err`. */
function authShapedError(inner: Error, className = "JWTSessionError"): Error {
  const error = new Error(`Read more at https://errors.authjs.dev#${className.toLowerCase()}`);
  error.name = className;
  (error as Error & { cause: unknown }).cause = { err: inner };
  return error;
}

/**
 * A V8 stack frame, joined inline into a single line: ` at fn (file:1:2)` or
 * ` at file:1:2`. Tighter than a bare " at " probe, which a future legitimate
 * message like "failed at step (3)" would false-positive on: a frame needs a
 * location with `:line:column` inside or after its shape to match.
 */
function stackFrame(text: string): boolean {
  return /\s+at\s+[^\s(]+\s*\([^)]*:\d+:\d+\s*\)/.test(text)
    || /\s+at\s+[^()\s]+:\d+:\d+/.test(text);
}

/** No C0, no DEL/C1, no line or paragraph separator anywhere in the text. */
function firstControlCharacter(text: string): string | undefined {
  return [...text].find((character) => {
    const unit = character.codePointAt(0)!;
    return unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029;
  });
}

describe("boundedAuthErrorLine", () => {
  it("names the error class and the underlying cause on one printable line", () => {
    const inner = new Error("\u001b[31mInvalid Compact JWE\u001b[0m");
    const line = boundedAuthErrorLine(authShapedError(inner));

    expect(line).toContain("JWTSessionError");
    expect(line).toContain("Invalid Compact JWE");
    expect(firstControlCharacter(line), `control character in ${JSON.stringify(line)}`).toBeUndefined();
  });

  it("keeps a pathologically long, escape-laden cause inside the documented cap", () => {
    const inner = new Error(
      `\u001b[31m${"x".repeat(10_000)}\u001b[0m  bidirectional‮ tail`,
    );
    const line = boundedAuthErrorLine(authShapedError(inner));

    expect(line.length).toBeLessThanOrEqual(AUTH_ERROR_LOG_LINE_MAX);
    expect(firstControlCharacter(line), `control character in ${JSON.stringify(line)}`).toBeUndefined();
    // The bounded tail keeps the truncation visible instead of silently cut.
    expect(line).toMatch(/…|more/);
  });

  it("pins the documented cap at 512 code units", () => {
    // The one place the value itself is asserted, so a deliberate change of
    // the documented cap fails loudly instead of drifting silently.
    expect(AUTH_ERROR_LOG_LINE_MAX).toBe(512);
  });

  it("carries no stack-trace text from the error or its cause", () => {
    const inner = new Error("no matching decryption secret");
    inner.stack = "Error: no matching decryption secret\n    at decode (jwt.js:10:15)\n    at Object.decode (session.js:22:9)";
    const error = authShapedError(inner);
    error.stack = "JWTSessionError: Read more\n    at session (actions/session.js:59:26)";

    const line = boundedAuthErrorLine(error);

    expect(stackFrame(line), `stack frame in ${JSON.stringify(line)}`).toBe(false);
    expect(line).not.toContain("session.js:59");
    expect(line).not.toContain("jwt.js:10");
  });

  it("carries no cookie material for the real undecryptable-session shapes", () => {
    const random = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const sentinel = `sentinel-${random}-tail`;
    const fragments = [
      sentinel.slice(0, 16),
      sentinel.slice(Math.floor(sentinel.length / 2) - 8, Math.floor(sentinel.length / 2) + 8),
      sentinel.slice(-16),
    ];
    // The cookie's value reaches no Auth.js error on the undecryptable path:
    // @auth/core hands the token to jose, which fails decryption with fixed
    // messages and never echoes the token into them (verified against the
    // installed version), and the end-to-end suite proves the same through
    // the real handlers for both the garbage and the wrong-secret cookie.
    // The line built from those shapes must not carry the sentinel either.
    const garbage = authShapedError(new Error("Invalid Compact JWE"));
    const wrongSecret = authShapedError(new Error("no matching decryption secret"));
    for (const error of [garbage, wrongSecret]) {
      const line = boundedAuthErrorLine(error);

      expect(line).not.toContain(sentinel);
      for (const fragment of fragments) {
        expect(line).not.toContain(fragment);
      }
    }
  });

  it("escapes every control character a hostile cause message carries", () => {
    const inner = new Error("a\u0000b\u0007c\u001bd\te\u000ff g h\u001ci");
    const line = boundedAuthErrorLine(authShapedError(inner));

    expect(firstControlCharacter(line), `control character in ${JSON.stringify(line)}`).toBeUndefined();
    // The kept text stays readable: each control is a visible \uXXXX escape.
    expect(line).toContain("\\u001b");
  });

  it("logs a bounded line for a thrown value that is not an Error", () => {
    for (const thrown of ["a bare string", 42, undefined, { "not": "an error" }]) {
      const line = boundedAuthErrorLine(thrown);

      expect(line.length).toBeLessThanOrEqual(AUTH_ERROR_LOG_LINE_MAX);
      expect(firstControlCharacter(line), `control character in ${JSON.stringify(line)}`).toBeUndefined();
      expect(line).toContain("[auth][error]");
    }
  });

  it("logs a bounded line for a plain Error with no Auth.js cause", () => {
    const plain = new Error("callback threw");
    const line = boundedAuthErrorLine(plain);

    expect(line).toContain("Error");
    expect(line.length).toBeLessThanOrEqual(AUTH_ERROR_LOG_LINE_MAX);
    expect(firstControlCharacter(line)).toBeUndefined();
  });
});

/**
 * The hard cap, exercised directly: it is live code, not a removable
 * backstop — logField keeps 256 input units but each escapable unit becomes
 * a 6-unit escape in the line, so an escape-dense cause composes past
 * AUTH_ERROR_LOG_LINE_MAX (a real-module probe measured 507 units out,
 * truncated). These lines pin what the cut may leave behind.
 */
describe("truncateBoundedLine", () => {
  /** A trailing partial escape: a lone `\`, or `\u` with fewer than four hex digits. */
  function hasPartialEscape(text: string): boolean {
    return /\\u?[0-9a-fA-F]{0,3}$/.test(text);
  }

  /** A high surrogate without its low partner, or a low without its high. */
  function firstLoneSurrogate(text: string): string | undefined {
    for (let index = 0; index < text.length; index += 1) {
      const unit = text.charCodeAt(index);
      const previous = index > 0 ? text.charCodeAt(index - 1) : 0;
      if (unit >= 0xdc00 && unit <= 0xdfff && !(previous >= 0xd800 && previous <= 0xdbff)) {
        return text[index];
      }
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = index + 1 < text.length ? text.charCodeAt(index + 1) : 0;
        if (!(next >= 0xdc00 && next <= 0xdfff)) return text[index];
      }
    }
    return undefined;
  }

  /** Every `(+` in the text must begin a complete logField truncation marker. */
  function hasPartialMarker(text: string): boolean {
    const open = text.indexOf("(+");
    return open !== -1 && !/^\(\+\d+ more\)/.test(text.slice(open));
  }

  it("keeps a boundary-straddling backslash-u escape whole", () => {
    const line = "x".repeat(509) + "\\u00e9" + "tail";
    expect(line.length).toBeGreaterThan(AUTH_ERROR_LOG_LINE_MAX);

    const truncated = truncateBoundedLine(line);

    expect(truncated.length).toBeLessThanOrEqual(AUTH_ERROR_LOG_LINE_MAX);
    expect(truncated.endsWith("…"), `no closing ellipsis: ${JSON.stringify(truncated)}`).toBe(true);
    expect(
      hasPartialEscape(truncated.slice(0, -1)),
      `partial escape in ${JSON.stringify(truncated)}`,
    ).toBe(false);
  });

  it("never splits a surrogate pair at the cut", () => {
    const line = "x".repeat(511) + "\u{1d11e}" + "y".repeat(8);

    const truncated = truncateBoundedLine(line);

    expect(truncated.length).toBeLessThanOrEqual(AUTH_ERROR_LOG_LINE_MAX);
    expect(
      firstLoneSurrogate(truncated),
      `lone surrogate in ${JSON.stringify(truncated)}`,
    ).toBeUndefined();
  });

  it("drops the logField truncation marker whole instead of leaving a fragment", () => {
    const line = "x".repeat(500) + "… (+123 more)" + "y".repeat(10);

    const truncated = truncateBoundedLine(line);

    expect(truncated.length).toBeLessThanOrEqual(AUTH_ERROR_LOG_LINE_MAX);
    expect(
      hasPartialMarker(truncated),
      `partial marker in ${JSON.stringify(truncated)}`,
    ).toBe(false);
  });

  it("leaves a short line untouched", () => {
    const line = '[auth][error] "JWTSessionError: Invalid Compact JWE"';
    expect(truncateBoundedLine(line)).toBe(line);
  });
});
