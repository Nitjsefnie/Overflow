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

FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532 AS runtime
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
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/db ./db
COPY --from=build /app/src/lib/db ./src/lib/db
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
# The base image's built-in non-root account: the migration step and the server
# share it (see deploy/container.md, "Decisions").
USER node
CMD ["sh", "-c", "node --env-file-if-exists=.env scripts/migrate.ts && exec node node_modules/next/dist/bin/next start"]
