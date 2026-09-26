/**
 * Outbound requests to a member-supplied GitLab instance URL must never reach
 * a loopback, private, link-local or otherwise non-public host on the
 * server's behalf. The transport here is a `fetch`-compatible function that
 * refuses such destinations.
 *
 * The check runs on the address the socket actually connects to, inside the
 * connection's own `lookup`, not on a separate resolution beforehand: a name
 * that answers public when checked and loopback when connected (DNS
 * rebinding) is therefore judged by the second answer. An IP-literal host
 * never reaches `lookup`, so a literal is judged before the request is made.
 * TLS still validates against the hostname; nothing is rewritten to an IP.
 *
 * Every refusal — a non-public address, any redirect, an oversize body —
 * rejects with the same `DestinationRefusedError`, whose message names
 * neither the address nor the rule that fired.
 */

import { lookup as dnsLookup } from "node:dns";
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// How long a pooled connection may sit idle before this side closes it; the
// global fetch's own idle bound is of the same order.
const idleSocketTimeoutMs = 4_000;

// Statuses the Response constructor refuses to pair with a body. 3xx never
// gets this far: it is refused as a redirect.
const nullBodyStatuses = new Set([204, 205]);

const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  nonPublicIpv4.addSubnet(network, prefix, "ipv4");
}

const globalUnicastIpv6 = new BlockList();
globalUnicastIpv6.addSubnet("2000::", 3, "ipv6");

const specialPurposeIpv6 = new BlockList();
for (const [network, prefix] of [
  // IANA special-purpose, including Teredo (2001::/32).
  ["2001::", 23],
  ["2001:db8::", 32],
  // 6to4, which tunnels to an embedded IPv4.
  ["2002::", 16],
] as const) {
  specialPurposeIpv6.addSubnet(network, prefix, "ipv6");
}

export class DestinationRefusedError extends Error {
  constructor() {
    super("The destination was refused.");
    this.name = "DestinationRefusedError";
  }
}

/**
 * Whether an IP address is a public destination. Anything that is not an IP
 * address — a hostname, an address with a port or a zone — is not public.
 * The bracketed form a URL host carries (`[::1]`) is accepted.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  switch (isIP(bare)) {
    case 4:
      return !nonPublicIpv4.check(bare, "ipv4");
    case 6:
      // Only 2000::/3 is global unicast. Everything outside it is refused,
      // which covers `::`, `::1`, unique-local, link-local, multicast, NAT64
      // and every IPv4-mapped or IPv4-compatible form: an embedded IPv4 never
      // passes as IPv6, whatever it embeds.
      return (
        !bare.includes("%") &&
        globalUnicastIpv6.check(bare, "ipv6") &&
        !specialPurposeIpv6.check(bare, "ipv6")
      );
    default:
      return false;
  }
}

type PublicFetchOptions = {
  /** Test seam: resolves hostnames in place of `dns.lookup`. */
  lookup?: typeof dnsLookup;
  /** Test seam: decides which addresses may be connected to. */
  isPermittedAddress?: (address: string) => boolean;
  /** The most response body read before refusing; each caller sizes it to its answers. */
  maxBodyBytes: number;
};

export function createPublicFetch(options: PublicFetchOptions): typeof fetch {
  const lookup = options.lookup ?? dnsLookup;
  const isPermittedAddress = options.isPermittedAddress ?? isPublicAddress;
  const { maxBodyBytes } = options;
  // Agents of this transport's own, so a pooled keep-alive socket is only ever
  // one whose address this transport's guard approved. An idle pooled socket
  // is closed after a few seconds rather than whenever the remote chooses:
  // the member picks the host, and one that never closes would otherwise hold
  // our descriptors open indefinitely. Node applies this only to idle sockets;
  // a request in flight is bounded by its caller's signal.
  const agentOptions = { keepAlive: true, timeout: idleSocketTimeoutMs };
  const httpAgent = new HttpAgent(agentOptions);
  const httpsAgent = new HttpsAgent(agentOptions);

  async function guardedFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    if (input instanceof Request) {
      throw new TypeError("A Request input is not supported; pass the URL and an init object.");
    }
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new DestinationRefusedError();
    }
    const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
    if (isIP(hostname) !== 0 && !isPermittedAddress(hostname)) {
      throw new DestinationRefusedError();
    }

    const body = init.body ?? undefined;
    if (body !== undefined && typeof body !== "string") {
      throw new TypeError("Only a string request body is supported.");
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    if (body !== undefined) {
      headers["content-length"] = String(Buffer.byteLength(body));
    }

    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();

    return new Promise<Response>((resolve, reject) => {
      let settled = false;

      const guardedLookup: LookupFunction = (host, lookupOptions, callback) => {
        lookup(host, lookupOptions, (error, address, family) => {
          if (error) {
            callback(error, address, family);
            return;
          }
          // Node asks for every address (`all: true`) when it may try several;
          // one non-public address among them refuses the whole answer.
          const addresses = typeof address === "string" ? [address] : address.map((entry) => entry.address);
          if (addresses.length === 0 || !addresses.every((candidate) => isPermittedAddress(candidate))) {
            callback(new DestinationRefusedError(), address, family);
            return;
          }
          callback(null, address, family);
        });
      };

      const request: ClientRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: url.protocol,
        hostname,
        port: url.port === "" ? undefined : url.port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        agent: url.protocol === "https:" ? httpsAgent : httpAgent,
        lookup: guardedLookup,
      });

      const onAbort = () => fail(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });

      function fail(error: unknown): void {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        request.destroy();
        reject(error);
      }

      function succeed(response: Response): void {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        resolve(response);
      }

      // A refusal from the guarded lookup arrives here unchanged: Node destroys
      // the socket with the error the lookup handed back.
      request.on("error", fail);

      request.on("response", (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        // Node's client never follows a redirect; handing the 3xx back would
        // let a caller follow it. Any 3xx is a refusal.
        if (status >= 300 && status < 400) {
          fail(new DestinationRefusedError());
          return;
        }

        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBodyBytes) {
            fail(new DestinationRefusedError());
            return;
          }
          chunks.push(chunk);
        });
        // A connection cut short mid-body surfaces here (Node emits it only
        // when a listener exists); without it the promise would never settle.
        response.on("error", fail);
        response.on("end", () => {
          try {
            const responseHeaders = new Headers();
            for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
              responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
            }
            succeed(
              new Response(nullBodyStatuses.has(status) ? null : new Uint8Array(Buffer.concat(chunks)), {
                status,
                statusText: response.statusMessage,
                headers: responseHeaders,
              }),
            );
          } catch (error) {
            fail(error);
          }
        });
      });

      request.end(body);
    });
  }

  return guardedFetch as typeof fetch;
}
