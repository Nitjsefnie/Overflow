import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../../Dockerfile", import.meta.url),
  "utf8",
);
const dockerignore = readFileSync(
  new URL("../../.dockerignore", import.meta.url),
  "utf8",
);

describe("Dockerfile", () => {
  it("builds the deps and runtime stages on the pinned bookworm-slim base image", () => {
    const baseImage = "node:24.17.0-bookworm-slim";
    const occurrences = dockerfile.split(baseImage).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("bakes no secret into an ENV or ARG line", () => {
    const secretEnv =
      /^\s*(?:ENV|ARG)\b.*(?:AUTH_SECRET|AUTH_GITHUB_SECRET|TOKEN_ENCRYPTION_KEY|GITHUB_WEBHOOK_SECRET|MODERATOR_GITHUB_USER_IDS)/;
    const offenders = dockerfile.split("\n").filter((line) => secretEnv.test(line));
    expect(offenders).toEqual([]);
  });

  it("runs the container in production mode", () => {
    expect(dockerfile).toContain("NODE_ENV=production");
  });

  it("applies migrations before the server starts inside the CMD that executes", () => {
    const cmd = dockerfile.split("\n").find((line) => line.startsWith("CMD ["));
    expect(cmd, "the CMD exec-array line").toBeDefined();
    const migration = "node --env-file-if-exists=.env scripts/migrate.ts";
    const server = "node node_modules/next/dist/bin/next start";
    expect(cmd).toContain(migration);
    expect(cmd).toContain(server);
    expect(cmd!.indexOf(migration)).toBeLessThan(cmd!.indexOf(server));
    // `exec` hands the PID to the server, so containerd's signals reach it —
    // the property deploy/container.md's start-command note rests on.
    expect(cmd).toContain(`exec ${server}`);
  });

  it("installs dependencies with the frozen lockfile", () => {
    expect(dockerfile).toContain("--frozen-lockfile");
  });

  it("builds the bundle on top of the locked dependency stage", () => {
    expect(dockerfile).toContain("FROM deps AS build");
  });

  it("ships the migration step's database client into the runtime stage", () => {
    expect(dockerfile).toContain("COPY --from=build /app/src/lib/db ./src/lib/db");
  });
});

describe(".dockerignore", () => {
  it("keeps secrets, dependencies and build output out of the build context", () => {
    const lines = dockerignore.split("\n").map((line) => line.trim());
    for (const pattern of [".env", "node_modules", ".next", ".git"]) {
      expect(lines).toContain(pattern);
    }
  });
});

describe("deploy/container.md", () => {
  it("warns that APP_URL must name the real browsable host or Auth.js refuses sessions", () => {
    const containerDoc = readFileSync(
      new URL("../../deploy/container.md", import.meta.url),
      "utf8",
    );
    const guidance = containerDoc
      .split("\n")
      .find((line) => line.includes("APP_URL") && line.includes("UntrustedHost"));
    expect(guidance, "the Auth.js trust guidance line naming APP_URL and UntrustedHost").toBeDefined();
  });
});
