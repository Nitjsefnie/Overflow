# Deploying Overflow as a container (optional)

This is the OPTIONAL container route: an alternative to section 10 of
[README.md](README.md) in this directory, not a replacement for it. The host
path — `scripts/deploy-revision.sh` and the release-symlink model it drives —
stays the default, is what production on this host runs, and is untouched by
anything here. Nothing in this directory's container route is used in
production on this host.

## What you get

`Dockerfile` at the repository root builds the application image in four
stages: `deps` installs the exact locked dependency tree (including the
patched `postgres` client) with corepack-pinned pnpm, `build` compiles the
Next.js production bundle on top of it, `prod-deps` replaces that tree with
a fresh production-only frozen install (a prune in place would leave the dev
packages behind in pnpm's virtual store), and `runtime` carries the built
output, the
migrations, the production-only dependency tree, and the code the start
command needs onto a clean base. The `deps` and `runtime` stages pin
`node:24.21.0-bookworm-slim` by digest, and the runtime stage labels every
image with the full source revision it was built from — an image without
that label cannot be built (issue 461) — declares a `HEALTHCHECK` against
`/api/readiness`, the endpoint that answers 200 only when the database is
reachable and every migration this build bundles is applied, and hands
`.next/cache` to the runtime user so the server can write its cache, the way
the host path hands the release cache to the service user. `docker-compose.yml`
defines an `app` service behind the `app` profile — carrying the same
readiness healthcheck, in postgres's shape — alongside a `postgres` service
pinned by digest, so a plain `docker compose up -d` still starts the
database alone.

## Build and run

Build from a clean checkout with the committed script. Its default image tag
is `overflow-app`, which the compose app service runs:

```console
scripts/container-build.sh
```

The script requires Node on the build host to run
`scripts/container-base-labels.ts`, which derives
`org.opencontainers.image.base.name` and `org.opencontainers.image.base.digest`
from the Dockerfile's digest-pinned `FROM` references. It refuses a dirty tree
(the revision label must name reviewed committed source), builds with
`SOURCE_SHA="$(git rev-parse HEAD)"` and both derived base labels, verifies
the revision and both base labels actually landed on the image with the
expected values, and prints the immutable provenance record — revision,
image ID, RepoDigests, created timestamp. Keep that record with the deployment
notes: it is what rollback selects.

The script builds from an export of that commit (`git archive`), streamed to
`docker build` as its context, not from the working directory. So untracked
and ignored files never enter the context — including ones `git status` cannot
see because the repository's `.gitignore` denies by default — and the image
holds exactly the source its revision label names. The export is the filter
on this path; `.dockerignore` is not relied on (observed not to apply to a
stdin context with docker 26.1.5).

Run the built image with compose, bringing up the database and app together:

```console
docker compose --profile app up -d
```

Compose consumes the local `overflow-app` and has no app build path (issue
718). It never pulls an app image: if that local tag is absent, compose fails;
build it with the script first. To build under another tag, pass it to
`scripts/container-build.sh [tag]` and point compose at that image with an
override file.

The image builds from digest-pinned bases —
`node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` for the application image and
`postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73` for the database — so the same source always resolves the
same base bytes. A bare `docker build` without `--build-arg SOURCE_SHA=...`
fails loudly in the Dockerfile's guard instead of producing an unlabelled
image.

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
change their host bind addresses deliberately. `POSTGRES_HOST_PORT` changes
the database's host port from its default of `5432`; the container port stays
`5432`. `APP_URL` must name the real public application origin, because the
browser mutation guard accepts only that origin; a missing, malformed or
opaque-origin value refuses those mutations. In production, when `AUTH_URL`,
`AUTH_TRUST_HOST`, `VERCEL` and `CF_PAGES` are all unset, Overflow enables
Auth.js's boolean `trustHost` flag only if `APP_URL` parses to a valid,
non-opaque origin. The first defined override in that order instead decides
the flag: non-empty enables it and empty disables it. This flag does not
compare incoming sign-in hosts against `APP_URL` or select the OAuth origin.

The installed Auth.js packages select that origin from `AUTH_URL` (or its
legacy fallback `NEXTAUTH_URL`) when non-empty, otherwise from the request
URL and headers. Keep any URL override's pathname at `/` or `/api/auth` so
the generated URLs match Overflow's mount, as described in
[API.md](../API.md#browser-authentication-routes). A parseable but wrong
`APP_URL` can enable host trust while refusing browser mutations from the
served origin; it does not itself change GitHub's OAuth callback URL. See the
[environment reference](../OPERATING.md#environment-reference) for the
`APP_URL` and Auth.js overrides.

## Operator ownership

The container route supplies an application image and a Compose database, not
the host deployment's systemd units. Before installing it, name the operator
and record the arrangements below in the deployment notes. Each owner is
**operator supplied**; building the image does not install these services.

| Responsibility | Owner and procedure |
| --- | --- |
| Install | Operator supplied: build and record provenance, configure Compose and secrets, then start the single app instance as above. |
| Health | Operator supplied: monitor the app's `/api/readiness` healthcheck, collect container logs and arrange alerts. Compose supplies the probe and restart policy, not alert delivery. |
| Update | Operator supplied: take a database backup, preserve the previous image identity and configuration, build the reviewed revision, redeploy with Compose and verify readiness. Run the webhook upgrade below after the new release is healthy; keep its output and exit status with the deployment record. |
| Backup | Operator supplied: schedule database dumps, retention, off-host copies and failure alerts; keep custody of the keys needed to decrypt restored credentials. See [Backup and recovery](#backup-and-recovery). |
| Recovery | Operator supplied: own restore drills, database access/ownership, configuration and key recovery, and the decision to restore data or redeploy a compatible recorded image. See [Backup and recovery](#backup-and-recovery) and [rollback](#decisions). |
| Reverse proxy and TLS | Operator supplied: provide the public HTTPS endpoint, proxy to the loopback app listener, renew certificates and verify sign-in and forge callback reachability. Compose supplies neither a reverse proxy nor TLS. Follow the [proxy requirements](README.md#reverse-proxy-requirements) for the application routes. |
| Webhook upgrade | Operator supplied: run `pnpm webhooks:upgrade` from the matching operator checkout below with this deployment's database, keys and callback URLs. Container startup runs migrations, not this upgrade. |
| Decommission | Operator supplied: follow the container mapping in [decommission.md phase 1](decommission.md#1-scope-and-preconditions), including webhook/application removal, database volume, backups, configuration, proxy/TLS and off-host destinations. |

## Operator commands run from a matching checkout

The runtime image is not an operator toolbox. It copies the built application,
database code and migration entry points, but not `scripts/account.ts`,
`scripts/reconcile.ts`, `scripts/upgrade-webhooks.ts`,
`scripts/reencrypt-credentials.ts` or `scripts/register-path-aliases.ts` and
their source dependencies. The package scripts advertised in its `package.json`
do not make those files available. Run the procedures below on an operator
machine from a separate checkout of the **running image's revision**, with its
own dependencies installed; do not run them with `docker compose exec app`.

Find the revision from the image actually used by the running app, rather than
from the mutable `overflow-app` tag. Run this in the deployment's Compose
directory, with the same project and override options used to deploy:

```sh
set -e
container_id=$(docker compose --profile app ps -q app)
test -n "$container_id"
image_id=$(docker inspect --format '{{.Image}}' "$container_id")
revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")
test "${#revision}" -eq 40
case "$revision" in
  *[!0-9a-f]*) echo 'Missing or malformed source revision label' >&2; exit 1 ;;
esac
printf 'Running image revision: %s\n' "$revision"
```

`Dockerfile` records that OCI label from `SOURCE_SHA`;
`scripts/container-build.sh` exports the clean commit, verifies the label and
prints the same revision with the image ID. If the app is stopped or the local
image is unavailable, use the provenance record saved at build/deploy time to
select the image and its revision. An absent label or missing source commit
must be investigated before choosing an operator checkout.

With `revision` set to that full commit, prepare a new operator checkout:

```sh
git clone https://github.com/Nitjsefnie/Overflow.git overflow-operator
cd overflow-operator
git fetch origin "$revision"
git checkout --detach "$revision"
test "$(git rev-parse HEAD)" = "$revision"
pnpm install --frozen-lockfile
```

Use the Node and pnpm versions recorded in that checkout's `package.json`.
Keep this checkout separate from the Compose deployment directory so checking
out an older revision cannot replace the live Compose configuration. Repeat
the revision selection and dependency install after every image change.

Load an operator-owned, private, shell-compatible environment file outside the
checkout before invoking the commands; these package scripts do not load
Compose's `.env` themselves:

```sh
set -a
. /absolute/path/container-operator.env
set +a
```

Its `DATABASE_URL` must reach the **same database** from the operator machine.
Compose's `postgres` hostname is for the app's container network; on the Docker
host use the published database address and `POSTGRES_HOST_PORT` (loopback and
5432 by default), with that database's credentials. Do not assume the URL in
the deployment's `.env` is the app's URL: Compose overrides it. For a remote
operator machine, arrange a private connection to that database.

Supply the same `TOKEN_ENCRYPTION_KEY`, any configured
`TOKEN_ENCRYPTION_KEY_PREVIOUS`, callback URLs and other relevant deployment
variables. When GitHub App authentication is configured, make the **same
private-key file** readable on the operator machine and set
`GITHUB_APP_PRIVATE_KEY_PATH` to its local path, with the same `GITHUB_APP_ID`;
the container's mount path need not exist on that machine. Do not generate
replacement keys merely to make a command start, or store credentials in the
checkout or deployment record.

| Procedure | Run in the prepared operator checkout |
| --- | --- |
| Credential encryption-key rotation | `pnpm credentials:reencrypt`, followed by `pnpm credentials:reencrypt --check`. Follow the key overlap, backup, verification and retirement order in [README section 11](README.md#11-rotating-the-credential-encryption-key), substituting the container's secret configuration and app recreation for the host environment edits and systemd restarts. Keep app and operator keys synchronized throughout. |
| Account export or deletion; forge-person export or removal | Run the `node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts ...` commands in [OPERATING.md](../OPERATING.md#running-the-commands). Substitute this checkout and environment for `/srv/overflow` and `/etc/overflow/overflow.env`; preserve the dry run and `--confirm` steps. |
| Manual reconciliation | `pnpm reconcile` for every active registration, or `pnpm reconcile --repository <owner>/<name>` for one; see [OPERATING.md](../OPERATING.md#reconciliation). |
| Existing webhook upgrade | `pnpm webhooks:upgrade` after deploying and verifying the image; follow [OPERATING.md](../OPERATING.md#upgrade-existing-webhook-subscriptions) for prerequisites, failures and output. |
| Database backup and restore | Run `scripts/db-backup.sh` and `scripts/db-restore.sh` from this checkout with PostgreSQL client tools and database access as below; neither script is in the app image. |

## Backup and recovery

The named `overflow-postgres-data` volume persists database files; it is not a
backup. Compose defines no backup job. The operator supplies scheduling,
storage, retention, off-host copies, key custody and alerts, independently of
the app container. The host-specific units and paths in
[backup-restore.md](backup-restore.md) are a reference, not something this
Compose route installs.

From the matching operator checkout, install PostgreSQL client tools matching
the deployment's server major (17 in the committed Compose file). With a
backup-role `DATABASE_URL` pointing at that deployment and a private backup
directory selected, run:

```sh
sh scripts/db-backup.sh --output-dir /absolute/path/private-backups
```

For a restore drill, provision a separate target database and a role that can
restore into it, and set `DATABASE_URL` for that server/role. For the invocation
below, the URL's database name must differ from `overflow_restore_drill`:
the script refuses an equal target without `--allow-live`. Then run:

```sh
sh scripts/db-restore.sh overflow_restore_drill /absolute/path/private-backups/selected.dump
```

The restore script substitutes the target database name in `DATABASE_URL` and
refuses to overwrite the database the URL names unless `--allow-live` is
passed. It restores with `--no-owner --no-privileges`; the operator must supply
the target, role and grants. Use the [restore drill and replacement procedure](backup-restore.md#e-restoring)
for the data/schema checks, adapting its local PostgreSQL commands and service
control to this deployment. Run any required `pnpm db:migrate` from the
matching checkout against the **restore target**, not the live database.

For live recovery, stop the app and operator jobs before replacing data;
keep PostgreSQL available until the restore and validation are complete.
Restore the deployment configuration and keys alongside the database, recreate
the app with that configuration, and verify readiness, sign-in and webhook
processing before resuming jobs. Image rollback preserves the existing database
volume and does not undo migrations; verify schema compatibility with the
selected image, or restore the corresponding pre-update backup first. The
operator owns this recovery decision and records the drill and recovery results.

## Decisions

**Migrations run at container start, before the server binds.** The start
command is `node --env-file-if-exists=.env scripts/migrate.ts && exec node
node_modules/next/dist/bin/next start`: the migration step shares the
container's fate, and `exec` hands the PID to the server so signals reach it.
This presumes a SINGLE instance per database — two containers starting against
one database race their migrations — so scale to one app container and let the
platform's restart policy, not replicas, absorb failures.

**Configuration arrives at runtime.** Compose supplies `.env` variables through
`env_file` and overrides `DATABASE_URL`. When GitHub App authentication is
configured, the code also reads the private-key file named by
`GITHUB_APP_PRIVATE_KEY_PATH`: the operator must supply a read-only mount in a
Compose override and make it readable by the runtime user. The committed
Compose file does not mount it. Private `.env` files stay out of the build
context because the script exports only committed files with `git archive`.
Keep key files outside the tracked source and build context too.

**The image builds in-image on `node:24.21.0-bookworm-slim`.** The same base
that compiles the bundle serves it — both `FROM` lines pinned by digest — and
the image's Node base can receive non-major updates within Node 24, while `engines` in
`package.json` pins the Node version CI and the host deployment use. Copying the
built release out of the image (the host path's release directories) was
rejected because it reintroduces the artifact-out-of-band problem the
container exists to close: the image, not the tree it was built from, is the
deployable unit.

**The container runs as the base image's non-root `node` account.** The
runtime stage selects `USER node` (UID 1000, shipped by the base image), so
the pre-start migration step and the long-lived server share one non-root
identity: they are the same Node workload, needing only network egress to
Postgres, read access to `/app`, and one writable directory. The server
writes its Next.js cache to `.next/cache` at runtime, so the runtime stage
hands that directory to `node` with `chown -R node:node` and
`chmod -R u=rwX,g=rX,o=` — the exact mode the host deploy gives the release
cache — while everything else under `/app` stays root-owned and read-only.
That single writable directory is not a second capability a dedicated
identity would bound further, so a second identity would still bound
nothing. `docker-compose.yml` deliberately carries no `user:` override — the
image's `USER` is the single source of truth for the runtime identity, and a
test pins both the selection and the absent override.

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
rebuilt upstream. Docker Dependabot scans only the root Dockerfile and proposes
tag-and-digest updates to its `FROM` lines; Node majors remain ignored pending
review on/after 2026-10-28. Both build paths derive the base provenance labels
from those `FROM` references automatically, and the tests derive their
expectations from the runtime `FROM` line; no manual label or test constant
update is needed. The compose and CI service PostgreSQL digests have no
proposal lane and remain hand edits.

## The default path

For the default host deployment — the one production uses — follow
[README.md](README.md) in this directory.
