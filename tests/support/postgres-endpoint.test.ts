import { describe, expect, it } from "vitest";
import { postgresConnectionUrl, selectPostgresEndpoint } from "./postgres-container";

describe("PostgreSQL endpoint selection", () => {
  it("uses the IPv4 port from distinct loopback-family bindings", () => {
    expect(selectPostgresEndpoint("localhost", [
      { HostIp: "0.0.0.0", HostPort: "44712" },
      { HostIp: "::", HostPort: "44400" },
    ], 44400)).toEqual({ host: "127.0.0.1", port: 44712 });
  });

  it("uses the IPv6 port when only IPv6 is bound", () => {
    expect(selectPostgresEndpoint("127.0.0.1", [
      { HostIp: "::1", HostPort: "44400" },
    ], 44400)).toEqual({ host: "::1", port: 44400 });
  });

  it("uses IPv4 for a binding with an empty host IP", () => {
    expect(selectPostgresEndpoint("::1", [
      { HostIp: "", HostPort: "44712" },
    ], 44712)).toEqual({ host: "127.0.0.1", port: 44712 });
  });

  it("keeps a remote runtime host and testcontainers mapped port", () => {
    expect(selectPostgresEndpoint("docker.example.test", [
      { HostIp: "0.0.0.0", HostPort: "44712" },
      { HostIp: "::", HostPort: "44400" },
    ], 44400)).toEqual({ host: "docker.example.test", port: 44400 });
  });

  it("keeps a remote runtime host when Docker reports no local bindings", () => {
    expect(selectPostgresEndpoint("docker.example.test", [], 44400)).toEqual({
      host: "docker.example.test",
      port: 44400,
    });
  });

  it("names the container port when it has no usable binding", () => {
    expect(() => selectPostgresEndpoint("localhost", [], 44400)).toThrow(/5432/);
  });

  it("builds a valid bracketed URL for an IPv6-only published port", () => {
    const endpoint = selectPostgresEndpoint("localhost", [
      { HostIp: "::", HostPort: "44400" },
    ], 44400);
    const url = postgresConnectionUrl({
      ...endpoint,
      user: "test",
      password: "p@ss",
      database: "postgres",
      clientMinMessagesWarning: true,
    });

    expect(url).toBe("postgresql://test:p%40ss@[::1]:44400/postgres?client_min_messages=warning");
    expect(new URL(url).host).toBe("[::1]:44400");
  });
});
