import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDockerImageSuite } from "../support/docker-images";

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

// Issue 688: the runtime image must ship production dependencies only,
// declare its health against the readiness endpoint, and be able to write
// its cache as the unprivileged user. These pins hold the Dockerfile text to
// the fix; the "built image" suite below proves the properties on an actual
// build.
describe("production runtime image (issue 688)", () => {
  it("copies the runtime node_modules from a production-only stage, not the build stage", () => {
    expect(dockerfile).toContain("FROM deps AS prod-deps");
    // The wipe matters: a plain `pnpm install --prod` on top of the full
    // install leaves every dev package in the .pnpm virtual store on disk,
    // so the stage must reinstall fresh, not prune in place.
    expect(dockerfile).toContain("rm -rf node_modules");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile --prod");
    expect(dockerfile).toContain("COPY --from=prod-deps /app/node_modules ./node_modules");
    // The build stage's node_modules carries the dev tree (vitest,
    // testcontainers, eslint, jsdom, typescript and ssh2's test-fixture
    // keys); sourcing the runtime copy from it is exactly the defect.
    expect(dockerfile).not.toContain("COPY --from=build /app/node_modules");
  });

  it("declares a HEALTHCHECK probing the readiness endpoint", () => {
    const lines = dockerfile.split("\n");
    // The healthcheck guards the stage that SERVES, so it must sit in the
    // runtime stage — one declared in deps or build would never run against
    // the started server.
    const runtimeAt = lines.findIndex((line) => line.includes("AS runtime"));
    const healthcheckAt = lines.findIndex(
      (line, index) => index > runtimeAt && line.startsWith("HEALTHCHECK"),
    );
    expect(healthcheckAt, "a HEALTHCHECK in the runtime stage").toBeGreaterThan(runtimeAt);
    const healthcheck = lines.slice(healthcheckAt, healthcheckAt + 3).join("\n");
    // bookworm-slim ships neither curl nor wget, so the probe is a node
    // fetch one-liner whose response status drives the exit code.
    expect(healthcheck).toContain("node -e");
    expect(healthcheck).toContain("/api/readiness");
  });

  it("hands an EMPTY .next/cache to the runtime user before dropping privileges", () => {
    const lines = dockerfile.split("\n");
    // The build-stage cache contents are wiped rather than chowned in place:
    // a chown/chmod over the populated cache copies every file into the RUN
    // layer (+80 MB measured), and the host deploy's parity is creating each
    // new release's cache empty — the old cache stays in the old release.
    expect(dockerfile).toContain("rm -rf .next/cache");
    const runtimeAt = lines.findIndex((line) => line.includes("AS runtime"));
    const cacheAt = lines.findIndex((line) => line.includes("chown -R node:node .next/cache"));
    const userAt = lines.findIndex((line) => line === "USER node");
    expect(cacheAt, "the .next/cache ownership line").toBeGreaterThan(runtimeAt);
    expect(userAt, "USER node after the cache handover").toBeGreaterThan(cacheAt);
    expect(dockerfile).toContain("chmod -R u=rwX,g=rX,o=");
  });

  it("disables Next.js telemetry in the build stage before the bundle compiles", () => {
    const buildStage = dockerfile.split("FROM deps AS build")[1]?.split("\nFROM ")[0] ?? "";
    expect(buildStage).toContain("ENV NEXT_TELEMETRY_DISABLED=1");
    expect(buildStage.indexOf("ENV NEXT_TELEMETRY_DISABLED=1"))
      .toBeLessThan(buildStage.indexOf("RUN pnpm build"));
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
  const images = createDockerImageSuite((command, args, options) => execFileSync(command, args, options));

  it(
    "ships a non-empty project LICENSE at /app/LICENSE",
    { timeout: 1_200_000 },
    () => {
      const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      images.withBuiltImage("overflow-576-license", repoRoot, sourceSha, (tag) => {
        // Check the image's file without starting the app or its migrations;
        // --rm cleans up the container even when the license check fails.
        expect(
          () => execFileSync(
            "docker",
            [
              "run",
              "--rm",
              "--entrypoint",
              "test",
              tag,
              "-s",
              "/app/LICENSE",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          ),
          "the built image's /app/LICENSE must exist and be non-empty",
        ).not.toThrow();
      });
    },
  );

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
      images.withBuiltImage("overflow-444-configuser", repoRoot, sourceSha, (tag) => {
        const configUser = JSON.parse(
          execFileSync(
            "docker",
            [
              "image",
              "inspect",
              "--format",
              "{{json .Config.User}}",
              tag,
            ],
            { encoding: "utf8" },
          ),
        ) as string;
        expect(configUser, "the built image's Config.User").not.toBe("");
        const [uid] = configUser.split(":");
        expect(uid.toLowerCase(), "the image runtime user").not.toBe("root");
        expect(uid, "the image runtime uid").not.toBe("0");
      });
    },
  );

  it(
    "ships production dependencies only, with no dev packages left in the virtual store",
    { timeout: 1_200_000 },
    () => {
      const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      images.withBuiltImage("overflow-688-prod-only", repoRoot, sourceSha, (tag) => {
        // Both surfaces are asserted because a plain `pnpm install --prod` on
        // top of a full install empties the top level while leaving every dev
        // package's bytes in the .pnpm virtual store — the deficient first
        // shape of this fix passed the text pins with vitest, ssh2's
        // test-fixture keys and the rest still in the image.
        const devPackages = ["vitest", "eslint", "jsdom", "typescript", "testcontainers", "ssh2"];
        const topLevel = execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--entrypoint",
            "ls",
            tag,
            "/app/node_modules",
          ],
          { encoding: "utf8" },
        );
        const entries = topLevel.split("\n").filter((line) => line !== "");
        const virtualStore = execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "--entrypoint",
            "ls",
            tag,
            "/app/node_modules/.pnpm",
          ],
          { encoding: "utf8" },
        );
        const storeEntries = virtualStore.split("\n").filter((line) => line !== "");
        for (const devPackage of devPackages) {
          expect(entries, "the image's top-level node_modules").not.toContain(devPackage);
          expect(
            storeEntries.filter((entry) => entry.split("@")[0] === devPackage),
            `the .pnpm virtual store must not carry ${devPackage}`,
          ).toEqual([]);
        }
      });
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
