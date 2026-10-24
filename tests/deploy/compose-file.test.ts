import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { POSTGRES_IMAGE } from "../support/postgres-container";

interface ComposeService {
  image?: string;
  build?: { context?: string; args?: Record<string, string> };
  pull_policy?: string;
  profiles?: string[];
  restart?: string;
  depends_on?: Record<string, { condition?: string }>;
  env_file?: Array<string | { path: string; required?: boolean }>;
  environment?: Record<string, string>;
  ports?: string[];
  user?: string;
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
  it("defines no service beyond app and postgres", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["app", "postgres"]);
  });

  it("starts the app service only when the app profile is requested", () => {
    const { profiles } = compose.services.app;
    expect(profiles).toContain("app");
  });

  it("leaves the postgres service unchanged", () => {
    const postgres = compose.services.postgres;
    // The same-value check (issue 1335): the helper reads its image from this
    // file, so compose and the DB suites start one written pin. It catches
    // every stale divergence; a re-literalization of POSTGRES_IMAGE to the
    // compose image's CURRENT value is the one shape it cannot see, and the
    // no-literal scan below is what holds that side.
    expect(postgres.image).toBe(POSTGRES_IMAGE);
    expect(postgres.restart).toBe("unless-stopped");
    expect(postgres.healthcheck).toBeDefined();
    expect(postgres.ports).toEqual(["${POSTGRES_HOST_BIND:-127.0.0.1}:${POSTGRES_HOST_PORT:-5432}:5432"]);
  });

  it("healthchecks the app against the readiness endpoint (issue 688)", () => {
    const healthcheck = compose.services.app.healthcheck as Record<string, unknown> | undefined;
    expect(healthcheck, "an app healthcheck beside postgres's").toBeDefined();
    const probe = Array.isArray(healthcheck?.test)
      ? (healthcheck.test as string[]).join(" ")
      : String(healthcheck?.test ?? "");
    expect(probe).toContain("CMD-SHELL");
    expect(probe).toContain("/api/readiness");
    expect(healthcheck?.interval).toBeDefined();
    expect(healthcheck?.timeout).toBeDefined();
    expect(healthcheck?.retries).toBeDefined();
    expect(healthcheck?.start_period).toBeDefined();
  });

  it("starts the app only after postgres reports healthy, on a loopback port by default", () => {
    const app = compose.services.app;
    expect(app.restart).toBe("unless-stopped");
    expect(app.depends_on?.postgres?.condition).toBe("service_healthy");
    expect(app.ports).toEqual(["${APP_HOST_BIND:-127.0.0.1}:3000:3000"]);
  });

  it("runs the image built by the container script instead of building in compose", () => {
    const app = compose.services.app;
    expect(app).not.toHaveProperty("build");
    expect(app.image).toBe("overflow-app");
    expect(app.pull_policy).toBe("never");
  });

  it("leaves the app service's runtime user to the image instead of overriding it", () => {
    const app = compose.services.app;
    expect(app.user).toBeUndefined();
  });

  it("feeds the app .env and pins OVERFLOW_DATABASE_URL at the compose layer", () => {
    const app = compose.services.app;
    const envFiles = (app.env_file ?? []).map((entry) =>
      typeof entry === "string"
        ? { path: entry, required: true }
        : { path: entry.path, required: entry.required ?? true },
    );
    expect(envFiles).toEqual([{ path: ".env", required: true }]);
    expect(app.environment).toEqual({
      OVERFLOW_DATABASE_URL: "postgresql://overflow:overflow_local_only@postgres:5432/overflow",
    });
  });

  it("still defines the overflow-postgres-data volume", () => {
    expect(compose.volumes).toHaveProperty("overflow-postgres-data");
  });

  it("holds no postgres digest literal beside the one compose writes", () => {
    // Issue 1335: the image is written once, in docker-compose.yml. The
    // equality above cannot see a re-literalization of POSTGRES_IMAGE to the
    // compose image's CURRENT value — same value, same green — so this scan
    // is what holds that shape: both files stay literal-free, and a future
    // digest bump touches only docker-compose.yml.
    for (const url of [
      import.meta.url,
      new URL("../support/postgres-container.ts", import.meta.url).href,
    ]) {
      expect(readFileSync(fileURLToPath(url), "utf8")).not.toMatch(/sha256:[0-9a-f]{64}/);
    }
  });

  it("defines no volume beyond overflow-postgres-data", () => {
    expect(Object.keys(compose.volumes).sort()).toEqual(["overflow-postgres-data"]);
  });
});
