import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Compose = {
  services: Record<string, {
    environment?: Record<string, string>;
    ports?: string[];
  }>;
};

type PortMapping = {
  segments: string[];
  bindAddress: string;
  hostPort: string;
  containerPort: string;
};

describe("local development database exposure", () => {
  it("publishes every postgres port through an explicit host bind address", async () => {
    const published = await readPublishedPorts();

    expect(published.length).toBeGreaterThan(0);
    for (const mapping of published) {
      const resolved = resolveMapping(mapping, {});
      expect(resolved.segments).toHaveLength(3);
      expect(resolved.bindAddress).not.toBe("");
    }
  });

  it("binds the published port to loopback when POSTGRES_HOST_BIND is unset", async () => {
    const published = await readPublishedPorts();

    for (const mapping of published) {
      const resolved = resolveMapping(mapping, {});
      expect(resolved.bindAddress).toBe("127.0.0.1");
      expect(resolved.hostPort).toBe("5432");
    }
  });

  it("widens the bind address only when POSTGRES_HOST_BIND is set deliberately", async () => {
    const published = await readPublishedPorts();

    for (const mapping of published) {
      expect(resolveMapping(mapping, { POSTGRES_HOST_BIND: "0.0.0.0" }).bindAddress).toBe("0.0.0.0");
      expect(resolveMapping(mapping, { POSTGRES_HOST_BIND: "" }).bindAddress).toBe("127.0.0.1");
    }
  });

  it("keeps the nonproduction credentials and the standard container port", async () => {
    const compose = await readCompose();
    const published = await readPublishedPorts();

    expect(compose.services.postgres.environment).toMatchObject({
      POSTGRES_DB: "overflow",
      POSTGRES_USER: "overflow",
      POSTGRES_PASSWORD: "overflow_local_only",
    });
    for (const mapping of published) {
      expect(resolveMapping(mapping, {}).containerPort).toBe("5432");
    }
  });
});

async function readCompose(): Promise<Compose> {
  return parse(await readFile(resolve("docker-compose.yml"), "utf8")) as Compose;
}

async function readPublishedPorts(): Promise<string[]> {
  return (await readCompose()).services.postgres.ports ?? [];
}

function resolveMapping(mapping: string, environment: Record<string, string>): PortMapping {
  const segments = interpolate(mapping, environment).split(":");
  return {
    segments,
    bindAddress: segments.length > 2 ? segments.slice(0, -2).join(":") : "",
    hostPort: segments[segments.length - 2] ?? "",
    containerPort: segments[segments.length - 1] ?? "",
  };
}

// Mirrors Compose variable interpolation for the `${VAR}`, `${VAR-default}` and
// `${VAR:-default}` forms, so the file's own default can be read without a
// container runtime.
function interpolate(value: string, environment: Record<string, string>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?)-([^}]*))?\}/g,
    (_match, name: string, colon: string | undefined, fallback: string | undefined) => {
      const current = environment[name];
      if (fallback === undefined) return current ?? "";
      if (current === undefined) return fallback;
      return colon === ":" && current === "" ? fallback : current;
    },
  );
}
