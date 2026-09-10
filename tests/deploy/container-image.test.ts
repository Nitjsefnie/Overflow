import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(
  new URL("../../Dockerfile", import.meta.url),
  "utf8",
);
const dockerignore = readFileSync(
  new URL("../../.dockerignore", import.meta.url),
  "utf8",
);

/**
 * The base image both FROM lines build on, pinned by digest (issue 461): the
 * tag stays for readability, the digest is what Docker actually pulls, so the
 * same source always resolves the same base bytes. One constant here pins
 * both the FROM lines and the `base.digest` label below — they are a shared
 * literal, and a digest that drifts between them names a different image.
 */
const NODE_BASE_TAG = "node:24.17.0-bookworm-slim";
const NODE_BASE_DIGEST =
  "sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532";

describe("Dockerfile", () => {
  it("pins the deps and runtime stages to the bookworm-slim base image by digest", () => {
    const pinnedFrom = `${NODE_BASE_TAG}@${NODE_BASE_DIGEST}`;
    const occurrences = dockerfile.split(pinnedFrom).length - 1;
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

// Issue 461: an image built from this Dockerfile must be traceable to the
// reviewed source that produced it. A preserved image used to report
// Config.Labels=null — nothing tied the running bytes to a source tree, and
// rollback meant a mutable tag. These pins hold the Dockerfile to the fix.
describe("image provenance (issue 461)", () => {
  it("declares SOURCE_SHA in the runtime stage and binds the revision label to it", () => {
    const arg = dockerfile.split("\n").findIndex((line) => line === "ARG SOURCE_SHA");
    const runtime = dockerfile.split("\n").findIndex((line) => line.startsWith("FROM ") && line.includes("AS runtime"));
    const label = dockerfile.split("\n").findIndex((line) =>
      line.startsWith("LABEL org.opencontainers.image.revision=$SOURCE_SHA"),
    );
    expect(runtime, "the runtime FROM line").toBeGreaterThanOrEqual(0);
    expect(arg, "ARG SOURCE_SHA in the runtime stage").toBeGreaterThan(runtime);
    expect(label, "the revision LABEL using $SOURCE_SHA").toBeGreaterThan(arg);
    expect(dockerfile).toContain(`org.opencontainers.image.base.name="docker.io/library/${NODE_BASE_TAG}"`);
    expect(dockerfile).toContain(`org.opencontainers.image.base.digest="${NODE_BASE_DIGEST}"`);
  });

  it("refuses a build invoked without the SOURCE_SHA provenance, naming the build arg", () => {
    const guard = dockerfile.split("\n").find((line) => line.includes('-z "$SOURCE_SHA"'));
    expect(guard, "the empty-SOURCE_SHA build guard").toBeDefined();
    expect(dockerfile).toContain("SOURCE_SHA build arg");
    // The guard is a real gate, not a note: it must sit between the ARG it
    // reads and the LABEL it protects.
    const arg = dockerfile.indexOf("ARG SOURCE_SHA");
    const guardAt = dockerfile.indexOf('-z "$SOURCE_SHA"');
    const label = dockerfile.indexOf("LABEL org.opencontainers.image.revision");
    expect(guardAt, "the guard after ARG SOURCE_SHA").toBeGreaterThan(arg);
    expect(label, "the LABEL after the guard").toBeGreaterThan(guardAt);
  });
});

// The assertion is against an actually-built image, not the Dockerfile text:
// a text-only guard could not tell a USER line the build ignores from one the
// image carries. The build is slow, so this test owns a long timeout.
describe("built image", () => {
  it(
    "selects a non-root runtime user",
    { timeout: 1_200_000 },
    () => {
      const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
      // The provenance guard (issue 461) refuses a build without the
      // SOURCE_SHA build arg, so this supplies the real HEAD. When the tree
      // is dirty mid-development the arg is a formality for the Config.User
      // assertion below, not a claim about the tree it names; the clean-tree
      // discipline lives in scripts/container-build.sh, which this test does
      // not go through.
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      execFileSync(
        "docker",
        [
          "build",
          "--build-arg",
          `SOURCE_SHA=${sourceSha}`,
          "-t",
          "overflow-444-configuser",
          ".",
        ],
        {
          cwd: repoRoot,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const configUser = JSON.parse(
        execFileSync(
          "docker",
          [
            "image",
            "inspect",
            "--format",
            "{{json .Config.User}}",
            "overflow-444-configuser",
          ],
          { encoding: "utf8" },
        ),
      ) as string;
      expect(configUser, "the built image's Config.User").not.toBe("");
      const [uid] = configUser.split(":");
      expect(uid.toLowerCase(), "the image runtime user").not.toBe("root");
      expect(uid, "the image runtime uid").not.toBe("0");
    },
  );
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
