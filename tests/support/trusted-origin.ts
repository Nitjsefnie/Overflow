import { afterEach, beforeEach, expect, vi } from "vitest";
import type { Mock } from "vitest";

/**
 * Shared fixtures for the cookie-authenticated mutation routes, every one of
 * which now refuses a request that does not come from the deployment's own
 * origin. `APP_URL` is unset in the test environment, so a route test that does
 * not stub it sees the misconfiguration refusal rather than the behaviour it
 * meant to exercise.
 */

export const trustedOrigin = "https://overflow.example";
export const foreignOrigin = "https://attacker.example";

/**
 * Stubs `APP_URL` for every test in the calling file and unstubs it afterwards,
 * so no test leaks its environment into the next one.
 *
 * Convention: call this once at module top level, never inside a `describe`.
 * Every guarded route in a file reads the same `APP_URL`, and a top-level call
 * covers each `describe` in the file, including ones added later.
 */
export function useTrustedOrigin(appUrl: string = trustedOrigin): void {
  beforeEach(() => {
    vi.stubEnv("APP_URL", appUrl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

/**
 * Every test request is addressed to this host, which is deliberately not the
 * trusted origin's host. The trusted origin comes from `APP_URL` and never from
 * the request's own URL, so a route that compared the `Origin` header against
 * `new URL(request.url).origin` would refuse every request built here. That
 * makes each file's ordinary happy-path tests pin the distinction for free —
 * without it, a route reading the request URL passes everything.
 */
export const requestHost = "https://overflow.internal";

/**
 * The request shapes a guarded route must accept and refuse, bound to one
 * route's path. Building them here keeps the header spellings the guard reads
 * in one place instead of once per route test file.
 */
export function guardedRequests(path: string) {
  const url = new URL(path, requestHost).toString();
  const json = (body: unknown, method = "POST", headers: Record<string, string> = {}): Request =>
    new Request(url, {
      method,
      headers: { origin: trustedOrigin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  return {
    url,
    json,
    // A foreign origin the guard must refuse on the origin alone. Prefer this
    // over foreignText when asserting the 403: a request that is also the wrong
    // media type would be refused by either half, so a test built on that one
    // cannot tell which half did the work.
    foreignJson: (body: unknown, method = "POST"): Request =>
      json(body, method, { origin: foreignOrigin }),
    foreignText: (body: unknown, method = "POST"): Request =>
      json(body, method, { origin: foreignOrigin, "content-type": "text/plain" }),
    trustedText: (body: unknown, method = "POST"): Request =>
      json(body, method, { "content-type": "text/plain" }),
  };
}

/**
 * The three dependencies every moderator-authorized route factory takes, as
 * mocks a refused request must never reach.
 */
export function unusedDependencies() {
  return { getSession: vi.fn(), getCurrentRole: vi.fn(), createService: vi.fn() };
}

/**
 * Asserting zero calls is the point of every rejection test: a forged request
 * costs no session read, no role lookup and no database work.
 */
export function expectNoDependencyCall(dependencies: Record<string, Mock>): void {
  const entries = Object.entries(dependencies);
  // Without this the helper passes on an empty object, so a caller that hands it
  // the wrong value asserts nothing and reads as a green rejection test.
  expect(entries.length, "expectNoDependencyCall was given no dependencies").toBeGreaterThan(0);

  for (const [name, dependency] of entries) {
    expect(dependency, `${name} was called`).not.toHaveBeenCalled();
  }
}
