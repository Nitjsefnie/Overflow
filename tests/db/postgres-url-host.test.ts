import { createServer } from "node:net";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

describe("postgres host parsing", () => {
  it.each([
    ["bracketed IPv6 with a port", "postgresql://u:p@[::1]:5433/db", ["::1"], [5433]],
    ["bracketed IPv6 with the default port", "postgresql://u:p@[::1]/db", ["::1"], [5432]],
    [
      "two bracketed IPv6 hosts",
      "postgresql://u:p@[::1]:5432,[2001:db8::2]:5433/db",
      ["::1", "2001:db8::2"],
      [5432, 5433],
    ],
    [
      "mixed IPv6 and hostname hosts",
      "postgresql://u:p@[::1]:5432,db.example:5433/db",
      ["::1", "db.example"],
      [5432, 5433],
    ],
    ["IPv4 host", "postgresql://u:p@127.0.0.1:5432/db", ["127.0.0.1"], [5432]],
    ["hostname", "postgresql://u:p@db.example:5433/db", ["db.example"], [5433]],
    ["unbracketed multihost", "postgresql://u:p@h1:1,h2:2/db", ["h1", "h2"], [1, 2]],
  ])("parses %s", async (_name, url, hosts, ports) => {
    const sql = postgres(url);
    try {
      expect(sql.options.host).toEqual(hosts);
      expect(sql.options.port).toEqual(ports);
    } finally {
      await sql.end();
    }
  });

  it.each([
    ["bare IPv6", "::1", ["::1"]],
    ["full bare IPv6", "2001:db8::1", ["2001:db8::1"]],
    ["bracketed IPv6", "[::1]", ["::1"]],
  ])("parses %s from the host option", async (_name, host, hosts) => {
    const sql = postgres({ host, port: 5434 });
    try {
      expect(sql.options.host).toEqual(hosts);
      expect(sql.options.port).toEqual([5434]);
    } finally {
      await sql.end();
    }
  });

  it("parses bare IPv6 from PGHOST", async () => {
    vi.stubEnv("PGHOST", "2001:db8::2");
    try {
      const sql = postgres({ port: 5435 });
      try {
        expect(sql.options.host).toEqual(["2001:db8::2"]);
        expect(sql.options.port).toEqual([5435]);
      } finally {
        await sql.end();
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("dials the IPv6 address from a bracketed URL", async () => {
    const remoteAddresses: string[] = [];
    let acceptConnection: () => void = () => {};
    const accepted = new Promise<void>((resolve) => { acceptConnection = resolve; });
    const server = createServer((socket) => {
      remoteAddresses.push(socket.remoteAddress ?? "");
      acceptConnection();
      socket.destroy();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      throw new Error("IPv6 loopback ::1 is unavailable for this test", { cause: error });
    }

    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IPv6 TCP listener");
    const sql = postgres(`postgresql://u:p@[::1]:${address.port}/db`, {
      max: 1,
      connect_timeout: 1,
    });

    try {
      const query = sql`select 1`.then(() => "resolved", () => "rejected");
      await Promise.race([accepted, query]);
      await sql.end({ timeout: 0 });
      expect(await query).toBe("rejected");
      expect(remoteAddresses).toEqual(["::1"]);
    } finally {
      await sql.end({ timeout: 0 });
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
