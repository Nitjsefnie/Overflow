import type { lookup as dnsLookup, LookupAddress } from "node:dns";
import { once } from "node:events";
import {
  createServer,
  get as httpGet,
  globalAgent,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { getDefaultAutoSelectFamily, isIP, setDefaultAutoSelectFamily, type Socket } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicFetch,
  DestinationRefusedError,
  isPublicAddress,
} from "@/lib/security/public-destination";
import { hostPublicAddresses, urlHost } from "../support/public-destination-harness";

const bodyLimit = 1024 * 1024;

/** A transport with no test seams, so it judges addresses as production does, and a 1 MiB cap. */
const publicFetch = createPublicFetch({ maxBodyBytes: bodyLimit });

type RecordedRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

type Listener = {
  port: number;
  /** TCP connections accepted — a refusal must happen before any exists. */
  connections: number;
  /** The server side of every accepted connection, open or closed. */
  sockets: Socket[];
  requests: RecordedRequest[];
  server: Server;
  close(): Promise<void>;
};

const openListeners: Listener[] = [];

afterEach(async () => {
  await Promise.all(openListeners.splice(0).map((listener) => listener.close()));
});

async function listen(
  host: string,
  respond: (request: IncomingMessage, response: ServerResponse) => void = (_request, response) => {
    response.end("reached");
  },
  port = 0,
): Promise<Listener> {
  const server: Server = createServer();
  const listener: Listener = {
    port: 0,
    connections: 0,
    sockets: [],
    requests: [],
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server.on("connection", (socket: Socket) => {
    listener.connections += 1;
    listener.sockets.push(socket);
  });
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      listener.requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(request, response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("listener has no port");
  }
  listener.port = address.port;
  openListeners.push(listener);
  return listener;
}

async function listenOrNull(host: string, port = 0): Promise<Listener | null> {
  try {
    return await listen(host, undefined, port);
  } catch {
    return null;
  }
}

const loopbackPermitted = (address: string): boolean =>
  address === "127.0.0.1" || isPublicAddress(address);

type LookupCall = { hostname: string; all: boolean };

/**
 * A `dns.lookup` stand-in that answers each call with the next scripted list
 * of addresses, in whichever callback form the caller asked for.
 */
function scriptedLookup(answers: string[][]): { lookup: typeof dnsLookup; calls: LookupCall[] } {
  const calls: LookupCall[] = [];
  const lookup = (
    hostname: string,
    options: { all?: boolean },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    const all = options.all === true;
    calls.push({ hostname, all });
    const answer = answers[calls.length - 1] ?? answers[answers.length - 1];
    process.nextTick(() => {
      if (all) {
        callback(null, answer.map((address) => ({ address, family: isIP(address) })));
      } else {
        callback(null, answer[0], isIP(answer[0]));
      }
    });
  };
  return { lookup: lookup as unknown as typeof dnsLookup, calls };
}

const refusalMessage = "The destination was refused.";

/**
 * Awaits a rejection and pins it as the one refusal: the refusal class, the
 * fixed message, and none of `hidden` (the address, the port, the status)
 * anywhere in what the error exposes.
 */
async function expectRefusal(pending: Promise<unknown>, hidden: string[]): Promise<void> {
  const outcome = await pending.then(
    (value: unknown) => ({ settled: "resolved" as const, value }),
    (error: unknown) => ({ settled: "rejected" as const, value: error }),
  );
  expect(outcome.settled).toBe("rejected");
  expect(outcome.value).toBeInstanceOf(DestinationRefusedError);
  const error = outcome.value as Error;
  expect(error.message).toBe(refusalMessage);
  // `inspect` with hidden properties reaches what the other two miss, such as
  // a non-enumerable ES2022 `cause`. The stack is left out: its frames are code
  // positions, whose line numbers could match a hidden port or status.
  const properties = Object.getOwnPropertyDescriptors(error);
  Reflect.deleteProperty(properties, "stack");
  const hiddenView = inspect(Object.defineProperties({}, properties), { showHidden: true, depth: null });
  const exposed = `${String(error)} ${JSON.stringify(error)} ${hiddenView}`;
  for (const value of hidden) {
    expect(exposed).not.toContain(value);
  }
}

describe("classifying an address as public", () => {
  // First, a lower-half, and the last address of every refused range, so a
  // range narrowed at either end is caught.
  it.each([
    ["0.0.0.0"],
    ["0.1.2.3"],
    ["0.255.255.255"],
    ["10.0.0.1"],
    ["10.255.255.255"],
    ["100.64.0.1"],
    ["100.127.255.255"],
    ["127.0.0.1"],
    ["127.255.255.255"],
    ["169.254.0.0"],
    ["169.254.169.254"],
    ["169.254.255.255"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.0.0.1"],
    ["192.0.0.255"],
    ["192.0.2.1"],
    ["192.0.2.255"],
    ["192.88.99.1"],
    ["192.88.99.255"],
    ["192.168.1.1"],
    ["192.168.255.255"],
    ["198.18.0.1"],
    ["198.19.255.255"],
    ["198.51.100.1"],
    ["198.51.100.255"],
    ["203.0.113.1"],
    ["203.0.113.255"],
    ["224.0.0.1"],
    ["239.255.255.255"],
    ["240.0.0.1"],
    ["255.255.255.255"],
    ["::"],
    ["::1"],
    ["[::1]"],
    ["fc00::1"],
    ["fd00::1"],
    ["fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["fe80::1"],
    ["febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["ff02::1"],
    ["64:ff9b::7f00:1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:7f00:1"],
    ["::ffff:169.254.169.254"],
    ["::127.0.0.1"],
    ["1000::1"],
    ["1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["4000::1"],
    ["2001::1"],
    ["2001:1ff:ffff::1"],
    ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:db8::1"],
    ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2002:7f00:1::"],
    ["2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("never lets an IPv4-mapped address through, even one embedding a public IPv4", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it.each([
    ["localhost"],
    ["gitlab.example"],
    [""],
    ["fe80::1%eth0"],
    ["2606:4700::1%eth0"],
    ["127.0.0.1:80"],
  ])("refuses %j, which is not a bare address", (value) => {
    expect(isPublicAddress(value)).toBe(false);
  });

  // The public neighbours on either side of the refused ranges.
  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["1.0.0.0"],
    ["9.255.255.255"],
    ["11.0.0.0"],
    ["100.63.255.255"],
    ["100.128.0.0"],
    ["126.255.255.255"],
    ["128.0.0.0"],
    ["169.253.255.255"],
    ["169.255.0.0"],
    ["172.15.255.255"],
    ["172.32.0.0"],
    ["192.0.1.1"],
    ["192.0.3.0"],
    ["192.88.98.255"],
    ["192.88.100.0"],
    ["192.167.255.255"],
    ["192.169.0.0"],
    ["198.17.255.255"],
    ["198.20.0.0"],
    ["198.51.99.255"],
    ["198.51.101.0"],
    ["203.0.112.255"],
    ["203.0.114.0"],
    ["223.255.255.255"],
    ["2000::1"],
    ["3000::1"],
    ["2606:4700:4700::1111"],
    ["[2606:4700:4700::1111]"],
    ["2a00:1450:4001::200e"],
    ["2001:200::"],
    ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2001:db9::"],
    ["2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["2003::"],
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("refusing loopback destinations before connecting", () => {
  it.each([["http"], ["https"]])("refuses %s://127.0.0.1 and never connects", async (scheme) => {
    const listener = await listen("127.0.0.1");

    await expectRefusal(publicFetch(`${scheme}://127.0.0.1:${listener.port}/`), [
      "127.0.0.1",
      String(listener.port),
    ]);
    expect(listener.connections).toBe(0);
  });

  it("refuses http://[::1] and never connects", async (context) => {
    const listener = await listenOrNull("::1");
    if (listener === null) {
      // The host has no IPv6 loopback to listen on; the literal is still
      // covered by the classification table.
      context.skip();
      return;
    }

    await expectRefusal(publicFetch(`http://[::1]:${listener.port}/`), ["::1", String(listener.port)]);
    expect(listener.connections).toBe(0);
  });

  it("refuses http://localhost, whichever loopback family it resolves to", async () => {
    const ipv4 = await listen("127.0.0.1");
    const ipv6 = await listenOrNull("::1", ipv4.port);

    await expectRefusal(publicFetch(`http://localhost:${ipv4.port}/`), ["127.0.0.1", "::1", "localhost"]);
    expect(ipv4.connections).toBe(0);
    expect(ipv6?.connections ?? 0).toBe(0);
  });

  it("refuses a scheme other than http and https", async () => {
    await expectRefusal(publicFetch("file:///etc/passwd"), ["file", "/etc/passwd"]);
  });
});

// The hostname cases run over both schemes: https is the production case,
// and the refusal lands in the lookup, before any TLS, so a plain TCP
// listener's connection counter is still the witness.
describe("judging the address the socket connects to", () => {
  it("connects where an injected lookup points a hostname, when that address is permitted", async () => {
    const listener = await listen("127.0.0.1");
    const { lookup } = scriptedLookup([["127.0.0.1"]]);
    const guardedFetch = createPublicFetch({ lookup, isPermittedAddress: loopbackPermitted, maxBodyBytes: bodyLimit });

    const response = await guardedFetch(`http://gitlab.rebind.test:${listener.port}/`);

    expect(await response.text()).toBe("reached");
    expect(listener.connections).toBe(1);
    expect(listener.requests[0]?.headers.host).toBe(`gitlab.rebind.test:${listener.port}`);
  });

  it.each([["http"], ["https"]])(
    "refuses a %s name that answered public when checked and loopback when connected",
    async (scheme) => {
      const listener = await listen("127.0.0.1");
      const { lookup, calls } = scriptedLookup([["8.8.8.8"], ["127.0.0.1"]]);
      const guardedFetch = createPublicFetch({ lookup, maxBodyBytes: bodyLimit });

      // What a validate-then-fetch check would see: a public answer.
      const checked = await new Promise<string>((resolve, reject) => {
        lookup("gitlab.rebind.test", {}, (error, address) => {
          if (error) reject(error);
          else resolve(address);
        });
      });
      expect(isPublicAddress(checked)).toBe(true);

      await expectRefusal(guardedFetch(`${scheme}://gitlab.rebind.test:${listener.port}/`), [
        "127.0.0.1",
        "8.8.8.8",
      ]);
      expect(calls).toHaveLength(2);
      expect(listener.connections).toBe(0);
    },
  );

  it.each([["http"], ["https"]])(
    "refuses a %s name when any address in an all-addresses answer is non-public",
    async (scheme) => {
      const listener = await listen("127.0.0.1");
      const { lookup, calls } = scriptedLookup([["8.8.8.8", "127.0.0.1"]]);
      const guardedFetch = createPublicFetch({ lookup, maxBodyBytes: bodyLimit });

      await expectRefusal(guardedFetch(`${scheme}://gitlab.rebind.test:${listener.port}/`), [
        "127.0.0.1",
        "8.8.8.8",
      ]);
      expect(calls).toEqual([{ hostname: "gitlab.rebind.test", all: true }]);
      expect(listener.connections).toBe(0);
    },
  );

  it.each([["http"], ["https"]])(
    "refuses a %s name whose all-addresses answer is empty",
    async (scheme) => {
      const listener = await listen("127.0.0.1");
      const { lookup, calls } = scriptedLookup([[]]);
      const guardedFetch = createPublicFetch({ lookup, maxBodyBytes: bodyLimit });

      await expectRefusal(guardedFetch(`${scheme}://gitlab.rebind.test:${listener.port}/`), []);
      expect(calls).toEqual([{ hostname: "gitlab.rebind.test", all: true }]);
      expect(listener.connections).toBe(0);
    },
    // Without the guard an empty answer never settles; fail fast rather than
    // at the suite's two-minute default.
    5_000,
  );

  it.each([["http"], ["https"]])(
    "refuses a %s name's non-public single-address answer when family autoselection is off",
    async (scheme) => {
      const listener = await listen("127.0.0.1");
      const { lookup, calls } = scriptedLookup([["127.0.0.1"]]);
      const guardedFetch = createPublicFetch({ lookup, maxBodyBytes: bodyLimit });
      const previous = getDefaultAutoSelectFamily();
      setDefaultAutoSelectFamily(false);
      try {
        await expectRefusal(guardedFetch(`${scheme}://gitlab.rebind.test:${listener.port}/`), ["127.0.0.1"]);
      } finally {
        setDefaultAutoSelectFamily(previous);
      }
      expect(calls).toEqual([{ hostname: "gitlab.rebind.test", all: false }]);
      expect(listener.connections).toBe(0);
    },
  );
});

describe("keeping its connection pool to itself", () => {
  it("never takes a socket another client pooled, so a pooled loopback connection is still refused", async () => {
    const ipv4 = await listen("127.0.0.1");
    const ipv6 = await listenOrNull("::1", ipv4.port);
    const listeners = ipv6 === null ? [ipv4] : [ipv4, ipv6];
    const connections = () => listeners.reduce((total, listener) => total + listener.connections, 0);
    const requests = () => listeners.reduce((total, listener) => total + listener.requests.length, 0);

    // Unrelated code pools a keep-alive socket to localhost through Node's
    // shared agent. Reusing it would skip the lookup the guard lives in.
    const pooling = httpGet({ host: "localhost", port: ipv4.port, path: "/", agent: globalAgent });
    const [answer] = (await once(pooling, "response")) as [IncomingMessage];
    answer.resume();
    await once(pooling, "close");
    expect(Object.keys(globalAgent.freeSockets).some((name) => name.startsWith(`localhost:${ipv4.port}:`))).toBe(true);
    const [connectionsBefore, requestsBefore] = [connections(), requests()];

    await expectRefusal(publicFetch(`http://localhost:${ipv4.port}/`), ["127.0.0.1", "::1", "reached"]);
    expect(connections()).toBe(connectionsBefore);
    expect(requests()).toBe(requestsBefore);
  });
});

describe("releasing idle connections", () => {
  it(
    "closes a pooled connection left idle, even to a server that would keep it open forever",
    async () => {
      const listener = await listen("127.0.0.1");
      // The server never closes an idle connection of its own accord.
      listener.server.keepAliveTimeout = 0;
      const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: bodyLimit });

      const response = await guardedFetch(`http://127.0.0.1:${listener.port}/`);
      expect(await response.text()).toBe("reached");
      expect(listener.sockets).toHaveLength(1);
      const [socket] = listener.sockets;
      if (!socket!.closed) {
        await once(socket!, "close");
      }

      expect(listener.sockets.filter((open) => !open.closed)).toEqual([]);
    },
    // An unbounded pool never closes it; fail rather than wait for the suite
    // default. The transport's own idle bound is well inside this.
    15_000,
  );
});

describe("following no redirects", () => {
  it.each([[301], [302], [303], [307], [308]])(
    "refuses a %i to another listener and never reaches it",
    async (status) => {
      const target = await listen("127.0.0.1");
      const origin = await listen("127.0.0.1", (_request, response) => {
        response.writeHead(status, { location: `http://127.0.0.1:${target.port}/` });
        response.end();
      });
      const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: bodyLimit });

      await expectRefusal(guardedFetch(`http://127.0.0.1:${origin.port}/`), [
        String(status),
        String(target.port),
        "location",
      ]);
      expect(origin.requests).toHaveLength(1);
      expect(target.connections).toBe(0);
    },
  );

  it.each([[300], [304]])("refuses a %i rather than handing it back", async (status) => {
    const origin = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(status);
      response.end();
    });
    const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: bodyLimit });

    await expectRefusal(guardedFetch(`http://127.0.0.1:${origin.port}/`), [String(status)]);
  });
});

describe("reading the response", () => {
  const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: bodyLimit });

  it("returns the status, headers and body of a permitted answer intact", async () => {
    const body = JSON.stringify({ id: 7, username: "octo", note: "ünïcödé" });
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-next-page": "2",
        link: '<https://gitlab.example/api/v4/projects?page=2>; rel="next"',
      });
      response.end(body);
    });

    const response = await guardedFetch(`http://127.0.0.1:${listener.port}/api/v4/user?x=1`);

    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("x-next-page")).toBe("2");
    expect(response.headers.get("link")).toBe('<https://gitlab.example/api/v4/projects?page=2>; rel="next"');
    expect(await response.text()).toBe(body);
    expect(listener.requests[0]?.url).toBe("/api/v4/user?x=1");
  });

  it("hands back a non-2xx status rather than rejecting", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(404);
      response.end("missing");
    });

    const response = await guardedFetch(`http://127.0.0.1:${listener.port}/`);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("missing");
  });

  it("returns a null body for a 204", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(204);
      response.end();
    });

    const response = await guardedFetch(`http://127.0.0.1:${listener.port}/`);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it("sends the method, body and headers of a POST", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(201);
      response.end("{}");
    });
    const body = JSON.stringify({ issue_events: true, name: "ünïcödé" });

    const response = await guardedFetch(`http://127.0.0.1:${listener.port}/hooks`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body,
    });

    expect(response.status).toBe(201);
    expect(listener.requests).toHaveLength(1);
    expect(listener.requests[0]?.method).toBe("POST");
    expect(listener.requests[0]?.body).toBe(body);
    expect(listener.requests[0]?.headers.authorization).toBe("Bearer secret");
    expect(listener.requests[0]?.headers["content-type"]).toBe("application/json");
  });

  it("sends headers given as a Headers object", async () => {
    const listener = await listen("127.0.0.1");

    await guardedFetch(`http://127.0.0.1:${listener.port}/`, {
      method: "PUT",
      headers: new Headers({ authorization: "Bearer other" }),
      body: "x",
    });

    expect(listener.requests[0]?.method).toBe("PUT");
    expect(listener.requests[0]?.headers.authorization).toBe("Bearer other");
  });

  it("rejects a response whose connection closes before the body is complete", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "content-length": "10" });
      response.write("half", () => response.socket?.destroy());
    });

    // Node's own error for a response cut short, not a Response handed back
    // with a truncated body.
    await expect(guardedFetch(`http://127.0.0.1:${listener.port}/`)).rejects.toMatchObject({
      code: "ECONNRESET",
    });
  });

  it("accepts a body of exactly the limit", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.end(Buffer.alloc(bodyLimit, 0x61));
    });

    const response = await guardedFetch(`http://127.0.0.1:${listener.port}/`);

    expect((await response.arrayBuffer()).byteLength).toBe(bodyLimit);
  });

  it("refuses a body one byte over the limit", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.end(Buffer.alloc(bodyLimit + 1, 0x61));
    });

    await expectRefusal(guardedFetch(`http://127.0.0.1:${listener.port}/`), [
      String(bodyLimit),
      String(listener.port),
    ]);
  });

  it("refuses an oversize body that arrives without a content length", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      for (let written = 0; written <= bodyLimit; written += 64 * 1024) {
        response.write(Buffer.alloc(64 * 1024, 0x61));
      }
      response.end();
    });

    await expectRefusal(guardedFetch(`http://127.0.0.1:${listener.port}/`), [
      String(bodyLimit),
      String(listener.port),
    ]);
  });

  it("bounds the body at a small cap its creator sets", async () => {
    const capped = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: 16 });
    const exact = await listen("127.0.0.1", (_request, response) => {
      response.end("a".repeat(16));
    });
    const over = await listen("127.0.0.1", (_request, response) => {
      response.end("a".repeat(17));
    });

    expect(await (await capped(`http://127.0.0.1:${exact.port}/`)).text()).toBe("a".repeat(16));
    await expectRefusal(capped(`http://127.0.0.1:${over.port}/`), ["16", String(over.port)]);
  });

  it("reads past 1 MiB up to a larger cap its creator sets", async () => {
    const capped = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: 2 * bodyLimit });
    const exact = await listen("127.0.0.1", (_request, response) => {
      response.end(Buffer.alloc(2 * bodyLimit, 0x61));
    });
    const over = await listen("127.0.0.1", (_request, response) => {
      response.end(Buffer.alloc(2 * bodyLimit + 1, 0x61));
    });

    const response = await capped(`http://127.0.0.1:${exact.port}/`);

    expect((await response.arrayBuffer()).byteLength).toBe(2 * bodyLimit);
    await expectRefusal(capped(`http://127.0.0.1:${over.port}/`), [String(2 * bodyLimit), String(over.port)]);
  });
});

describe("honouring the abort signal", () => {
  const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted, maxBodyBytes: bodyLimit });

  it("rejects without connecting when the signal is already aborted", async () => {
    const listener = await listen("127.0.0.1");

    await expect(
      guardedFetch(`http://127.0.0.1:${listener.port}/`, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(listener.connections).toBe(0);
  });

  it("rejects when aborted while waiting for the response", async () => {
    const controller = new AbortController();
    const listener = await listen("127.0.0.1", () => {
      // Never answers; the abort is the only way out.
      controller.abort();
    });

    await expect(
      guardedFetch(`http://127.0.0.1:${listener.port}/`, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when aborted while the body is still arriving", async () => {
    const controller = new AbortController();
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "content-length": "10" });
      response.write("half", () => controller.abort());
    });

    await expect(
      guardedFetch(`http://127.0.0.1:${listener.port}/`, { signal: controller.signal }).then(
        (response) => response.text(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("with a deny list of extra refused destinations", () => {
  // The deny list may only ever refuse more, so a case whose GREEN outcome is
  // a refusal must aim at a destination the unfixed transport would have
  // dialled: the host's own public interface address, which a self-connect
  // answers over loopback. Where the host has none (a CI runner), the
  // public-address cases have no local stand-in and skip.
  const hostPublic = hostPublicAddresses();
  const publicCase = hostPublic[0];

  it("refuses construction when a deny list is supplied beside an explicit permission check", () => {
    expect(
      () => createPublicFetch({ isPermittedAddress: loopbackPermitted, denyCidrs: ["8.8.8.8"], maxBodyBytes: bodyLimit }),
    ).toThrow(TypeError);
  });

  it.each([
    ["nonsense"],
    ["300.1.2.3"],
    ["8.8.8.8/33"],
    ["8.8.8.8/-1"],
    ["8.8.8.8/"],
    ["8.8.8.8/8/8"],
    ["8.8.8.8/0x8"],
    ["[::1]"],
  ])("refuses construction on the invalid deny-list entry %j", (entry) => {
    expect(() => createPublicFetch({ denyCidrs: [entry], maxBodyBytes: bodyLimit })).toThrow(TypeError);
  });

  it("accepts bare addresses and CIDR subnets of either family", () => {
    expect(() =>
      createPublicFetch({
        denyCidrs: ["8.8.8.8", "8.8.0.0/16", "2001:db8::/32", "::1", "0.0.0.0/8"],
        maxBodyBytes: bodyLimit,
      }),
    ).not.toThrow();
  });

  it("keeps an explicit permission check beside an empty deny list", async () => {
    const listener = await listen("127.0.0.1");
    const guardedFetch = createPublicFetch({
      isPermittedAddress: loopbackPermitted,
      denyCidrs: [],
      maxBodyBytes: bodyLimit,
    });

    const response = await guardedFetch(`http://127.0.0.1:${listener.port}/`);

    expect(await response.text()).toBe("reached");
    expect(listener.connections).toBe(1);
  });

  it("refuses an IP literal the deny list contains, before connecting", async (context) => {
    if (publicCase === undefined) {
      context.skip();
      return;
    }
    const listener = await listen(publicCase);
    const guardedFetch = createPublicFetch({ denyCidrs: [publicCase], maxBodyBytes: bodyLimit });

    await expectRefusal(guardedFetch(`http://${urlHost(publicCase)}:${listener.port}/`), [
      publicCase,
      String(listener.port),
    ]);
    expect(listener.connections).toBe(0);
  });

  it("refuses an IP literal a deny-list subnet covers", async (context) => {
    if (publicCase === undefined) {
      context.skip();
      return;
    }
    const listener = await listen(publicCase);
    const prefix = isIP(publicCase) === 4 ? 24 : 64;
    const guardedFetch = createPublicFetch({ denyCidrs: [`${publicCase}/${prefix}`], maxBodyBytes: bodyLimit });

    await expectRefusal(guardedFetch(`http://${urlHost(publicCase)}:${listener.port}/`), [
      publicCase,
      String(listener.port),
    ]);
    expect(listener.connections).toBe(0);
  });

  it("refuses a hostname whose resolved answer the deny list contains", async (context) => {
    if (publicCase === undefined) {
      context.skip();
      return;
    }
    const listener = await listen(publicCase);
    const { lookup } = scriptedLookup([[publicCase]]);
    const guardedFetch = createPublicFetch({ lookup, denyCidrs: [publicCase], maxBodyBytes: bodyLimit });

    await expectRefusal(guardedFetch(`http://gitlab.rebind.test:${listener.port}/`), [
      publicCase,
      String(listener.port),
    ]);
    expect(listener.connections).toBe(0);
  });

  it("completes a fetch whose destination the deny list does not contain", async (context) => {
    if (publicCase === undefined) {
      context.skip();
      return;
    }
    const listener = await listen(publicCase);
    const guardedFetch = createPublicFetch({ denyCidrs: ["8.8.8.8"], maxBodyBytes: bodyLimit });

    const response = await guardedFetch(`http://${urlHost(publicCase)}:${listener.port}/`);

    expect(await response.text()).toBe("reached");
    expect(listener.connections).toBe(1);
  });

  it("refuses a class-refused destination exactly as a deny-free transport does", async () => {
    const listener = await listen("127.0.0.1");
    const { lookup } = scriptedLookup([["127.0.0.1"]]);
    const guardedFetch = createPublicFetch({ lookup, denyCidrs: ["8.8.8.8"], maxBodyBytes: bodyLimit });

    await expectRefusal(guardedFetch(`http://gitlab.rebind.test:${listener.port}/`), ["127.0.0.1", "8.8.8.8"]);
    expect(listener.connections).toBe(0);
  });
});
