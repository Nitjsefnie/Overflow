import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { isPublicAddress } from "@/lib/security/public-destination";

/**
 * Shared fixtures for the transports built on `createPublicFetch`, which judge
 * a destination from the environment when their module evaluates: the deny-list
 * environment's own lifecycle, the host addresses a case may bind a listener
 * to, and the guard's one refusal class.
 *
 * Listeners come from `loopback-listener`, so a file using this needs
 * `useLoopbackListeners()` as well; this module owns the rest.
 */

/** The environment variable the deployment seeds the outbound guard from. */
export const denyCidrsEnvName = "PUBLIC_DESTINATION_DENY_CIDRS";

/**
 * Gives every test in the calling file a clean module registry and an unset
 * `PUBLIC_DESTINATION_DENY_CIDRS`, and restores both afterwards, so no test
 * leaks its environment or its module graph into the next one. A case that
 * wants the deny list set arranges it in the test body and re-imports after.
 *
 * Convention: call this once at module top level, never inside a `describe`.
 */
export function useDeploymentDenyCidrs(): void {
  let ambient: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    ambient = process.env[denyCidrsEnvName];
    delete process.env[denyCidrsEnvName];
  });

  afterEach(() => {
    if (ambient === undefined) {
      delete process.env[denyCidrsEnvName];
    } else {
      process.env[denyCidrsEnvName] = ambient;
    }
    vi.resetModules();
  });
}

/**
 * The host's own public interface addresses — the ones the address class
 * admits, and the ones the unset-environment seed names. Empty where the host
 * has none (a CI runner behind private interfaces), which skips the cases that
 * need one: a destination the class permits must route locally for the test to
 * stay network-free, and only the host's own public address does — a
 * self-connect answers over loopback.
 */
export function hostPublicAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (!entry.internal && isPublicAddress(entry.address)) {
        found.push(entry.address);
      }
    }
  }
  return [...new Set(found)];
}

/** Brackets an IPv6 literal for use as a URL host; passes anything else through. */
export function urlHost(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

/** Answers every request with the word a case can then assert on. */
export const reachedResponder = (_request: IncomingMessage, response: ServerResponse): void => {
  response.end("reached");
};

/** Awaits a rejection and pins it as the guard's one refusal class. */
export async function expectRefused(pending: Promise<unknown>, refused: new () => Error): Promise<void> {
  const outcome = await pending.then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  expect(outcome).not.toBe("resolved");
  expect(outcome).toBeInstanceOf(refused);
}
