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
base. Both stages pin `node:24.17.0-bookworm-slim` by digest, and the runtime
stage labels every image with the full source revision it was built from — an
image without that label cannot be built (issue 461). `docker-compose.yml`
defines an `app` service behind the `app` profile alongside a `postgres`
service pinned by digest, so a plain `docker compose up -d` still starts the
database alone.

## Build and run

Build with the committed script, from a clean checkout:

```console
scripts/container-build.sh [tag]
```

The script refuses a dirty tree (the revision label must name reviewed
committed source), builds with `SOURCE_SHA="$(git rev-parse HEAD)"`, verifies
the revision label actually landed on the image, and prints the immutable
provenance record — revision, image ID, RepoDigests, created timestamp. Keep
that record with the deployment notes: it is what rollback selects.

Or let compose build it and bring up the database and app together:

```console
SOURCE_SHA="$(git rev-parse HEAD)" docker compose --profile app up --build
```

Both paths build from digest-pinned bases —
`node:24.17.0-bookworm-slim@sha256:862263c612aa437e3037674b85419622a9d93bff80aa1eee5398dfe686375532` for the application image and
`postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73` for the database — so the same source always resolves the
same base bytes. A bare `docker build` without `--build-arg SOURCE_SHA=...`
fails loudly in the Dockerfile's guard instead of producing an unlabelled
image.

On older Docker installs whose compose cannot build (buildx below 0.17.0),
run the script, tag the image `<project>-app` for the project name compose
derives from the directory, and start with `docker compose --profile app up
-d --no-build` instead.

The app service needs a `.env` file beside `docker-compose.yml` with the auth
and webhook variables from [.env.example](../.env.example): `AUTH_SECRET`,
`AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TOKEN_ENCRYPTION_KEY`, `APP_URL`,
`GITHUB_WEBHOOK_URL`, `GITLAB_WEBHOOK_URL`, `MODERATOR_GITHUB_USER_IDS`, and
`GITHUB_GRAPHQL_BUDGET_RESERVE`. Compose feeds that file to the container and
then overrides `DATABASE_URL` to reach postgres over the compose network by
service name, so the loopback address a host-side `.env` would carry never
reaches the app.

By default both services bind to loopback — the app on `127.0.0.1:3000`, the
database on `127.0.0.1:5432` — and `APP_HOST_BIND` / `POSTGRES_HOST_BIND`
move or widen those binds deliberately. `APP_URL` must name the real browsable host: with a placeholder such as `127.0.0.2`, Auth.js logs `[auth][error] UntrustedHost` and refuses every sign-in (observed in this repository's container smoke).

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
that compiles the bundle serves it — both `FROM` lines pinned by digest — and
`engines` in `package.json` pins that Node version for both. Copying the
built release out of the image (the host path's release directories) was
rejected because it reintroduces the artifact-out-of-band problem the
container exists to close: the image, not the tree it was built from, is the
deployable unit.

**The container runs as the base image's non-root `node` account.** The
runtime stage selects `USER node` (UID 1000, shipped by the base image), so
the pre-start migration step and the long-lived server share one non-root
identity: they are the same Node workload, needing only network egress to
Postgres and read access to `/app`, and neither writes to the filesystem, so
a second identity would bound nothing. `docker-compose.yml` deliberately
carries no `user:` override — the image's `USER` is the single source of
truth for the runtime identity, and a test pins both the selection and the
absent override.

**Rollback redeploys a recorded immutable identity, not a mutable tag.**
Where the host path flips `.next` back to the previous release directory with
`pnpm release:switch`, the container path redeploys the image recorded at
build time: the image ID `scripts/container-build.sh` prints in its
provenance record (or, once the image is pushed to a registry, its digest).
Record it when you build, then roll back by re-deploying it:

```console
docker tag <recorded-image-id> overflow-app:rollback
```

then point compose at that image with an override file and redeploy without
building:

```yaml
# docker-compose.override.yml
services:
  app:
    image: overflow-app:rollback
```

```console
docker compose --profile app up -d --no-build
```

The `rollback` tag is a convenience name for the recorded identity, never the
identity itself — tags move, the image ID does not. Data stays in the
`overflow-postgres-data` volume either way.

## What this does not close

Three provenance steps remain outside this repository, and the container
route does not pretend to them. **Publishing to a registry**: `RepoDigests`
stays empty until an image is pushed, so the registry digest — the strongest
immutable identity — exists only after a maintainer publishes one; until
then the image ID is the identity rollback selects. **Signatures and
attestations**: nothing here signs an image or attaches build attestations.
**Automated digest bumps**: these pins go stale the moment a base image is
rebuilt upstream, and nothing here refreshes them mechanically — bumping a
digest is a deliberate hand edit of the Dockerfile, the compose file, or the
CI service image until an automated digest-bump workflow exists.

## The default path

For the default host deployment — the one production uses — follow
[README.md](README.md) in this directory.
