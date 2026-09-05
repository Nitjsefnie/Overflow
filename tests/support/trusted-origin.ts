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
 * The request shapes a guarded route must accept and refuse, bound to one
 * route's URL. Building them here keeps the header spellings the guard reads in
 * one place instead of once per route test file.
 */
export function guardedRequests(url: string) {
  const json = (body: unknown, method = "POST", headers: Record<string, string> = {}): Request =>
    new Request(url, {
      method,
      headers: { origin: trustedOrigin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  return {
    json,
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
  for (const [name, dependency] of Object.entries(dependencies)) {
    expect(dependency, `${name} was called`).not.toHaveBeenCalled();
  }
}
