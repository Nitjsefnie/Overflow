import { describe, expect, it } from "vitest";
import { AUTH_ERROR_LOG_LINE_MAX, boundedAuthErrorLine } from "@/lib/auth/bounded-logger";

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
    expect(line.length).toBeLessThanOrEqual(512);
    expect(firstControlCharacter(line), `control character in ${JSON.stringify(line)}`).toBeUndefined();
    // The bounded tail keeps the truncation visible instead of silently cut.
    expect(line).toMatch(/…|more/);
  });

  it("carries no stack-trace text from the error or its cause", () => {
    const inner = new Error("no matching decryption secret");
    inner.stack = "Error: no matching decryption secret\n    at decode (jwt.js:10:15)\n    at Object.decode (session.js:22:9)";
    const error = authShapedError(inner);
    error.stack = "JWTSessionError: Read more\n    at session (actions/session.js:59:26)";

    const line = boundedAuthErrorLine(error);

    expect(/\s at \s/.test(line), `stack frame in ${JSON.stringify(line)}`).toBe(false);
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
