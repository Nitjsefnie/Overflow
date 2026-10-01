import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPublicAddress } from "@/lib/security/public-destination";

/**
 * The deployment seeding of the outbound fetch guard (issue 899): what
 * `PUBLIC_DESTINATION_DENY_CIDRS` contributes and what the two wired
 * singletons do with it. The singletons read the environment when their module
 * evaluates, so every case resets the module registry and (re)imports after
 * arranging the environment — that is also what makes a wiring regression
 * observable: unwire the deny composition and the acceptance fixture below
 * connects to its own listener instead of refusing it.
 */

const envName = "PUBLIC_DESTINATION_DENY_CIDRS";

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
 * admits, and the ones the unset-environment seed names. Empty where the host
 * has none (a CI runner behind private interfaces), which skips the
 * public-address fixtures below: a destination the class permits must route
 * locally for the test to stay network-free, and only the host's own public
 * address does — a self-connect answers over loopback.
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

async function listenOn(host: string): Promise<Listener> {
  const server: Server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.end("reached");
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

async function loadDeploymentDenyCidrs(): Promise<(env?: NodeJS.ProcessEnv) => string[]> {
  const module = await import("@/lib/security/public-destination-deployment");
  return module.deploymentDenyCidrs;
}

async function loadSingletons(): Promise<{
  gitlabApiFetch: typeof fetch;
  identityLinkFetch: typeof fetch;
  DestinationRefusedError: new () => Error;
}> {
  // The singletons re-evaluate their whole import graph after the registry
  // reset, so the refusal class this file pins must come from that same fresh
  // evaluation: the statically imported one is a different class identity, and
  // `instanceof` across the two registries is always false.
  const gitlab = await import("@/lib/security/gitlab-api-fetch");
  const identity = await import("@/lib/security/identity-link-fetch");
  const guard = await import("@/lib/security/public-destination");
  return {
    gitlabApiFetch: gitlab.gitlabApiFetch,
    identityLinkFetch: identity.identityLinkFetch,
    DestinationRefusedError: guard.DestinationRefusedError,
  };
}

describe("deploymentDenyCidrs", () => {
  it("seeds the host's public interface addresses when the environment is unset", async () => {
    const hostPublic = hostPublicAddresses();
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    const entries = deploymentDenyCidrs();

    expect(entries.sort()).toEqual([...hostPublic].sort());
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      expect(isPublicAddress(entry)).toBe(true);
    }
  });

  it("honours the environment's entries exactly, trimmed", async () => {
    process.env[envName] = " 8.8.8.8 , 1.1.1.1/24 , 2001:db8::/32 ";
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    expect(deploymentDenyCidrs()).toEqual(["8.8.8.8", "1.1.1.1/24", "2001:db8::/32"]);
  });

  it("skips empty items between commas", async () => {
    process.env[envName] = "8.8.8.8,,1.1.1.1,";
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    expect(deploymentDenyCidrs()).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  it("parses an empty value as the explicit opt-out", async () => {
    process.env[envName] = "";
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    expect(deploymentDenyCidrs()).toEqual([]);
  });

  it.each([
    ["nonsense"],
    ["8.8.8.8/33"],
    ["300.1.2.3"],
    ["2001:db8::/129"],
  ])("throws on the invalid entry list %j", async (value) => {
    process.env[envName] = value;
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    expect(() => deploymentDenyCidrs()).toThrow();
  });
});

describe("the deployment-wired singletons", () => {
  it("refuse a fetch to the host's own public address", async (context) => {
    const host = hostPublicAddresses()[0];
    if (host === undefined) {
      context.skip();
      return;
    }
    const listener = await listenOn(host);
    const { gitlabApiFetch, identityLinkFetch, DestinationRefusedError: RefusedError } = await loadSingletons();

    await expectRefused(gitlabApiFetch(`http://${urlHost(host)}:${listener.port}/`), RefusedError);
    await expectRefused(identityLinkFetch(`http://${urlHost(host)}:${listener.port}/`), RefusedError);
    expect(listener.connections()).toBe(0);
  });

  it("complete a fetch to a public destination the deny list does not name", async (context) => {
    const host = hostPublicAddresses()[0];
    if (host === undefined) {
      context.skip();
      return;
    }
    // An override that does not name the host: the wiring must carry the
    // environment's list into the transports without broadening it.
    process.env[envName] = "8.8.8.8";
    const listener = await listenOn(host);
    const { gitlabApiFetch } = await loadSingletons();

    const response = await gitlabApiFetch(`http://${urlHost(host)}:${listener.port}/`);

    expect(await response.text()).toBe("reached");
    expect(listener.connections()).toBe(1);
  });
});
