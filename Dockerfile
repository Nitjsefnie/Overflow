# Overflow's OPTIONAL container image (issue 408). The host deployment in
# deploy/README.md stays the default and is untouched by this file.
#
# Build:  docker build -t overflow-app .
# Run:    docker compose --profile app up --build
# The app container applies pending migrations (scripts/migrate.ts) before the
# server starts, and serves on port 3000.

FROM node:24.17.0-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:24.17.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/db ./db
COPY --from=build /app/scripts/migrate.ts ./scripts/migrate.ts
CMD ["sh", "-c", "node --env-file-if-exists=.env scripts/migrate.ts && exec node node_modules/next/dist/bin/next start"]
