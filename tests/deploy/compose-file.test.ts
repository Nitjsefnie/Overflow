import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface ComposeService {
  image?: string;
  profiles?: string[];
  restart?: string;
  depends_on?: Record<string, { condition?: string }>;
  env_file?: Array<string | { path: string; required?: boolean }>;
  environment?: Record<string, string>;
  ports?: string[];
  healthcheck?: Record<string, unknown>;
}

interface ComposeFile {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}

const compose = parse(
  readFileSync(new URL("../../docker-compose.yml", import.meta.url), "utf8"),
) as ComposeFile;

describe("docker-compose.yml", () => {
  it("starts the app service only when the app profile is requested", () => {
    const { profiles } = compose.services.app;
    expect(profiles).toContain("app");
  });

  it("leaves the postgres service unchanged", () => {
    const postgres = compose.services.postgres;
    expect(postgres.image).toBe("postgres:17-alpine");
    expect(postgres.restart).toBe("unless-stopped");
    expect(postgres.healthcheck).toBeDefined();
    expect(postgres.ports).toEqual(["${POSTGRES_HOST_BIND:-127.0.0.1}:5432:5432"]);
  });

  it("starts the app only after postgres reports healthy, on a loopback port by default", () => {
    const app = compose.services.app;
    expect(app.restart).toBe("unless-stopped");
    expect(app.depends_on?.postgres?.condition).toBe("service_healthy");
    expect(app.ports).toEqual(["${APP_HOST_BIND:-127.0.0.1}:3000:3000"]);
  });

  it("feeds the app .env and pins DATABASE_URL at the compose layer", () => {
    const app = compose.services.app;
    const envFiles = (app.env_file ?? []).map((entry) =>
      typeof entry === "string"
        ? { path: entry, required: true }
        : { path: entry.path, required: entry.required ?? true },
    );
    expect(envFiles).toEqual([{ path: ".env", required: true }]);
    expect(app.environment).toEqual({
      DATABASE_URL: "postgresql://overflow:overflow_local_only@postgres:5432/overflow",
    });
  });

  it("still defines the overflow-postgres-data volume", () => {
    expect(compose.volumes).toHaveProperty("overflow-postgres-data");
  });
});
