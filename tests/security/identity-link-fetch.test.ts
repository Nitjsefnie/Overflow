import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress } from "@/lib/security/public-destination";

/**
 * The identity link's default transport (issue 905), at the boundary
 * `src/lib/forge/identities.ts` reaches for: what it refuses before it opens a
 * socket, and the size of the answers it will hold.
 *
 * The singleton reads the environment when its module evaluates, so every case
 * resets the module registry and (re)imports after arranging the environment.
 * A destination the guard admits must also route locally for these cases to
 * stay network-free, and only the host's own public address does — a
 * self-connect answers over loopback. The deny list is therefore overridden
 * with an entry that does not name the host, as
 * `public-destination-deployment.test.ts` does; that suite owns the host's own
 * address refusal, which is this same wiring seen from the deployment side.
 */

const envName = "PUBLIC_DESTINATION_DENY_CIDRS";

/** The cap the identity link sizes its small JSON answers at. */
const bodyLimit = 1024 * 1024;

/** A deny entry naming nothing local, so the host's own address stays admissible. */
const unrelatedDenyEntry = "8.8.8.8";

const openListeners: { close(): Promise<void> }[] = [];

let ambientEnvValue: string | undefined;

beforeEach(() => {
  vi.resetModules();
  ambientEnvValue = process.env[envName];
  delete process.env[envName];
});

afterEach(async () => {
  if (ambientEnvValue === undefined) {
    delete process.env[envName];
  } else {
    process.env[envName] = ambientEnvValue;
  }
  await Promise.all(openListeners.splice(0).map((listener) => listener.close()));
  vi.resetModules();
});

/**
 * The host's own public interface addresses — the ones the address class
 * admits and the ones the unset-environment seed names. Empty where the host
 * has none (a CI runner behind private interfaces), which skips the cases
 * below: an answer the guard permits must arrive from a real destination, and
 * only the host's own public address both qualifies and routes locally.
 */
function hostPublicAddresses(): string[] {
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
function urlHost(address: string): string {
  return isIP(address) === 6 ? `[${address}]` : address;
}

type Listener = { port: number; connections(): number; close(): Promise<void> };

async function listenOn(
  host: string,
  respond: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.end("reached");
  },
): Promise<Listener> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    respond(request, response);
  });
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("listener has no port");
  }
  const listener: Listener = {
    port: address.port,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  openListeners.push(listener);
  return listener;
}

/** Awaits a rejection and pins it as the guard's one refusal class. */
async function expectRefused(pending: Promise<unknown>, refused: new () => Error): Promise<void> {
  const outcome = await pending.then(
    () => "resolved" as const,
    (error: unknown) => error,
  );
  expect(outcome).not.toBe("resolved");
  expect(outcome).toBeInstanceOf(refused);
}

/**
 * The singleton and the refusal class from one and the same evaluation: after
 * the registry reset the singleton re-evaluates its whole import graph, so the
 * statically imported class is a different class identity and `instanceof`
 * across the two registries is always false.
 */
async function loadIdentityLinkFetch(): Promise<{
  identityLinkFetch: typeof fetch;
  DestinationRefusedError: new () => Error;
}> {
  const identity = await import("@/lib/security/identity-link-fetch");
  const guard = await import("@/lib/security/public-destination");
  return {
    identityLinkFetch: identity.identityLinkFetch,
    DestinationRefusedError: guard.DestinationRefusedError,
  };
}

describe("the identity link's default transport", () => {
  it("refuses a non-public destination without connecting to it", async () => {
    const listener = await listenOn("127.0.0.1");
    const { identityLinkFetch, DestinationRefusedError: RefusedError } = await loadIdentityLinkFetch();

    await expectRefused(identityLinkFetch(`http://127.0.0.1:${listener.port}/`), RefusedError);

    // The refusal is the guard's, decided from the address: the listener the
    // request would have reached saw no connection at all.
    expect(listener.connections()).toBe(0);
  });

  it("holds a body of exactly its own 1 MiB cap", async (context) => {
    const host = hostPublicAddresses()[0];
    if (host === undefined) {
      context.skip();
      return;
    }
    const answer = Buffer.alloc(bodyLimit, 0x61);
    process.env[envName] = unrelatedDenyEntry;
    const listener = await listenOn(host, (_request, response) => {
      response.end(answer);
    });
    const { identityLinkFetch } = await loadIdentityLinkFetch();

    const response = await identityLinkFetch(`http://${urlHost(host)}:${listener.port}/`);

    // The bytes themselves, not a length: a transport that truncated to the cap
    // would still answer with this many bytes.
    const received = Buffer.from(await response.arrayBuffer());
    expect(received.equals(answer)).toBe(true);
    expect(listener.connections()).toBe(1);
  });

  it("refuses a body one byte over its cap", async (context) => {
    const host = hostPublicAddresses()[0];
    if (host === undefined) {
      context.skip();
      return;
    }
    process.env[envName] = unrelatedDenyEntry;
    const listener = await listenOn(host, (_request, response) => {
      response.end(Buffer.alloc(bodyLimit + 1, 0x61));
    });
    const { identityLinkFetch, DestinationRefusedError: RefusedError } = await loadIdentityLinkFetch();

    await expectRefused(identityLinkFetch(`http://${urlHost(host)}:${listener.port}/`), RefusedError);

    // The destination was reached and answered in full; what was refused is the
    // body, so the transport asked for it and then dropped it.
    expect(listener.connections()).toBe(1);
  });
});