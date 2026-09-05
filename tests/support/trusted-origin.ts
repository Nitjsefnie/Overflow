import { afterEach, beforeEach, vi } from "vitest";

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
 */
export function useTrustedOrigin(appUrl: string = trustedOrigin): void {
  beforeEach(() => {
    vi.stubEnv("APP_URL", appUrl);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });
}
