import type { lookup as dnsLookup, LookupAddress } from "node:dns";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { getDefaultAutoSelectFamily, isIP, setDefaultAutoSelectFamily } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPublicFetch,
  DestinationRefusedError,
  isPublicAddress,
  publicFetch,
} from "@/lib/security/public-destination";

const bodyLimit = 1024 * 1024;

type RecordedRequest = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

type Listener = {
  port: number;
  /** TCP connections accepted — a refusal must happen before any exists. */
  connections: number;
  requests: RecordedRequest[];
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
    requests: [],
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  server.on("connection", () => {
    listener.connections += 1;
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

describe("classifying an address as public", () => {
  it.each([
    ["0.0.0.0"],
    ["0.1.2.3"],
    ["10.0.0.1"],
    ["10.255.255.255"],
    ["100.64.0.1"],
    ["100.127.255.254"],
    ["127.0.0.1"],
    ["127.255.255.254"],
    ["169.254.169.254"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.0.0.1"],
    ["192.0.2.1"],
    ["192.88.99.1"],
    ["192.168.1.1"],
    ["198.18.0.1"],
    ["198.19.255.255"],
    ["198.51.100.1"],
    ["203.0.113.1"],
    ["224.0.0.1"],
    ["239.255.255.255"],
    ["240.0.0.1"],
    ["255.255.255.255"],
    ["::"],
    ["::1"],
    ["[::1]"],
    ["fc00::1"],
    ["fd00::1"],
    ["fe80::1"],
    ["ff02::1"],
    ["64:ff9b::7f00:1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:7f00:1"],
    ["::ffff:169.254.169.254"],
    ["::127.0.0.1"],
    ["1000::1"],
    ["4000::1"],
    ["2001::1"],
    ["2001:1ff:ffff::1"],
    ["2001:db8::1"],
    ["2002:7f00:1::"],
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("never lets an IPv4-mapped address through, even one embedding a public IPv4", () => {
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it.each([["localhost"], ["gitlab.example"], [""], ["fe80::1%eth0"], ["127.0.0.1:80"]])(
    "refuses %j, which is not an address",
    (value) => {
      expect(isPublicAddress(value)).toBe(false);
    },
  );

  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["9.255.255.255"],
    ["11.0.0.1"],
    ["100.63.255.255"],
    ["100.128.0.1"],
    ["172.15.255.255"],
    ["172.32.0.1"],
    ["192.0.1.1"],
    ["198.20.0.1"],
    ["223.255.255.255"],
    ["2606:4700:4700::1111"],
    ["[2606:4700:4700::1111]"],
    ["2a00:1450:4001::200e"],
    ["2001:200::1"],
  ])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("refusing loopback destinations before connecting", () => {
  it.each([["http"], ["https"]])("refuses %s://127.0.0.1 and never connects", async (scheme) => {
    const listener = await listen("127.0.0.1");

    await expect(publicFetch(`${scheme}://127.0.0.1:${listener.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
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

    await expect(publicFetch(`http://[::1]:${listener.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
    expect(listener.connections).toBe(0);
  });

  it("refuses http://localhost, whichever loopback family it resolves to", async () => {
    const ipv4 = await listen("127.0.0.1");
    const ipv6 = await listenOrNull("::1", ipv4.port);

    await expect(publicFetch(`http://localhost:${ipv4.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
    expect(ipv4.connections).toBe(0);
    expect(ipv6?.connections ?? 0).toBe(0);
  });

  it("refuses a scheme other than http and https", async () => {
    await expect(publicFetch("file:///etc/passwd")).rejects.toBeInstanceOf(DestinationRefusedError);
  });
});

describe("judging the address the socket connects to", () => {
  it("connects where an injected lookup points a hostname, when that address is permitted", async () => {
    const listener = await listen("127.0.0.1");
    const { lookup } = scriptedLookup([["127.0.0.1"]]);
    const guardedFetch = createPublicFetch({ lookup, isPermittedAddress: loopbackPermitted });

    const response = await guardedFetch(`http://gitlab.rebind.test:${listener.port}/`);

    expect(await response.text()).toBe("reached");
    expect(listener.connections).toBe(1);
    expect(listener.requests[0]?.headers.host).toBe(`gitlab.rebind.test:${listener.port}`);
  });

  it("refuses a name that answered public when checked and loopback when connected", async () => {
    const listener = await listen("127.0.0.1");
    const { lookup, calls } = scriptedLookup([["8.8.8.8"], ["127.0.0.1"]]);
    const guardedFetch = createPublicFetch({ lookup });

    // What a validate-then-fetch check would see: a public answer.
    const checked = await new Promise<string>((resolve, reject) => {
      lookup("gitlab.rebind.test", {}, (error, address) => {
        if (error) reject(error);
        else resolve(address);
      });
    });
    expect(isPublicAddress(checked)).toBe(true);

    await expect(guardedFetch(`http://gitlab.rebind.test:${listener.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
    expect(calls).toHaveLength(2);
    expect(listener.connections).toBe(0);
  });

  it("refuses when any address in an all-addresses answer is non-public", async () => {
    const listener = await listen("127.0.0.1");
    const { lookup, calls } = scriptedLookup([["8.8.8.8", "127.0.0.1"]]);
    const guardedFetch = createPublicFetch({ lookup });

    await expect(guardedFetch(`http://gitlab.rebind.test:${listener.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
    expect(calls).toEqual([{ hostname: "gitlab.rebind.test", all: true }]);
    expect(listener.connections).toBe(0);
  });

  it("refuses a non-public single-address answer when family autoselection is off", async () => {
    const listener = await listen("127.0.0.1");
    const { lookup, calls } = scriptedLookup([["127.0.0.1"]]);
    const guardedFetch = createPublicFetch({ lookup });
    const previous = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(false);
    try {
      await expect(
        guardedFetch(`http://gitlab.rebind.test:${listener.port}/`),
      ).rejects.toBeInstanceOf(DestinationRefusedError);
    } finally {
      setDefaultAutoSelectFamily(previous);
    }
    expect(calls).toEqual([{ hostname: "gitlab.rebind.test", all: false }]);
    expect(listener.connections).toBe(0);
  });
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
      const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted });

      await expect(guardedFetch(`http://127.0.0.1:${origin.port}/`)).rejects.toBeInstanceOf(
        DestinationRefusedError,
      );
      expect(origin.requests).toHaveLength(1);
      expect(target.connections).toBe(0);
    },
  );

  it.each([[300], [304]])("refuses a %i rather than handing it back", async (status) => {
    const origin = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(status);
      response.end();
    });
    const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted });

    await expect(guardedFetch(`http://127.0.0.1:${origin.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
  });
});

describe("reading the response", () => {
  const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted });

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

    await expect(guardedFetch(`http://127.0.0.1:${listener.port}/`)).rejects.toBeInstanceOf(Error);
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

    await expect(guardedFetch(`http://127.0.0.1:${listener.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
  });

  it("refuses an oversize body that arrives without a content length", async () => {
    const listener = await listen("127.0.0.1", (_request, response) => {
      response.writeHead(200, { "transfer-encoding": "chunked" });
      for (let written = 0; written <= bodyLimit; written += 64 * 1024) {
        response.write(Buffer.alloc(64 * 1024, 0x61));
      }
      response.end();
    });

    await expect(guardedFetch(`http://127.0.0.1:${listener.port}/`)).rejects.toBeInstanceOf(
      DestinationRefusedError,
    );
  });
});

describe("honouring the abort signal", () => {
  const guardedFetch = createPublicFetch({ isPermittedAddress: loopbackPermitted });

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
