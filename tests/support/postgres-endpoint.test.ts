import { describe, expect, it } from "vitest";
import { selectPostgresEndpoint } from "./postgres-container";

describe("PostgreSQL endpoint selection", () => {
  it("uses the IPv4 port from distinct loopback-family bindings", () => {
    expect(selectPostgresEndpoint("localhost", [
      { HostIp: "0.0.0.0", HostPort: "44712" },
      { HostIp: "::", HostPort: "44400" },
    ], 44400)).toEqual({ host: "127.0.0.1", port: 44712 });
  });

  it("rejects IPv6-only publication for a local runtime", () => {
    expect(() => selectPostgresEndpoint("127.0.0.1", [
      { HostIp: "::1", HostPort: "44400" },
    ], 44400)).toThrow(/IPv6-only/);
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

});
