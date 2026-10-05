import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { encode } from "next-auth/jwt";
import { AUTH_ERROR_LOG_LINE_MAX } from "@/lib/auth/bounded-logger";

/**
 * The undecryptable-session log line, end to end against the installed
 * @auth/core: a request whose `authjs.session-token` cookie cannot be
 * decrypted — garbage bytes, or a JWE minted under a different secret — must
 * cost the service journal exactly ONE bounded line, and the request itself
 * must proceed anonymously (HTTP 200 with a null session, never a 5xx).
 *
 * The line must carry no ANSI or other control character, no stack-trace
 * text, and no fragment of the cookie's value. The @auth/core default logger
 * fails every one of those pins: it writes the error name, then the cause's
 * full multi-line stack, ANSI-coloured, per such request.
 *
 * Nothing of Auth.js is mocked. The real `GET` handler from `src/auth.ts`
 * (through `src/app/api/auth/[...nextauth]/route`) and the real `auth()` are
 * driven with the bad cookie, spying on the console methods @auth/core's
 * logger writes to, so this file exercises the actual NextAuth wiring: the
 * `logger` configuration on the NextAuth call is the lever that decides
 * which of the two logger behaviours a request sees. Next's request context
 * (`next/headers`) is stubbed, because there is no request outside a Next
 * server (the way tests/api/tokens-session-cookie.test.ts does it).
 *
 * The undecryptable-cookie path needs no database: with the JWT session
 * strategy the token fails to decrypt inside @auth/core, before the jwt
 * callback (and so before any account-store query) can run, and no adapter
 * is configured. No database is started in this file.
 */

// Dynamic route imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

const requestContext = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => requestContext.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const appUrl = "http://overflow.test";
const sessionCookieName = "authjs.session-token";
const authSecret = "undecryptable-session-logging-test-secret-not-for-production";
const wrongSecret = "undecryptable-session-logging-test-wrong-secret-not-for-production";

const originalAuthUrl = process.env.AUTH_URL;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;

let authRoute: typeof import("@/app/api/auth/[...nextauth]/route") | undefined;
let authModule: typeof import("@/auth") | undefined;

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubEnv("AUTH_GITHUB_ID", "undecryptable-session-logging-client-id");
  vi.stubEnv("AUTH_GITHUB_SECRET", "undecryptable-session-logging-client-secret");
  vi.stubEnv("AUTH_TRUST_HOST", "true");
  vi.stubEnv("APP_URL", appUrl);
  // Deliberately absent, as in tests/auth/session-cookie-content.test.ts:
  // with one set, next-auth rewrites the request origin through a NextRequest
  // before @auth/core reads it; with neither, the request's own origin is
  // what @auth/core sees, exactly like a request that actually arrives.
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;

  // A fresh graph, so @/auth reads this environment when the route first
  // loads it.
  vi.resetModules();
  authRoute = await import("@/app/api/auth/[...nextauth]/route");
  authModule = await import("@/auth");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  if (originalAuthUrl === undefined) {
    delete process.env.AUTH_URL;
  } else {
    process.env.AUTH_URL = originalAuthUrl;
  }
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
  }
});

/** Workers are reused across files (isolate: false): no console spy may survive this file. */
afterEach(() => {
  vi.restoreAllMocks();
});

/** A long unique printable value, unique per call, that no log line may carry. */
function uniqueSentinelCookieValue(): string {
  const random = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  return `sentinel-${random}-tail`;
}

/** The head, middle and tail slices of the sentinel — no fragment may reach the line. */
function sentinelFragments(sentinel: string): string[] {
  return [
    sentinel.slice(0, 16),
    sentinel.slice(Math.floor(sentinel.length / 2) - 8, Math.floor(sentinel.length / 2) + 8),
    sentinel.slice(-16),
  ];
}

interface ConsoleSpies {
  errorLines: string[][];
  warn: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

/** Captures what @auth/core's logger writes and silences it for the reporter. */
function spyOnConsole(): ConsoleSpies {
  const errorLines: string[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errorLines.push(args.map(String));
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return { errorLines, warn, log };
}

/**
 * The pins of the ruling, on the captured console traffic: exactly one
 * console.error call, one bounded line, no control character, no stack text,
 * none of the forbidden fragments. Returns the line for content pins.
 */
function assertSingleBoundedLine(errors: string[][], forbidden: string[]): string {
  expect(
    errors.length,
    `expected exactly one console.error call for the request, got ${errors.length}`,
  ).toBe(1);
  const line = errors[0]!.map(String).join(" ");
  expect(
    line.length <= AUTH_ERROR_LOG_LINE_MAX,
    `the line is ${line.length} code units, the cap is ${AUTH_ERROR_LOG_LINE_MAX}: ${JSON.stringify(line)}`,
  ).toBe(true);
  const offender = [...line].find((character) => {
    const unit = character.codePointAt(0)!;
    return unit < 0x20 || (unit >= 0x7f && unit <= 0x9f) || unit === 0x2028 || unit === 0x2029;
  });
  expect(
    offender,
    `control character 0x${offender === undefined ? "?" : offender.codePointAt(0)!.toString(16)} in the line: ${JSON.stringify(line)}`,
  ).toBeUndefined();
  for (const fragment of forbidden) {
    expect(
      line.includes(fragment),
      `the line carries forbidden text ${JSON.stringify(fragment)}: ${JSON.stringify(line)}`,
    ).toBe(false);
  }
  const stackText = stackFrame(line) || /node_modules|\.ts:|\.js:/.test(line);
  expect(stackText, `the line carries stack-trace text: ${JSON.stringify(line)}`).toBe(false);
  return line;
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

/** Drives the real route handler with the session cookie's value, as a browser would send it. */
async function driveSessionGet(cookieValue: string): Promise<Response> {
  const request = new Request(`${appUrl}/api/auth/session`, {
    headers: { cookie: `${sessionCookieName}=${cookieValue}` },
  });
  // next-auth's handler types name a NextRequest; @auth/core itself reads a
  // standard Request, and the runtime contract is the standard one.
  return authRoute!.GET(request as never);
}

describe("a request whose session cookie cannot be decrypted", () => {
  it("garbage bytes: logs one bounded line and proceeds anonymously", async () => {
    const sentinel = uniqueSentinelCookieValue();
    const spies = spyOnConsole();

    const response = await driveSessionGet(sentinel);

    const line = assertSingleBoundedLine(spies.errorLines, sentinelFragments(sentinel));
    expect(line, "the line must name the Auth.js error class").toContain("JWTSessionError");
    expect(response.status, "an undecryptable cookie must never cost a 5xx").toBe(200);
    expect(await response.json(), "an undecryptable cookie must read as no session").toBeNull();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("a JWE minted under a different secret: the same bounded line", async () => {
    const cookieValue = await encode({
      token: { sub: "wrong-secret-probe", name: "wrong-secret-probe" },
      secret: wrongSecret,
      salt: sessionCookieName,
    });
    const spies = spyOnConsole();

    const response = await driveSessionGet(cookieValue);

    const line = assertSingleBoundedLine(spies.errorLines, sentinelFragments(cookieValue));
    expect(line).toContain("JWTSessionError");
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("auth() with the same garbage cookie: one bounded line and a null session", async () => {
    const sentinel = uniqueSentinelCookieValue();
    // The RSC path derives the action URL and the session-cookie name from
    // these headers (createActionURL); without a forwarded host the URL is
    // https and @auth/core reads the __Secure- cookie name instead, silently
    // finding no session. A real Next request behind Cloudflare carries them.
    requestContext.headers = new Headers({
      cookie: `${sessionCookieName}=${sentinel}`,
      "x-forwarded-host": "overflow.test",
      "x-forwarded-proto": "http",
    });
    const spies = spyOnConsole();

    const session = await authModule!.auth();

    const line = assertSingleBoundedLine(spies.errorLines, sentinelFragments(sentinel));
    expect(line).toContain("JWTSessionError");
    expect(session, "an undecryptable cookie must read as no session").toBeNull();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });
});
