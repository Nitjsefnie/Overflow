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
