# Overflow's OPTIONAL container image (issue 408). The host deployment in
# deploy/README.md stays the default and is untouched by this file.
#
# Build:  scripts/container-build.sh [tag]
# Run:    docker compose --profile app up --build
#         (export SOURCE_SHA="$(git rev-parse HEAD)" first — the script and the
#         compose build arg both require it; an unlabelled image cannot be built)
#         On older Docker installs whose compose cannot build (buildx below
#         0.17.0), tag the built image <project>-app instead and run:
#         docker compose --profile app up -d --no-build
# The app container applies pending migrations (scripts/migrate.ts) before the
# server starts, and serves on port 3000.

FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Next.js prints its telemetry notice and phones home on every production
# build unless disabled (issue 688): the build host opts out the same way the
# runtime stage below already does.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# Production-only dependency stage (issue 688): `deps` installs the dev tree
# too (vitest, testcontainers, eslint, jsdom, typescript, and the ssh2
# package's test-fixture keys through testcontainers), and the runtime image
# must ship none of it. A plain `pnpm install --prod` on top of the full
# install empties the top level but LEAVES THE DEV PACKAGES in the .pnpm
# virtual store on disk (observed: `Packages: -519` reported yet 591 entries
# remain, ssh2's test-fixture keys included) — so node_modules is wiped and
# the prod-only frozen install runs fresh, hardlinking out of the store this
# stage inherits. The patched postgres client still resolves at the
# lockfile's patch hash.
FROM deps AS prod-deps
RUN rm -rf node_modules \
  && pnpm install --frozen-lockfile --prod

FROM node:26.10.0-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2 AS runtime
# Immutable provenance (issue 461). An image built from this Dockerfile must
# name the exact source it was built from: a preserved image used to report
# Config.Labels=null, with nothing tying the running bytes to a reviewed
# commit. So the revision label is mandatory, not decorative — the guard
# below refuses any build invoked without the SOURCE_SHA build arg, and the
# SHA it wants is `git rev-parse HEAD` of a clean tree
# (scripts/container-build.sh does both). A bare `docker build` without
# provenance fails here, loudly, instead of producing exactly the unlabelled
# image the issue reports.
ARG SOURCE_SHA
RUN if [ -z "$SOURCE_SHA" ]; then \
      echo >&2 "ERROR: the SOURCE_SHA build arg is empty — an image without it carries no source revision. Build with scripts/container-build.sh, or pass --build-arg SOURCE_SHA=<git rev-parse HEAD of a clean tree>."; \
      exit 1; \
    fi
LABEL org.opencontainers.image.revision=$SOURCE_SHA \
      org.opencontainers.image.base.name="docker.io/library/node:24.17.0-bookworm-slim" \
      org.opencontainers.image.base.digest="sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532"
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/db ./db
COPY --from=build /app/src/lib/db ./src/lib/db
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
COPY --from=build /app/LICENSE ./LICENSE
# Next.js writes its cache (.next/cache) at runtime, and the unprivileged
# server cannot create it under the root-owned .next the build stage copied.
# The host deploy creates each new release's cache EMPTY and hands it to the
# service user with exactly this mode (scripts/deploy-revision.sh) — the old
# cache stays in the old release — and the container mirrors that: the
# build-stage cache contents are wiped rather than chowned in place, because
# a chown/chmod over the populated cache would copy every file into this RUN
# layer (+80 MB measured). The directory exists, is owned by node, and is
# repopulated as the server runs (issue 688). Runs as root, before the
# privilege drop.
RUN rm -rf .next/cache \
  && mkdir -p .next/cache \
  && chown -R node:node .next/cache \
  && chmod -R u=rwX,g=rX,o= .next/cache
# Health against the readiness endpoint (issue 439, 688): it answers 200 only
# when the database is reachable and every migration this build bundles is
# applied. bookworm-slim ships neither curl nor wget, so the probe is a node
# fetch one-liner whose response status drives the exit code.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/readiness').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# The base image's built-in non-root account: the migration step and the server
# share it (see deploy/container.md, "Decisions").
USER node
CMD ["sh", "-c", "node --env-file-if-exists=.env scripts/migrate.ts && exec node node_modules/next/dist/bin/next start"]
