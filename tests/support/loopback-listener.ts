import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { afterEach, vi } from "vitest";

/**
 * Plain loopback HTTP listeners that count what reaches them, for the tests
 * that prove a member-supplied destination is refused before any connection
 * exists. `connections` counts accepted TCP connections, so a refusal that
 * happens after connecting still shows up.
 */
export type LoopbackListener = {
  port: number;
  connections: number;
  /** The request paths answered, in order. */
  paths: string[];
  close(): Promise<void>;
};

export type Responder = (request: IncomingMessage, response: ServerResponse) => void;

const openListeners: LoopbackListener[] = [];

/**
 * Closes every listener the calling file opened after each test. Call once at
 * module top level.
 */
export function useLoopbackListeners(): void {
  afterEach(async () => {
    await Promise.all(openListeners.splice(0).map((listener) => listener.close()));
  });
}

export async function listen(host: string, respond: Responder, port = 0): Promise<LoopbackListener> {
  const server: Server = createServer();
  const listener: LoopbackListener = {
    port: 0,
    connections: 0,
    paths: [],
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
    listener.paths.push(request.url ?? "");
    request.resume();
    request.on("end", () => respond(request, response));
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

/** A listener, or null when the host has no such address to listen on (an IPv6-less host). */
export async function listenOrNull(host: string, respond: Responder, port = 0): Promise<LoopbackListener | null> {
  try {
    return await listen(host, respond, port);
  } catch {
    return null;
  }
}

/**
 * Records the host every client socket is asked to connect to while it is
 * installed — the witness for an IP-literal destination no test can listen
 * on, such as 169.254.169.254. Every client socket (`net.connect`,
 * `tls.connect`, an http agent's `createConnection`) goes through
 * `Socket.prototype.connect`. A hostname is recorded before it is resolved,
 * so for a name this shows only that a connection was asked for.
 */
export function recordConnectAttempts(): string[] {
  const hosts: string[] = [];
  const original = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket, ...args: unknown[]) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const host = typeof first === "object" && first !== null
      ? (first as { host?: unknown; path?: unknown }).host ?? (first as { path?: unknown }).path
      : args[1];
    hosts.push(String(host));
    return (original as (...connectArgs: unknown[]) => Socket).apply(this, args);
  });
  return hosts;
}
