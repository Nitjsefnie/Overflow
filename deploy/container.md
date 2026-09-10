# Deploying Overflow as a container (optional)

This is the OPTIONAL container route: an alternative to section 10 of
[README.md](README.md) in this directory, not a replacement for it. The host
path — `scripts/deploy-revision.sh` and the release-symlink model it drives —
stays the default, is what production on this host runs, and is untouched by
anything here. Nothing in this directory's container route is used in
production on this host.

## What you get

`Dockerfile` at the repository root builds the application image in three
stages: `deps` installs the exact locked dependency tree (including the
patched `postgres` client) with corepack-pinned pnpm, `build` compiles the
Next.js production bundle on top of it, and `runtime` carries only the built
output, the migrations, and the code the start command needs onto a clean
`node:24.17.0-bookworm-slim` base. `docker-compose.yml` defines an `app`
service behind the `app` profile alongside the existing `postgres` service, so
a plain `docker compose up -d` still starts the database alone.

## Build and run

Build the image from the repository root:

```console
docker build -t overflow-app .
```

Or let compose build it and bring up the database and app together:

```console
docker compose --profile app up --build
```

On older Docker installs whose compose cannot build (buildx below 0.17.0),
build the image yourself, tag it `<project>-app` for the project name compose
derives from the directory, and start with `docker compose --profile app up -d
--no-build` instead.

The app service needs a `.env` file beside `docker-compose.yml` with the auth
and webhook variables from [.env.example](../.env.example): `AUTH_SECRET`,
`AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`,
`GITHUB_WEBHOOK_URL`, `GITHUB_WEBHOOK_SECRET`, `MODERATOR_GITHUB_USER_IDS`, and
`GITHUB_GRAPHQL_BUDGET_RESERVE`. Compose feeds that file to the container and
then overrides `DATABASE_URL` to reach postgres over the compose network by
service name, so the loopback address a host-side `.env` would carry never
reaches the app.

By default both services bind to loopback — the app on `127.0.0.1:3000`, the
database on `127.0.0.1:5432` — and `APP_HOST_BIND` / `POSTGRES_HOST_BIND`
move or widen those binds deliberately.

## Decisions

**Migrations run at container start, before the server binds.** The start
command is `node --env-file-if-exists=.env scripts/migrate.ts && exec node
node_modules/next/dist/bin/next start`: the migration step shares the
container's fate, and `exec` hands the PID to the server so signals reach it.
This presumes a SINGLE instance per database — two containers starting against
one database race their migrations — so scale to one app container and let the
platform's restart policy, not replicas, absorb failures.

**Configuration is environment-only.** The image carries no values and reads
no files for configuration: everything arrives through the environment, the
same variables the host path keeps in `/etc/overflow/overflow.env`. A container
built from this repository can be inspected, shared and re-tagged without
leaking a secret, and `.dockerignore` keeps `.env` and `.env.*` out of the
build context entirely (only the placeholder `.env.example` remains).

**The image builds in-image on `node:24.17.0-bookworm-slim`.** The same base
that compiles the bundle serves it, and `engines` in `package.json` pins that
Node version for both. Copying the built release out of the image (the host
path's release directories) was rejected because it reintroduces the
artifact-out-of-band problem the container exists to close: the image, not the
tree it was built from, is the deployable unit.

**Rollback is redeploying the previous image tag — the analogue of the
symlink switch.** Where the host path flips `.next` back to the previous
release directory with `pnpm release:switch`, the container path redeploys the
previous tag; data stays in the `overflow-postgres-data` volume either way.
Tag every image you deploy so the previous one is named and recoverable.

## The default path

For the default host deployment — the one production uses — follow
[README.md](README.md) in this directory.
