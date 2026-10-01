import { describe, expect, it } from "vitest";
import { listen, useLoopbackListeners } from "../support/loopback-listener";
import {
  denyCidrsEnvName,
  expectRefused,
  hostPublicAddresses,
  reachedResponder,
  urlHost,
  useDeploymentDenyCidrs,
} from "../support/public-destination-harness";

/**
 * The identity link's default transport (issue 905), at the boundary
 * `src/lib/forge/identities.ts` reaches for: what it refuses before it opens a
 * socket, and the size of the answers it will hold.
 *
 * The harness — the deny-list environment's lifecycle, the host addresses a
 * case may bind to, the refusal assertion — is `tests/support`, shared with
 * `public-destination-deployment.test.ts`; that suite owns the host's own
 * address refusal, which is this same wiring seen from the deployment side.
 */

/** The cap the identity link sizes its small JSON answers at. */
const bodyLimit = 1024 * 1024;

/** A deny entry naming nothing local, so the host's own address stays admissible. */
const unrelatedDenyEntry = "8.8.8.8";

useDeploymentDenyCidrs();
useLoopbackListeners();

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
    const listener = await listen("127.0.0.1", reachedResponder);
    const { identityLinkFetch, DestinationRefusedError: RefusedError } = await loadIdentityLinkFetch();

    await expectRefused(identityLinkFetch(`http://127.0.0.1:${listener.port}/`), RefusedError);

    // The refusal is the guard's, decided from the address: the listener the
    // request would have reached saw no connection at all.
    expect(listener.connections).toBe(0);
  });

  it("holds a body of exactly its own 1 MiB cap", async (context) => {
    const host = hostPublicAddresses()[0];
    if (host === undefined) {
      context.skip();
      return;
    }
    const answer = Buffer.alloc(bodyLimit, 0x61);
    process.env[denyCidrsEnvName] = unrelatedDenyEntry;
    const listener = await listen(host, (_request, response) => {
      response.end(answer);
    });
    const { identityLinkFetch } = await loadIdentityLinkFetch();

    const response = await identityLinkFetch(`http://${urlHost(host)}:${listener.port}/`);

    // The bytes themselves, not a length: a transport that truncated to the cap
    // would still answer with this many bytes.
    expect(Buffer.from(await response.arrayBuffer())).toEqual(answer);
    expect(listener.connections).toBe(1);
  });

  it("refuses a body one byte over its cap", async (context) => {
    const host = hostPublicAddresses()[0];
    if (host === undefined) {
      context.skip();
      return;
    }
    process.env[denyCidrsEnvName] = unrelatedDenyEntry;
    const listener = await listen(host, (_request, response) => {
      response.end(Buffer.alloc(bodyLimit + 1, 0x61));
    });
    const { identityLinkFetch, DestinationRefusedError: RefusedError } = await loadIdentityLinkFetch();

    await expectRefused(identityLinkFetch(`http://${urlHost(host)}:${listener.port}/`), RefusedError);

    // The destination was reached and answered in full; what was refused is the
    // body, so the transport asked for it and then dropped it.
    expect(listener.connections).toBe(1);
  });
});
