import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP, Socket } from "node:net";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { isPublicAddress } from "@/lib/security/public-destination";

/**
 * Shared fixtures for the transports built on `createPublicFetch`, which judge
 * a destination from the environment when their module evaluates: the deny-list
 * environment's own lifecycle, the public addresses that stand in for the
 * host's own and the route that carries them to a loopback listener, and the
 * guard's one refusal class.
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
 * Public addresses that stand in for the deployment host's own, one per
 * family. The address class admits both, so on a guarded transport only a
 * deny list can refuse them — which is what lets a deny-list case fail when
 * the deny list stops applying. Neither is ever dialled: under
 * `usePublicStandInRoute` a connection to one reaches a loopback listener
 * instead, which is what the host's own address did by self-connecting, and
 * needs no public interface on the machine running the tests. The IPv6 one is
 * in 3fff::/20, documentation space the address class does not single out.
 */
export const publicStandIns = { ipv4: "1.2.3.4", ipv6: "3fff::1" } as const;

const standInAddresses: readonly string[] = Object.values(publicStandIns);
const loopbackAddresses: readonly string[] = ["127.0.0.1", "::1"];

/** Where the route sends a stand-in: the IPv4 loopback, where the case's listener is bound. */
const routedTo = "127.0.0.1";

export type StandInRoute = {
  /** The stand-ins a transport went on to connect to, in order: the guard had admitted each. */
  dialled: string[];
};

/**
 * Carries every client connection to a public stand-in to the IPv4 loopback,
 * on the same port, for each test in the calling scope, so a case can bind its
 * listener to 127.0.0.1 and still address it by a public address. The route
 * sits outside the guard: an IP literal is rerouted only once the transport
 * asks to connect to it, and a resolved name only once the guarded lookup has
 * handed its answer back, so the guard always judges the stand-in itself.
 *
 * Any other destination that is neither loopback nor a stand-in fails the
 * connection rather than leaving the machine, so a case aimed here never
 * reaches the network whatever the guard decides.
 */
export function usePublicStandInRoute(): StandInRoute {
  const route: StandInRoute = { dialled: [] };
  let restore: (() => void) | undefined;

  beforeEach(() => {
    for (const standIn of standInAddresses) {
      if (!isPublicAddress(standIn)) {
        // A stand-in the class refuses is refused with the deny list disabled
        // too, so every deny-list case aimed at it would pass vacuously.
        throw new Error(`The public stand-in ${standIn} is not a public address; replace it with one the address class admits.`);
      }
    }
    route.dialled.length = 0;
    const original = Socket.prototype.connect;
    const spy = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
      // An http agent hands `connect` the normalized `[options, callback]`
      // pair; the options object is the agent's own copy, so it is rewritten
      // in place and the pair passes on untouched.
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      if (typeof first === "object" && first !== null) {
        routeConnection(first as RoutedOptions, route);
      }
      return (original as (...connectArgs: unknown[]) => Socket).apply(this, args);
    });
    restore = () => spy.mockRestore();
  });

  afterEach(() => {
    restore?.();
    restore = undefined;
  });

  return route;
}

type RoutedLookup = (
  hostname: string,
  options: object,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void;

type RoutedOptions = { host?: unknown; lookup?: RoutedLookup };

function routeConnection(options: RoutedOptions, route: StandInRoute): void {
  if (typeof options.host !== "string") {
    return;
  }
  if (isIP(options.host) === 0) {
    // A name: Node resolves it through the `lookup` the transport passed, and
    // connects to whatever that hands back. Route that answer.
    const lookup = options.lookup ?? (dnsLookup as unknown as RoutedLookup);
    options.lookup = (hostname, lookupOptions, callback) => {
      lookup(hostname, lookupOptions, (error, address, family) => {
        if (error) {
          callback(error, address, family);
          return;
        }
        const answers = typeof address === "string" ? [address] : address.map((entry) => entry.address);
        const unroutable = answers.find((answer) => !standInAddresses.includes(answer) && !loopbackAddresses.includes(answer));
        if (unroutable !== undefined) {
          callback(egressRefused(unroutable), address, family);
          return;
        }
        route.dialled.push(...answers.filter((answer) => standInAddresses.includes(answer)));
        const routed = answers.map((answer) => (standInAddresses.includes(answer) ? routedTo : answer));
        if (typeof address === "string") {
          callback(null, routed[0], isIP(routed[0]));
        } else {
          callback(null, routed.map((answer) => ({ address: answer, family: isIP(answer) })));
        }
      });
    };
    return;
  }
  if (standInAddresses.includes(options.host)) {
    route.dialled.push(options.host);
    options.host = routedTo;
    return;
  }
  if (!loopbackAddresses.includes(options.host)) {
    // An IP literal never reaches `lookup`, so failing the connection means
    // turning it into a name whose lookup fails: the error then arrives the
    // way any resolution failure does, after the request is listening for it.
    const refused = options.host;
    options.host = "egress-refused.invalid";
    options.lookup = (_hostname, _lookupOptions, callback) => {
      process.nextTick(() => callback(egressRefused(refused), ""));
    };
  }
}

function egressRefused(address: string): Error {
  return new Error(`The test harness refused to connect to ${address}: only loopback and the public stand-ins are routable here.`);
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
