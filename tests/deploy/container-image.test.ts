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

  it("applies migrations before the server starts", () => {
    expect(dockerfile.indexOf("scripts/migrate.ts")).toBeLessThan(
      dockerfile.indexOf("next start"),
    );
  });

  it("installs dependencies with the frozen lockfile", () => {
    expect(dockerfile).toContain("--frozen-lockfile");
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
