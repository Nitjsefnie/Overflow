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

async function loadDeploymentDenyCidrs(): Promise<
  (env?: NodeJS.ProcessEnv, enumerateInterfaces?: typeof networkInterfaces) => string[]
> {
  const module = await import("@/lib/security/public-destination-deployment");
  return module.deploymentDenyCidrs;
}

/**
 * An interface enumerator as the hardened serving unit sees one: the unit's
 * `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` denies AF_NETLINK, libuv's
 * enumeration socket, so `os.networkInterfaces()` throws this system error in
 * every serving process (issue 924) while succeeding for an unsandboxed root.
 */
function restrictedEnumerator(): ReturnType<typeof networkInterfaces> {
  throw Object.assign(new Error("A system error occurred: uv_interface_addresses returned Unknown system error 97"), {
    code: "EAFNOSUPPORT",
    errno: -97,
    syscall: "uv_interface_addresses",
  });
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
  it("seeds the host's public interface addresses through the injected enumerator when the environment is unset", async () => {
    const hostPublic = hostPublicAddresses();
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    const entries = deploymentDenyCidrs(process.env, networkInterfaces);

    expect(entries.sort()).toEqual([...hostPublic].sort());
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      expect(isPublicAddress(entry)).toBe(true);
    }
  });

  it("degrades to the environment's entries alone when interface enumeration is unavailable", async () => {
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();

    // The environment is unset here, so the deny list is empty: a
    // defense-in-depth default that cannot be discovered degrades to the
    // env-driven list instead of killing module evaluation (issue 924).
    expect(deploymentDenyCidrs(process.env, restrictedEnumerator)).toEqual([]);
  });

  it("warns once, naming the environment variable, when interface enumeration is unavailable", async () => {
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Copied before the restore: vitest's mockRestore resets the call
    // history, so the recorded calls must be out of the mock by then.
    let warnings: unknown[][] = [];

    try {
      expect(deploymentDenyCidrs(process.env, restrictedEnumerator)).toEqual([]);
      warnings = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("PUBLIC_DESTINATION_DENY_CIDRS");
  });

  it("never consults interface enumeration when the environment supplies the entries", async () => {
    process.env[envName] = "8.8.8.8";
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();
    const enumerator = vi.fn(restrictedEnumerator);

    expect(deploymentDenyCidrs(process.env, enumerator)).toEqual(["8.8.8.8"]);
    // The value alone would survive a mutant that hoists the enumeration
    // above the env branch; the non-consultation is the contract.
    expect(enumerator).not.toHaveBeenCalled();
  });

  it("degrades the same way for any enumeration failure, not only the address-family one", async () => {
    const deploymentDenyCidrs = await loadDeploymentDenyCidrs();
    // A different system error from the same call: a unit whose sandbox
    // answers EPERM (or anything else) re-opens the startup crash if the
    // degradation ever narrows to one errno.
    const denied = (): ReturnType<typeof networkInterfaces> => {
      throw Object.assign(new Error("A system error occurred: uv_interface_addresses returned Unknown system error 1"), {
        code: "EPERM",
        errno: -1,
        syscall: "uv_interface_addresses",
      });
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let warnings: unknown[][] = [];

    try {
      expect(deploymentDenyCidrs(process.env, denied)).toEqual([]);
      warnings = warn.mock.calls.map((call) => [...call]);
    } finally {
      warn.mockRestore();
    }

    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain("PUBLIC_DESTINATION_DENY_CIDRS");
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
