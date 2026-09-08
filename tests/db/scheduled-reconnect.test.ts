import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";

/** The small subset of the backend protocol needed by this local peer. */
function message(type: string, body: Buffer) {
  const header = Buffer.alloc(5);
  header.write(type);
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

const ready = message("Z", Buffer.from("I"));
const authenticated = message("R", Buffer.alloc(4));
const unavailable = message("E", Buffer.from("SFATAL\0C57P03\0Mnot ready\0\0"));
const completed = message("C", Buffer.from("SET\0"));

/**
 * Real TCP and postgres.js; only the retry timer's callback is wrapped to record its firing.
 * Removing shutdown's acceleration of fresh dispatch makes "backoff elapsed" precede serving
 * the query and settling shutdown. Cancelling that dispatch instead loses the recorded command.
 */
describe("shutdown during a pool-scheduled reconnect", () => {
  it.each([1, 3])("serves fresh dispatch before its %s-second backoff elapses", async (backoffSeconds) => {
    const observed: string[] = [];
    const sockets = new Set<net.Socket>();
    let accepted = 0;
    const server = net.createServer((socket) => {
      const attempt = ++accepted;
      sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => sockets.delete(socket));
      let startup = true;
      let incoming = Buffer.alloc(0);
      socket.on("data", (data: Buffer) => {
        incoming = Buffer.concat([incoming, data]);
        while (incoming.length >= (startup ? 4 : 5)) {
          const length = incoming.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
          if (incoming.length < length) return;
          const packet = incoming.subarray(0, length);
          incoming = incoming.subarray(length);
          if (startup) {
            startup = false;
            if (attempt === 1) {
              // A clean connect-phase death establishes the retry counter, as in issue 224.
              socket.end();
            } else if (attempt === 2) {
              // Reject the old initial query, then close: the pool dispatches its queued query.
              socket.end(unavailable);
            } else {
              observed.push("fresh attempt opened");
              socket.write(Buffer.concat([authenticated, ready]));
            }
          } else if (packet[0] === 81) { // Simple Query
            observed.push(packet.subarray(5, -1).toString());
            socket.write(Buffer.concat([completed, ready]));
          } else if (packet[0] === 88) { // Terminate
            socket.end();
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const realSetTimeout = globalThis.setTimeout;
    let watchSchedule = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (!watchSchedule) return realSetTimeout(callback, delay, ...args);
      watchSchedule = false;
      observed.push("fresh attempt scheduled");
      scheduled = realSetTimeout(() => {
        observed.push("backoff elapsed");
        callback(...args);
      }, delay);
      return scheduled;
    });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    let resolveShutdown!: (shutdown: Promise<void>) => void;
    const shutdownStarted = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    let closing = false;
    const sql = postgres({
      host: "127.0.0.1",
      port: (server.address() as net.AddressInfo).port,
      user: "probe", database: "probe", password: "probe",
      max: 1, fetch_types: false, max_lifetime: null,
      // The first clean FIN retries promptly; the ordinary close chooses the long schedule.
      backoff: () => accepted < 2 ? 0 : backoffSeconds,
      onclose: () => {
        if (closing) return;
        closing = true;
        watchSchedule = true;
        // end() yields one microtask; onclose dispatches the queued query before it resumes.
        const shutdown = sql.end().then(() => { observed.push("shutdown settled"); });
        resolveShutdown(shutdown);
      },
    });

    try {
      const failed = sql.unsafe("set application_name = 'old'").simple().then(
        () => "resolved", (error: { code?: string }) => error.code,
      );
      const fresh = sql.unsafe("set application_name = 'issue224'").simple().then(
        (result) => { observed.push("fresh query resolved"); return result.command; },
        (error: { code?: string }) => error.code,
      );
      await expect(shutdownStarted).resolves.toBeUndefined();
      await expect(failed).resolves.toBe("57P03");
      await expect(fresh).resolves.toBe("SET");
      expect(observed).toEqual([
        "fresh attempt scheduled",
        "fresh attempt opened",
        "set application_name = 'issue224'",
        "fresh query resolved",
        "shutdown settled",
      ]);
      expect(scheduled).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(scheduled);
      expect(accepted).toBe(3);
    } finally {
      watchSchedule = false;
      await sql.end();
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

/** First close during startup; later attempts either close too or wait at a handshake barrier. */
async function startRetryPeer(observed: string[], holdRetry: boolean) {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  let releaseHandshake!: (socket: net.Socket) => void;
  const handshake = new Promise<net.Socket>((resolve) => { releaseHandshake = resolve; });
  const server = net.createServer((socket) => {
    const attempt = ++accepted;
    observed.push(`attempt ${attempt} opened`);
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    let startup = true;
    let incoming = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      incoming = Buffer.concat([incoming, data]);
      while (incoming.length >= (startup ? 4 : 5)) {
        const length = incoming.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (incoming.length < length) return;
        const packet = incoming.subarray(0, length);
        incoming = incoming.subarray(length);
        if (startup) {
          startup = false;
          if (attempt === 1 || !holdRetry) {
            observed.push(`attempt ${attempt} closed during startup`);
            socket.end();
          } else {
            observed.push("retry handshake received");
            releaseHandshake(socket);
          }
        } else if (packet[0] === 81) {
          observed.push(packet.subarray(5, -1).toString());
          socket.write(Buffer.concat([completed, ready]));
        } else if (packet[0] === 88) {
          socket.end();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    handshake,
    get accepted() { return accepted; },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

describe("shutdown after an initial attempt has failed", () => {
  it("cancels the failed attempt's scheduled retry without opening another socket", async () => {
    const observed: string[] = [];
    const peer = await startRetryPeer(observed, false);
    const realSetTimeout = globalThis.setTimeout;
    let watchSchedule = false;
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let resolveScheduled!: () => void;
    const retryScheduled = new Promise<void>((resolve) => { resolveScheduled = resolve; });
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (!watchSchedule) return realSetTimeout(callback, delay, ...args);
      watchSchedule = false;
      observed.push("failed retry scheduled");
      scheduled = realSetTimeout(() => {
        observed.push("retry backoff elapsed");
        callback(...args);
      }, delay);
      resolveScheduled();
      return scheduled;
    });
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const sql = postgres({
      host: "127.0.0.1", port: peer.port,
      user: "probe", database: "probe", password: "probe",
      max: 1, fetch_types: false, max_lifetime: null,
      backoff: () => {
        watchSchedule = true;
        return 1;
      },
    });
    try {
      const opening = sql.unsafe("set application_name = 'cancelled'").simple().then(
        () => "resolved",
        (error: { code?: string }) => { observed.push("opening query rejected"); return error.code; },
      );
      // Resumes after closed() has retained the exact retry handle, before its callback fires.
      await retryScheduled;
      observed.push("shutdown requested");
      await sql.end();
      observed.push("shutdown settled");

      // P1 (fresh-only eligibility) and P5 (stale fresh marker) instead make another attempt
      // and reject with CONNECTION_CLOSED. Neither can satisfy this cancellation disposition.
      await expect(opening).resolves.toBe("CONNECTION_DESTROYED");
      expect(scheduled).toBeDefined();
      expect(clearSpy).toHaveBeenCalledWith(scheduled);
      expect(peer.accepted).toBe(1);
      expect(observed).toEqual([
        "attempt 1 opened", "attempt 1 closed during startup", "failed retry scheduled",
        "shutdown requested", "opening query rejected", "shutdown settled",
      ]);
    } finally {
      watchSchedule = false;
      await sql.end();
      timeoutSpy.mockRestore();
      clearSpy.mockRestore();
      await peer.close();
    }
  });

  it("serves a query when shutdown starts behind a live retry handshake barrier", async () => {
    const observed: string[] = [];
    const peer = await startRetryPeer(observed, true);
    const sql = postgres({
      host: "127.0.0.1", port: peer.port,
      user: "probe", database: "probe", password: "probe",
      max: 1, fetch_types: false, max_lifetime: null, backoff: () => 0,
    });
    try {
      const opening = sql.unsafe("set application_name = 'live224'").simple().then(
        (result) => { observed.push("opening query resolved"); return result.command; },
        (error: { code?: string }) => error.code,
      );
      const socket = await peer.handshake;
      observed.push("shutdown requested");
      const shutdown = sql.end().then(() => { observed.push("shutdown settled"); });
      // sql.end() yields once before ending the connection. Let that microtask register the
      // shutdown while the peer still holds the handshake, then allow it to finish normally.
      await Promise.resolve();
      observed.push("retry handshake released");
      socket.write(Buffer.concat([authenticated, ready]));

      // P4 (spent retry handle) and P6 (live initial qualifies as scheduled) terminate here
      // with CONNECTION_DESTROYED instead of allowing the actual SQL command to be served.
      await expect(opening).resolves.toBe("SET");
      await shutdown;
      expect(peer.accepted).toBe(2);
      expect(observed).toEqual([
        "attempt 1 opened", "attempt 1 closed during startup", "attempt 2 opened",
        "retry handshake received", "shutdown requested", "retry handshake released",
        "set application_name = 'live224'", "opening query resolved", "shutdown settled",
      ]);
    } finally {
      await sql.end();
      await peer.close();
    }
  });
});
