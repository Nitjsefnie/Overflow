# Deploying Overflow as an unprivileged service

`overflow.service` in this directory is the systemd unit the production
deployment runs. It starts Next as the dedicated `overflow` system account, with
the filesystem read-only apart from one cache directory, no capabilities, and no
path under `/root`. `tests/deploy/unit-file.test.ts` fails if any of that is
removed from the unit — and also if a `[Service]` directive is *added* to it or
given a value other than the reviewed one, because the reviewed set there is
closed on both, and if the file uses a shape of systemd's grammar the guard does
not model rather than guessing at it.

This file is the procedure that makes a host match what the unit expects. The
commands are run as root. Everything except the running service is root-owned:
the service account can read the code it executes and cannot write it, so
code execution inside the web process cannot rewrite what the next restart runs.

The optional container route — an alternative to section 10's host procedure, not used in production on this host — lives in [container.md](container.md).

Backing the production database up and restoring it — the least-privilege backup role, the daily `overflow-backup.timer`, the exact restore steps and the drill procedure — lives in [backup-restore.md](backup-restore.md).

Values used throughout: deployment tree `/srv/overflow`, service account
`overflow:overflow`, Node 24.17.0 at `/usr/local/lib/nodejs/node-v24.17.0`,
secrets in `/etc/overflow/overflow.env`, listener `127.0.0.1:3000` behind nginx.

The unit assumes the database is local. It carries `Requires=postgresql.service`
alongside `After=postgresql.service`, as the unit it replaces did.
`Requires=` propagates stops, so taking Postgres down for maintenance takes
Overflow down with it, and Overflow does not come back on its own when Postgres
returns — restart it. On a host whose database is remote there is no
`postgresql.service` to require and the unit refuses to start at all: drop both
`postgresql.service` references from `[Unit]` and keep
`After=network-online.target`.

## 1. Keep the unit you are replacing

On a host that already runs Overflow, save the current unit before touching
anything. This copy is the rollback in section 9, and it is the only one: the
unit lives only in `/etc/systemd/system`, so `systemctl revert` — which exists to
drop overrides of a vendor-supplied unit under `/usr/lib/systemd/system` — has
nothing to revert to here.

```bash
cp -a /etc/systemd/system/overflow.service /root/overflow.service.pre-hardening
```

Leave the previous checkout and Node installation in place until the hardened
service has been running long enough to trust. Rollback needs them.

## 2. Create the service account

A system account with no login shell and no password. Its home is the
deployment tree, which is why the tree lives under `/srv`: the unit sets
`ProtectHome=yes`, which makes `/home`, `/root` and `/run/user` unreachable to
the service, and a home directory under `/home` would be hidden from the process
that owns it.

```bash
groupadd --system overflow
useradd --system --gid overflow --home-dir /srv/overflow \
  --shell /usr/sbin/nologin --no-create-home overflow
```

## 3. Install the Node runtime outside /root

`/root` is mode `0700`, so an unprivileged account cannot reach a runtime
installed under it — including an nvm installation in root's home. Install the
pinned version system-wide and symlink the binary the unit names.

```bash
cd /tmp
curl -fsSLO https://nodejs.org/dist/v24.17.0/node-v24.17.0-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v24.17.0/SHASUMS256.txt
grep node-v24.17.0-linux-x64.tar.xz SHASUMS256.txt | sha256sum --check
mkdir -p /usr/local/lib/nodejs
tar -xJf node-v24.17.0-linux-x64.tar.xz -C /usr/local/lib/nodejs
mv /usr/local/lib/nodejs/node-v24.17.0-linux-x64 /usr/local/lib/nodejs/node-v24.17.0
ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/node /usr/local/bin/node
/usr/local/bin/node --version
```

The last command must print `v24.17.0`.

The package manager is needed for installs, migrations and builds, all of which
run as root. The service never runs it, so the corepack shims go in
`/usr/local/sbin`, which the unit's `PATH` of `/usr/local/bin:/usr/bin:/bin` does
not reach and root's default `PATH` does.

```bash
ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/corepack /usr/local/sbin/corepack
corepack enable --install-directory /usr/local/sbin
corepack prepare pnpm@10.33.0 --activate
pnpm --version
```

The last command must print `10.33.0`, the version `package.json` pins.

## 4. Create the environment file

The secrets file holds `DATABASE_URL`, `AUTH_SECRET`, the OAuth credentials,
`TOKEN_ENCRYPTION_KEY` (with `TOKEN_ENCRYPTION_KEY_PREVIOUS` beside it only
while section 11's key rotation is under way) and the webhook secret; the repository's own `README.md`
says what each one is. This section is only about where the file lives and who
may read it.

systemd reads `EnvironmentFile=` as PID 1, before it drops to `User=overflow`,
so the service account does not need to read the file and is not given a way
to. Root-only is therefore the narrowest setting that still works, and it is
what makes code execution inside the web process a dead end for the secrets:
there is no on-disk read path from the service account to any of them.

```bash
install -d -o root -g root -m 0700 /etc/overflow
[ -e /etc/overflow/overflow.env ] \
  || install -o root -g root -m 0600 /dev/null /etc/overflow/overflow.env
chown root:root /etc/overflow/overflow.env
chmod 0600 /etc/overflow/overflow.env
```

The `[ -e ]` guard is what makes this safe on a host that already runs
Overflow: `install` would otherwise truncate the secrets that are already
there. Populate the file before section 5 — its migration step reads
`DATABASE_URL` out of it.

## 5. Build the deployment tree

Clone, install, migrate and build as root, with the production settings loaded
from the environment file so the `db:migrate` script reaches the right database.
Run these blocks in Bash and stop on a failed command; `set -e` makes a pasted
block stop too, before a failed build can be switched into service.

A first installation has no serving release: nothing serves while this section
runs, and the release built here first serves after its switch, when section 6
starts the service. The migrate-then-build window that section 10's migration
check guards does not exist on this path — there is no previous release to
serve against the new schema — so the check is not part of this flow. A host
being hardened by sections 1 and 6 is the exception: its old deployment still
serves from the previous checkout while this section runs, so section 10's
migration check applies on that path too. Carry the check out before this
section's migrate step, treat whatever is serving at migrate time as the
previous release for the test, and stop to split the change across deploys
instead of running the block below if a migration fails it.

```bash
set -e
git clone https://github.com/Nitjsefnie/Overflow.git /srv/overflow
cd /srv/overflow
npm_config_package_import_method=copy pnpm install --frozen-lockfile
set -a; . /etc/overflow/overflow.env; set +a
pnpm db:migrate
release=".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)"
mkdir "$release"
node scripts/release.ts prepare /srv/overflow "$release"
NEXT_DIST_DIR="$release" pnpm build
```

Each build gets a new directory at the tree root, alongside `.next`, named
`.next-release-<YYYYMMDDTHHMMSSZ>-<7 to 40 lowercase hex characters>`.
The UTC timestamp makes the names sort in deployment order, and the SHA
identifies the source revision. The explicit `--short=7` requests at least seven
hexadecimal characters even when `core.abbrev` is shorter. `prune` deletes
directories and the `<release>.tsconfig.json` sidecars beside them, so it only
touches names matching this grammar to be certain they are ones the deployment
procedure created. A directory named `.next-release-notes` is safe beside the releases:
`prune` ignores it entirely, including when counting retention slots. Reserve
matching names for releases; the name check does not prove a build succeeded.
`mkdir` deliberately has no `-p`: a collision must stop the deploy, not reuse an
existing build. Never build into `.next` on a serving host, or reuse a release
directory, even to retry a failed build.

The release directory must be one path segment deep. The tracked `tsconfig.json`
includes `.next/types/**/*.ts`, and Next generates `<distDir>/types/validator.ts`
with relative imports back to the project's `src` directory. TypeScript resolves
those imports lexically through the `.next` include, without following the
symlink. A nested layout such as `.next-releases/<id>` generates `../../../src/...`
imports, which land one directory above the project when read as
`.next/types/validator.ts`. Keeping the release beside `.next` gives both paths
the same depth. Release builds also isolate their generated types as described
below, so a validator from the serving release cannot prevent a route from
being removed.

`next.config.ts` reads `NEXT_DIST_DIR` for this build only. It trims the value
and rejects either path separator (`/` or `\`), absolute paths, `.` (zero depth),
`..` and an existing symlink at the output path. Use a single directory name inside
the tree, as above, with no `./` prefix or trailing slash. With the variable unset or blank,
the local `build` script still uses `.next`. Do not export
`NEXT_DIST_DIR` for the service or add it to `/etc/overflow/overflow.env`:
`next start` uses `.next` at runtime, with the variable unset.

Before each release build, run
`node scripts/release.ts prepare <tree> <releaseDir>` with the same release name
used for `NEXT_DIST_DIR`. It generates the ignored `<releaseDir>.tsconfig.json`
beside the release directory, preserving the tracked `tsconfig.json` compiler
settings and source includes while removing all `.next*` includes. Each release
has its own config; for example, `.next-release-20260907T101500Z-abc1234` uses
`.next-release-20260907T101500Z-abc1234.tsconfig.json` at the tree root.

**Skipping preparation now fails loudly.** With `NEXT_DIST_DIR` set,
`next.config.ts` refuses a missing, stale or invalid generated config before
Next can create defaults or consume it for type checking. The error prints the
preparation command to run. A config left by a previous release cannot satisfy
this check. The generated file must be a regular file, name the intended release,
and match fingerprints of both the tracked input and the prepared configuration.
Changing tracked compiler options after preparation or editing the generated
settings requires running preparation again.

Next uses the checked file through `typescript.tsconfigPath`, appends the current
release's type entries, and type-checks those validators. The fingerprint allows
those specific additions. Preparation accepts TypeScript config comments and
trailing commas using the installed TypeScript parser. It requires an explicit
`include` array of strings and rejects `extends` and `references` with a diagnostic
naming the unsupported property: Next 16.3.4 skips automatic type-include updates
for those shapes. Keep the tracked config self-contained. `releaseConfig` is
reserved for the generated preparation metadata.

Next also regenerates the ignored `next-env.d.ts`. Release builds leave the
tracked `tsconfig.json` untouched, including on failure, so no restore step is
needed. With `NEXT_DIST_DIR` unset or blank, the preparation check does no
filesystem work; local development uses the tracked config and the running
service continues to use `.next`. Start a deploy with a clean tracked tree.

Then set the ownership the unit assumes. The tree is root-owned and readable by
the `overflow` group; nothing in it is group-writable.

```bash
chown -R root:overflow /srv/overflow
chmod -R u=rwX,g=rX,o= /srv/overflow
```

The install commands here and in section 10 set
`npm_config_package_import_method=copy` for each invocation, importing package
files into private inodes instead of hardlinking the shared store.
Ownership and mode resets therefore leave the store and unrelated checkouts'
package files untouched. Existing deployments must first complete section 10's
one-time dependency migration: an unchanged install does not replace old
hardlinks. This addresses [issue 214](https://github.com/Nitjsefnie/Overflow/issues/214)
without changing the permissions the service needs inside the deployment tree.

`next start` writes inside `.next/cache` — the image optimizer's output and the
`.previewinfo` and `.rscinfo` files — and that directory is the only one the
unit makes writable. The cache now lives inside the new release. Create it and
hand it to `overflow` before switching and starting the service: `ReadWritePaths`
naming a missing path is a start failure, and a root-owned cache is not writable
by the service account.

```bash
mkdir -p "$release/cache"
chown -R overflow:overflow "$release/cache"
chmod -R u=rwX,g=rX,o= "$release/cache"
pnpm release:switch /srv/overflow "$release" --expect-current absent
```

The `release:switch` package script takes `<tree> <releaseDir>` and runs
`node scripts/release.ts switch <tree> <releaseDir>`; a relative release argument
is relative to the tree. Passing `--expect-current <absent|path>` makes the
switch conditional: it refuses unless `.next` still resolves to `<path>` at
switch time, or to nothing at all when the value is `absent`; the deploy
procedure always passes it. The resolved directory must be a direct child of the
canonical tree, whether the argument is relative, absolute or a symlink alias.
A symlink to a nested or outside build is refused; an alias resolving to a
valid direct child is accepted.
`switch` also refuses a resolved directory name that does not match the release
grammar above. Inventing a name therefore produces a clear failure instead of
selecting a release that silently accumulates because `prune` cannot manage it.
The script requires a real `BUILD_ID` file and a real `cache` directory, refuses
symlinks for those two markers, then renames a temporary relative symlink over
`.next` and prints the resolved release path.
That rename keeps an existing `.next` symlink resolvable throughout the swap.
The marker checks do not validate every manifest or prove that a build succeeded;
the successful build and the service verification remain required.

`node scripts/release.ts check <tree> <releaseDir>` runs the same candidate
checks as `switch`: resolved depth, release name, `BUILD_ID` file and `cache`
directory, without following symlinks for either marker. It prints the resolved
path and changes nothing on disk. It can check a candidate while `.next` is
still a real directory; `switch` continues to require the one-time migration
below before replacing that directory.

The unit stays unchanged for this layout. Every path it names still reads
`/srv/overflow/...`, including `ReadWritePaths=/srv/overflow/.next/cache`.
On this host, `next start` served routes, static assets and RSC requests with
HTTP `200` and no missing-manifest errors through the `.next` symlink, with
`NEXT_DIST_DIR` unset at runtime. systemd resolved the writable cache path through
the symlink too: the sandboxed process could write in that cache and got `EROFS`
everywhere else. No service environment change or unit edit is needed.

### One-time migration from a real .next directory

An existing host has a real `/srv/overflow/.next` directory. A symlink cannot
be renamed over a real directory; `scripts/release.ts switch` refuses it with a
one-time migration message rather than deleting the serving build silently.

Unlike a first installation, this host has a serving release throughout:
section 10's block migrates and builds while the current release keeps
serving, and the release built here starts serving only at this subsection's
switch. Section 10's migration check therefore applies on this path too —
carry it out before running section 10's block, and stop to split the change
across deploys instead of running the block if a migration fails it.

**Use the same Bash shell for section 10's preparation and this migration block.**
Follow section 10 through config preparation, the build, ownership reset,
new cache handover and previous/new build printout, stopping before its switch
and restart lines. The reset excludes the serving cache, which is still in the
real `.next` directory on this host; leave that directory in place while
preparing the new release. Replace section 10's switch and restart lines with
the block below, pasted into that same shell so `$release` still names the
completed new build. In a separate shell, `${release:?}` stops with `parameter
null or not set` before removal and leaves the old `.next` intact:

```bash
set -e
cd /srv/overflow
test -d /srv/overflow/.next
test ! -L /srv/overflow/.next
node scripts/release.ts check /srv/overflow "${release:?}"
rm -rf -- /srv/overflow/.next
pnpm release:switch /srv/overflow "$release" --expect-current absent
systemctl restart overflow.service
```

The candidate check must succeed before removal, so a malformed name, wrong
depth or invalid build marker leaves the serving directory in place.
This one deploy still hits the old missing-build window: removing the real
`.next` can break requests until the symlink is installed and the service
restarted. It is the last deploy that needs that removal; later builds leave
the serving release in place. Build and prepare the new release first to keep
this window to the removal, switch and restart, rather than the whole build.
The removed directory provides no release-level rollback. If switching fails
after removal, keep the completed new release, correct the reported failure
and rerun the switch and restart; do not start another build into `.next`.
A refused switch can leave `.next` a symlink, so re-running this block aborts
at `test ! -L /srv/overflow/.next`; that abort is the signal to recover through
the standing section 10 procedure, which expects the symlink layout. Continue
with section 10's verification before pruning.

## 6. Install the unit and switch onto it

```bash
systemctl show overflow.service -p MainPID --value > /run/overflow-preswitch-mainpid
install -o root -g root -m 0644 \
  /srv/overflow/deploy/overflow.service /etc/systemd/system/overflow.service
systemd-analyze verify /etc/systemd/system/overflow.service
systemctl daemon-reload
systemctl enable overflow.service
systemctl restart overflow.service
```

`systemd-analyze verify` prints nothing and exits 0 for a well-formed unit; it
names any directive systemd does not recognise.

The `restart` is the switchover, and it is separate from `enable` on purpose.
`--now` on `enable` means *start* — `man systemctl`: "also start/stop/try-restart
the units after the specified unit file operations succeed" — and `start` on a
unit that is already active is a no-op with no job and no message. On the host
section 1 is written for, the old root process would keep serving while systemd
held the new unit file loaded and unapplied, and section 7 would report the new
unit's `User=` beside a `ps` line owned by `root`. The recorded `MainPID` is
what section 7 compares against; on a host that has never run Overflow it is
`0`, which is the same evidence read the same way.

## 7. Verify

Wait for the HTTP readiness check to succeed before inspecting the process
owner. Keep that order when pasting the commands separately too.

```bash
set -e
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/readiness
printf 'MainPID before the switch: %s\nMainPID now:               %s\n' \
  "$(cat /run/overflow-preswitch-mainpid)" \
  "$(systemctl show overflow.service -p MainPID --value)"
systemctl show overflow.service \
  -p MainPID -p User -p Group -p NoNewPrivileges -p ProtectSystem
ps -o user=,pid=,args= -p "$(systemctl show overflow.service -p MainPID --value)"
```

Expected: `active`; `200` from curl — the readiness endpoint answers `200` only
when PostgreSQL is reachable (a bounded probe: at most a few seconds, ~3 s worst
case), so a `200` here is a real dependency check, not a bare port probe; the
two `MainPID` values differ and the current
one is not `0`; `User=overflow`, `Group=overflow`, `NoNewPrivileges=yes`,
`ProtectSystem=strict`; one `ps` line, owned by `overflow` and never `root`.

The two `MainPID` values are the check that distinguishes a switch from a
reload. `systemctl show` reports the merged effective configuration, so it answers
`User=overflow` from the moment `daemon-reload` runs, whether or not anything
restarted; only a new PID says the process serving requests is the one the
hardened unit started. A pair that has not moved means the old process is still
serving and section 6's `restart` did not run.

A host drop-in under `/etc/systemd/system/overflow.service.d/` can override the
installed unit. Section 6 installs only `overflow.service`; the repository guard
does not inspect host drop-ins. The `systemctl show` check above reveals overrides
to the properties it lists because it reports the merged configuration, including
drop-ins, rather than just the unit file.

Two details in those commands are the point of them. Ask `systemctl` for the
PID instead of asking `ps` for Node processes: `ps -C node` matches on `comm`,
and Next rewrites its process title to `next-server (v…`, so `ps -o user= -C
node` never sees this service at all and answers `root` from whatever unrelated
Node processes the host happens to run — the alarming answer whether the
hardening worked or not. And `Type=simple` has no readiness barrier, so
`systemctl start` returns as soon as the process is forked, before the drop to
`overflow` and before Next binds the port. An early `ps` can therefore print
`root` for a process still starting. The curl retry absorbs that readiness race;
only inspect the PID and owner after it succeeds, so a connection refusal or
the transient startup owner is not mistaken for a failed deploy.

`systemd-analyze security overflow.service` reports the remaining exposure and
is worth reading after any change to the unit.

Restrictions only bite on the code paths that use them, so exercise the
application through the browser before calling the switch done: sign in with
GitHub, open the dashboard, and register a repository. That is what makes DNS
resolution, an outbound HTTPS call to GitHub and a database write happen inside
the sandboxed process; the `reconcile` package script does not, because it runs
as root outside the unit and so is subject to none of these restrictions. The unit sets
`SystemCallErrorNumber=EPERM`, so a syscall the filter blocks returns an error
to the process instead of killing it. That buys resilience, not visibility: a
seccomp errno action logs nothing of its own, and it is the default kill action
— the one `EPERM` replaces — that would have reached the journal, as
`status=31/SYS`. So what you are looking for is the application's own report of
an operation that failed:

```bash
journalctl -u overflow.service -n 100 --no-pager
```

## 8. Test the rollback before you need it

Do this once, immediately, while the previous unit and checkout are still on
the host. Restore the saved copy, confirm the service comes back on it, then
reinstall the hardened unit and confirm again with section 7.

The rollback has three preconditions and nothing on the host keeps them alive —
a cleanup of `/root` voids the rollback silently, months later. Check them
first, here and in section 9; if any fails, there is no rollback and a broken
hardened unit has to be fixed forward instead.

```bash
missing=0
for path in /root/overflow.service.pre-hardening /root/overflow \
            /root/.nvm/versions/node/v24.17.0/bin/pnpm; do
  if [ -e "$path" ]; then
    echo "present: $path"
  else
    echo "MISSING: $path" >&2
    missing=1
  fi
done
[ "$missing" = 0 ] \
  || echo "No rollback is available. Fix the hardened unit forward instead." >&2
```

Every path prints, present or missing, because `test` prints nothing either way:
three blank results is what an operator sees whether the rollback is intact or
gone, and a check that cannot be read has replaced the silent expiry it was
added to catch.

```bash
systemctl show overflow.service -p MainPID --value > /run/overflow-preswitch-mainpid
systemctl stop overflow.service
cp -a /root/overflow.service.pre-hardening /etc/systemd/system/overflow.service
systemctl daemon-reload
systemctl start overflow.service
systemctl is-active overflow.service
printf 'MainPID before the rollback: %s\nMainPID now:                 %s\n' \
  "$(cat /run/overflow-preswitch-mainpid)" \
  "$(systemctl show overflow.service -p MainPID --value)"
ps -o user=,pid=,args= -p "$(systemctl show overflow.service -p MainPID --value)"
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

`active`, a `MainPID` that moved, a `ps` line owned by `root` again and `200`
mean the rollback path works — the `root` is the point of it, since that is the
state the saved unit runs in. Then repeat section 6 and section 7 to get back to
the hardened unit; section 6's `restart` is what makes that return leg real, and
its `MainPID` pair is what proves it happened. A rollback that has never been run
is an assumption. This block keeps the landing-page URL on purpose: the restored
old checkout predates the readiness endpoint, and what the block verifies is
unit-rollback serving, not dependency reachability.

## 9. Rolling back

If a deploy fails, capture why before restoring anything:

```bash
systemctl status overflow.service --no-pager
journalctl -u overflow.service -n 100 --no-pager
```

The failures this configuration produces:

- `ReadWritePaths` names a path that does not exist — `/srv/overflow/.next/cache`
  now resolves through the `.next` symlink into the selected release. A missing
  or dangling link, or a missing `cache` inside that release, prevents startup.
  The cache must also be owned by `overflow` for runtime writes to work.
- `/etc/overflow/overflow.env` does not exist — section 4 was skipped. Its mode
  is not a start failure: systemd reads the file as root, before the drop to
  `User=overflow`, so `0600 root:root` is correct and a service that cannot
  read the file itself is the design, not a fault.
- `postgresql.service` does not exist on this host, so the unit's
  `Requires=postgresql.service` refuses the start outright. That is the
  remote-database case; see the note at the top of this file.
- `/usr/local/bin/node` is missing or is a dangling symlink into `/root`.
- The tree is unreadable to the group, so `next` cannot load its own build.

For a failed release, switch back to the retained previous build and restart
the same hardened unit. Section 10 prints the previous release path before
switching; record it with the deploy. Replace the value below with that recorded
path, and confirm the directory still exists. The ownership reset on a later
deploy also resets retained caches other than the serving cache, so hand the
previous cache back before the restart, even if it was writable when that
release last ran. The block takes the same deploy lock as section 10, so a
rollback cannot interleave with a deploy, and its switch is conditional on
`.next` still resolving to the release the rollback started from. Paste the
block into a fresh shell, never one that already holds the deploy lock: its
`exec 9>` re-opens fd 9, which would release the lock that deploy still holds.

```bash
set -e
cd /srv/overflow
exec 9>/run/overflow-deploy.lock
flock -w 900 9 || { echo "Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running." >&2; exit 1; }
expected_serving=$(readlink -f /srv/overflow/.next || printf absent)
previous_release='.next-release-REPLACE-WITH-RECORDED-ID'
test -f "$previous_release/BUILD_ID"
test -d "$previous_release/cache"
chown -R overflow:overflow "$previous_release/cache"
chmod -R u=rwX,g=rX,o= "$previous_release/cache"
pnpm release:switch /srv/overflow "$previous_release" --expect-current "$expected_serving"
systemctl restart overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/readiness
```

Expect `active` and HTTP `200`, then exercise the application and inspect its
journal as in section 7. Restart immediately after switching: a process running
across the swap retains its old writable cache mount, while the fresh start
picks up the selected release's cache. A symlink switch alone is not a deploy
or a rollback.

A retained release built before the readiness endpoint existed answers `404`
there. `curl -f` treats `404` as a failure, so the verification fails —
readiness unknown rather than confirmed — and that is the intended fail-safe:
never report a rollback healthy on a signal that cannot see the database. The
caveat goes moot once every retained release postdates the endpoint.

This rolls back the build, not the revision. The checkout and `node_modules`
are shared with the current revision, and database migrations are not undone.
The retained build must work with those dependencies, configuration and schema;
the switch script does not check compatibility. If those need reverting too,
restore the intended revision and its dependencies and build it into a new
release using section 10's build, ownership, switch and verification steps;
assess the database schema separately.

If the hardened unit itself is broken and needs the old unit restored, check
section 8's three preconditions, then restore with the same commands. That
restored state runs the application as root again, which is the state this
procedure exists to leave behind, so fix the failure rather than forgetting it.
`systemctl is-active` reporting `active` and the HTTP check returning `200` are
the evidence the rollback worked; a journal that shows the process starting as
`root:root` is what tells you the old unit — not the new one — is the one now
running.

The old-unit rollback decays with every deploy, and neither of those two checks
reports it. Section 10 migrates the production database and does not touch
`/root/overflow`, so from the first revision deploy onwards the saved unit runs
older code against a newer schema. Once the hardened service is trusted, stop
treating the old checkout as the rollback. Retaining previous releases partially
restores the path: a compatible previous build can be selected without rebuilding
or returning to the root-run unit. It does not preserve the old checkout,
dependencies or database schema, so a revision rollback still needs those
considered explicitly.

## 10. Deploying a new revision

The procedure runs as one committed script. As root, from the tree root, run
`bash scripts/deploy-revision.sh`; the script performs the whole sequence under
the same guards the manual fallback below documents: the `flock` fence on
`/run/overflow-deploy.lock` held on fd 9 for up to 900 seconds and refusing
with the serialization refusal when the lock is not acquired, the `.next`
anchor taken before the fetch and passed to `release:switch --expect-current`,
a `git fetch origin main` that moves only refs, resolution of the deployed SHA
from `FETCH_HEAD`, a refusal when `HEAD` cannot fast-forward to that SHA (the
tree is ahead of or diverged from main), the tree-cleanliness gate that refuses
the deploy when the working tree deviates from `HEAD` — tracked modifications,
staged changes and untracked non-ignored files all survive a fast-forward, and
a release is named for the commit it was built from, so the tree must be that
commit; it also refuses the deploy when the tree holds an ignored
untracked file outside the operational allowlist, since `git status` never
shows such a file (the `.gitignore` denies by default) and the build would
compile it into a release named for a commit that does not contain it; the
allowlist is exactly, and only at the tree root, the `.next` anchor, the
release directories and their `.tsconfig.json` sidecars,
`.next-release-notes/`, `next-env.d.ts` and `node_modules/`, and anything
else ignored anywhere in the tree must be removed before re-running — the
required-checks gate that must bless the
exact fetched SHA (below), and only after both gates pass the
`git merge --ff-only` that moves the tree to that SHA; then the redundant-deploy
skip that compares the resolved SHA against the serving release's `REVISION`
record and, on a match — the run that built the serving release migrated at
that same commit — exits without installing, migrating or building, the
copy-import install, the environment load, `db:migrate`, a
grammar-named release directory created with a collision-aborting `mkdir`,
generated-config preparation, the build, whose clean step wipes the release
directory (everything outside `cache|dev|lock|trace`), the ownership reset
excluding the serving cache, the new cache handover to the service account, the
conditional
switch, the restart, the `is-active` and readiness-endpoint verification, the webhook
upgrade written to a retained JSONL log with a nonzero upgrade exiting the
script nonzero, after which the exact source SHA is recorded in a `REVISION`
file inside the release — attesting a fully deployed release (built after the
wipe, switched, verified), so a redundant deploy may trust it — the retention
listing, and the prune via `release:prune --keep 3`.
The migration-safety analysis and every other guard below govern the script's
run exactly as they govern the manual block; read this whole section before
running either.

The script's prune is guarded in a way the manual path is not, and this is new
behaviour, not a restatement of the confirm-first rule below: before pruning,
the script consults its own retention listing and refuses to prune unless the
recorded previous release is inside the newest-3 retention set. When the
previous release is older, the script prints its name, prints the exact manual
`release:prune` command with `--keep` raised above 3, and runs nothing — the
deploy still exits 0, because the deploy itself succeeded and only the prune
was withheld. The manual path keeps a human as the guard through the
confirm-first rule below; the script's guard is additional automation, and the
manual rule is what still applies when pruning by hand.

The script deploys only a SHA that main's required checks have blessed. Right
after the fetch it resolves the exact SHA being deployed and, once the
tree-cleanliness gate passes, reads main's required checks from the branch
protection; every required check's latest run on that SHA must conclude
`success` before the fast-forward, and so before install, migrations, build,
switch or restart. A failed, cancelled or otherwise non-successful conclusion refuses
immediately, and a check whose latest run is queued, in progress or has not
been created yet makes the script wait, polling every 15 seconds until
`OVERFLOW_DEPLOY_CI_TIMEOUT` (default 900) seconds elapse, then refusing with
the still-pending checks named, an absent run reported as `<check> (absent)`.
Every required check must therefore report on a push to main: a check that
runs only on pull requests never runs on the SHA a rebase merge lands, so the
gate would wait it out as `<check> (absent)` and refuse. `ratchet-guard`
reports on both — `pull_request_target` for pull requests and `push` for
the tip each push lands. The deploy gate checks only the fetched tip of
main, which is always a pushed tip.
Each required check is resolved to the job of the workflow file
`.github/required-checks.json` pins it to, and a same-named check-run from
any other producer holds the deploy as pending, so it is refused at the
deadline and never passed.
A refused gate leaves `HEAD`, the index and the working tree untouched, so the
tree stays on the commit it was on; only the refs the fetch wrote
(`FETCH_HEAD`, `origin/main`) have moved.
`OVERFLOW_DEPLOY_CI_GATE=skip` bypasses the entire gate with a loud warning
naming the skip and the SHA, and is reserved for rollback or recovery deploys
when main's CI is red; unset or empty enforces the gate, and any other value
refuses.

The script takes no arguments and reads exactly seven environment overrides
for the test harness; production sets none of them and runs on the defaults:
`OVERFLOW_DEPLOY_TREE` (default `/srv/overflow`),
`OVERFLOW_DEPLOY_ENV_FILE` (default `/etc/overflow/overflow.env`),
`OVERFLOW_DEPLOY_LOCK` (default `/run/overflow-deploy.lock`),
`OVERFLOW_DEPLOY_UNIT` (default `overflow.service`),
`OVERFLOW_DEPLOY_URL` (default `http://127.0.0.1:3000/api/readiness`),
`OVERFLOW_DEPLOY_LOG_DIR` (default `/var/log/overflow`) and
`OVERFLOW_DEPLOY_CI_TIMEOUT` (default `900`). One further override is
operator-facing, not a test knob: `OVERFLOW_DEPLOY_CI_GATE`, whose only
accepted non-default value is `skip` (the gate paragraph above).

Every revision deploy finishes by upgrading existing hooks after the new release
is serving and its readiness check succeeds. Migration 043 must precede the
scoped-credential receiver code. Legacy hooks cannot authenticate until this
upgrade configures their new callback UUID and independent secret. Keep the
callback base URLs and `TOKEN_ENCRYPTION_KEY` available; change the
encryption key only through section 11. Avoid concurrent manual hook-configuration edits. The command
preserves active state and unrelated subscriptions, verifies each persisted hook
at its current numeric-ID-resolved location, then requests full upstream repair.
Pending credential material is durable: retry a failed run without reminting it.
Missing sponsor credentials require relinking before that registration can upgrade.
After all registrations migrate, retire the old shared credential and assess any
reuse elsewhere. Rolling back to a shared-credential receiver reopens that trust boundary.
Historical missed deliveries have no known dirty subject; an ordinary incremental
queue pass cannot guarantee their repair. Startup recovery does not replace this upgrade.

Startup recovery is on by default. Before every deploy, review whether the
revision can affect fold-derived values. Changes to fold behavior **must not
suppress the startup pass**; leave `OVERFLOW_SKIP_STARTUP_RECONCILIATION` unset
in `/etc/overflow/overflow.env`. The same recovery-on default applies whenever
the impact is uncertain.

For a reviewed deploy that cannot affect fold-derived values (for example, a
copy-only change), an operator may deliberately add
`OVERFLOW_SKIP_STARTUP_RECONCILIATION=1` to `/etc/overflow/overflow.env` before
the restart below. Only the exact value `1` suppresses the immediate startup
sweep; unset, blank, malformed and all other values run it. A shell export in
the deploy terminal does not configure the systemd service. This opt-out leaves
the six-hour sweep, queued work, webhook-triggered reconciliation and manual
reconciliation running normally, but missed deliveries may remain unrecovered
until a later reconciliation.

After restart, verify the warning naming `OVERFLOW_SKIP_STARTUP_RECONCILIATION`
in the service journal. An authenticated moderator can also read
`GET /api/moderation/rederivation`: `startupRecoverySkipped` records whether
this process skipped its startup recovery pass, alongside the existing row
staleness counts. It remains true after later sweeps; it is startup history,
not a claim that every repository is still stale. Remove the override from
the environment file after the chosen restart so the next restart defaults to
recovery-on. Remove this temporary override with issue 196, when startup
reconciliation becomes incremental.

Install, migrate and build run as root inside the tree. Only the service runs as
`overflow`, and the ownership reset afterwards is what keeps it that way: a
build writes new files as root, and the new cache has to be handed back while
the serving cache stays writable. Build into a new release directory every time
so Next cannot rewrite the serving build's manifests, chunks and fallback error
page during the build. Run one deploy at a time; concurrent installs, config
generation, switches or prunes share the same tree.
On a host whose `.next` is still a real directory, use section 5's one-time
migration block at the switch step.

The block is serialized with an exclusive `flock` on `/run/overflow-deploy.lock`
(`command -v flock`: `/usr/bin/flock`, util-linux), held for the whole
procedure: pull, install, migrate, build, ownership reset, switch, restart,
verification and webhook upgrade all run under one lock, so two deploys
started together run one after the other instead of interleaving. A concurrent deploy waits up to 900 seconds for
the lock and then refuses; refusing is the fail-safe behavior, and a deploy
must never proceed without it. The lock is kernel-owned and disappears when the
holding process dies, so a crashed deploy cannot deadlock the next one.

The switch inside the block is conditional as the second defense, against
actors that skipped the lock: the block records the release `.next` resolves to
before touching anything and passes it as `--expect-current`, and
`release:switch` refuses unless `.next` still resolves there at switch time. An
off-procedure actor — an old copy of this document, a hand-run switch —
therefore cannot silently supersede an in-flight deploy: production never moves
backward and an already-verified release is never silently discarded. When the
switch reports the mismatch, re-run the whole procedure: the script from the
start, or the manual block below from `git pull` onwards. A missing or
dangling `.next` at anchor time is a host that needs repair or the one-time
migration, not a routine deploy; the conditional switch refuses that state
rather than building on it.

**Migrations apply before the build, and the release they accompany starts
serving only at the switch.** Between those points the previous release serves
every request against the new schema, for the whole build duration. A migration
is safe to apply in that position exactly when the previous release's write
path cannot violate it: purely additive statements (a new table, a nullable
column, a plain index; a plain index built without `CONCURRENTLY` blocks the
previous release's writes for the scan's duration) are safe, and so is an
enforcing statement the previous release already satisfies on every write
path — `settlements` has carried `settlements_issue_unique` since migration
003 alongside the writer that maintains it.

Before running the standing block below, read every migration the run will
apply for the first time — anything `schema_migrations` does not yet record —
and apply that test to each. If one fails, stop: do not run it. Land the
writer correction in this release and the enforcing statement in the next
deploy, or shape the constraint so the previous release cannot violate it
(for example, a partial constraint excluding the shape the old writer can
produce). Shipping the constraint and its writer correction in the same
release does not close the window — that is precisely what PR 312 and
migration `033_self_work_calibrations_issue_unique.sql` did, and the build
duration reopened the gap the branch had closed.
`ADD CONSTRAINT ... NOT VALID` does not rescue a failing constraint. A unique
constraint — the form of both examples above — cannot be marked NOT VALID at
all, and where the mark exists (a `CHECK` or `FOREIGN KEY` constraint) it
defers only the scan of existing rows while still enforcing new-row writes
immediately, so it does not make a constraint safe to apply before the
corrected writer is serving.

**The fenced blocks below are the manual fallback, for the case where the
script itself is what broke.** They run under the same fence, with the same
`--expect-current` anchor and the same release grammar, but they are not the
script's sequence: they pull first, fast-forwarding the tree before anything
is checked, and carry neither the tree-cleanliness gate nor the
required-checks gate. So run the standing block in two parts, in one shell
so the fd 9 fence and `expected_serving` carry over: stop right after its
`git pull` line, before `pnpm install` and `pnpm db:migrate`, and confirm by
hand that `git status` in the tree is clean and that main's
required checks passed on the pulled commit; if either check fails, do not
run the rest of the block, since `pnpm db:migrate` would otherwise apply that
unverified commit's migrations to the production schema. Extract and run them
only after diagnosing why the script could not, and keep every guard in this
section in force.

**Existing deployments: complete the ONE-TIME dependency migration below before
running this standing procedure for the first time.** Fresh installations using
section 5's copy import do not need that migration.

```bash
set -e
cd /srv/overflow
exec 9>/run/overflow-deploy.lock
flock -w 900 9 || { echo "Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running." >&2; exit 1; }
expected_serving=$(readlink -f /srv/overflow/.next || printf absent)
git pull --ff-only origin main
npm_config_package_import_method=copy pnpm install --frozen-lockfile
set -a; . /etc/overflow/overflow.env; set +a
pnpm db:migrate
release=".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)"
mkdir "$release"
node scripts/release.ts prepare /srv/overflow "$release"
NEXT_DIST_DIR="$release" pnpm build
previous_release=$(readlink -f /srv/overflow/.next)
serving_cache="$previous_release/cache"
test -d "$serving_cache"
find /srv/overflow -path "$serving_cache" -prune -o \
  -exec chown -h root:overflow {} +
find /srv/overflow -path "$serving_cache" -prune -o \
  ! -type l -exec chmod u=rwX,g=rX,o= {} +
mkdir -p "$release/cache"
chown -R overflow:overflow "$release/cache"
chmod -R u=rwX,g=rX,o= "$release/cache"
printf 'Previous build: %s\nNew build: %s\n' "$previous_release" "$release"
pnpm release:switch /srv/overflow "$release" --expect-current "$expected_serving"
systemctl restart overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/readiness
install -d -m 0700 /var/log/overflow
upgrade_log="/var/log/overflow/webhook-upgrade-$release.jsonl"
upgrade_status=0
pnpm --silent webhooks:upgrade > "$upgrade_log" 2>&1 || upgrade_status=$?
cat "$upgrade_log"
printf 'Webhook upgrade log: %s\nWebhook upgrade exit status: %s\n' "$upgrade_log" "$upgrade_status"
test "$upgrade_status" -eq 0 || exit "$upgrade_status"
```

**ONE-TIME dependency migration for existing deployments**

Before the first deploy using copy imports, remove the old `node_modules` and
reinstall it with the copy setting. The package manager otherwise reuses
unchanged packages, leaving their existing hardlinks intact. Run this once in a maintenance window:
removing dependencies can interrupt requests from the running service. After
the install succeeds, run the standing procedure above to build, restore tree
ownership and permissions, restart and verify the service. Do not include this
removal in routine deploys.

```bash
set -e
cd /srv/overflow
rm -rf -- node_modules
npm_config_package_import_method=copy pnpm install --frozen-lockfile
```

This breaks the deployment's links to the shared store; it does not repair
ownership or modes already changed in the store or other checkouts.

The generated config belongs to `$release` and excludes serving and retained
release validators; Next adds the new release's types to that file. Omitting
preparation makes the build fail with the command needed to prepare this release.
The tracked config stays clean, and `set -e` stops a failed preparation or build
before the switch.

Retain the upgrade log and printed exit status with the deployment record. A
nonzero upgrade leaves the new release serving but the deployment incomplete;
inspect each sanitized `failure` code, restore sponsor credentials or hook admin
access as needed, and rerun the `webhooks:upgrade` package script with the same
environment.
`subscription: VERIFIED` and `queue: FAILED` is partial completion: the rerun
verifies the hook again and retries repair queueing. Do not report the upgrade as
successful from a restart or startup sweep. Queue acceptance does not establish
that reconciliation has finished; check the worker's outcomes afterwards.

For section 5's one-time migration, run the upgrade/logging lines above after its
switch/restart and section 10's HTTP verification. For a first installation or
unit migration, run them after section 7's readiness verification with the
environment from section 5 loaded. With no active registrations the command is
a successful no-op.

The ownership reset keeps code root-owned and group-readable while preserving
the serving cache's Unix permissions. Resolve `.next` before resetting ownership:
`find` does not follow the symlink, so its exclusion must name the actual release's
cache. `-prune` skips that directory and everything inside it in both passes;
`chown -h` changes symlink ownership without following links, and the mode pass
skips symlinks. The old process can keep writing its cache throughout preparation,
even if preparation or switching stops before the restart. During the one-time
migration the resolved path is the real `.next`, so the same exclusion preserves
`.next/cache`. The copy imports described in section 5 keep these resets from
changing package files in the shared store or other checkouts.

The new cache lives at `/srv/overflow/$release/cache`, so create and hand over
that directory before the switch and restart. The unit still names
`/srv/overflow/.next/cache` and resolves it through the symlink. A running process
keeps its old writable mount across a swap, but that mount does not bypass Unix
ownership or mode checks; preserving the old cache permissions is required too.
The immediate restart picks up the new release's cache.

Expect `active` and HTTP `200`, then exercise the application and inspect the
journal as in section 7. Only prune after those checks succeed. Prune in the
same shell that ran the deploy block above: the deploy lock is held until that
shell exits, and the prune fence below re-locks fd 9 before touching anything,
so pasting it into a fresh shell fails loudly by design instead of pruning
unserialized. Before pruning,
list the retained directories and confirm the recorded previous release is
among the three greatest names; if it is older, raise `--keep` enough to include
it or skip pruning. Failed build directories count too, and a rollback can
make the previously served release older than the normal retention window.
The one-time migration has no previous release directory to retain.

```bash
set -o pipefail
LC_ALL=C find /srv/overflow -regextype posix-extended -mindepth 1 -maxdepth 1 \
  -type d -regex '.*/\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}' \
  -printf '%f\n' | LC_ALL=C sort -r
```

```bash
flock -w 900 9 || { echo "Could not acquire the deploy lock on /run/overflow-deploy.lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running." >&2; exit 1; }
pnpm release:prune /srv/overflow --keep 3
```

The `release:prune` package script takes `<tree> [--keep N]` and runs
`node scripts/release.ts prune <tree> [--keep N]`; pass the arguments directly,
without an extra `--` separator, for both release package scripts. `--keep` must
be a positive integer and defaults to `3`. Like the listing above, the script
enumerates only real directories directly inside the tree whose names match the
release grammar in section 5, ignoring files, symlinks and all other directory
names, and removes the `<release>.tsconfig.json` sidecar file beside each
directory it deletes. It then sweeps orphaned sidecars: regular files named
`<release>.tsconfig.json` at the tree root whose release directory is absent.
It checks no build markers when pruning, so even a failed build with a
matching name counts. It keeps the newest N directory names in descending
lexical order, not by modification time or build success. It also protects the
release `.next` resolves to and directories needed to resolve its symlink chain,
even outside that N. It prints each removed directory and sidecar, or a no-op
line if nothing was removed. A missing or dangling `.next`
is reported but protects no release and does not prevent deletion; do not prune
to recover from a failed switch. Pruning knows the symlink target, not which
build a still-running process has loaded, which is another reason to restart
and verify first.

Release-directory builds fix the build's writes under the serving output path;
they do not isolate `git pull` or dependency installation, which still change the
live checkout and `node_modules`. Testing on this host found that a same-lockfile
install and a live `git checkout` did not disturb a running server: all
application entry points are loaded at startup. That does not cover every lazy
internal dependency. With one compiled package removed, a cold `/_next/image`
request returned HTTP `500` with `MODULE_NOT_FOUND` and recovered once the package
was restored. These results do not guarantee that dependency changes during an
install are safe. This procedure also retains the restart interruption; it is
not a zero-downtime deployment scheme.

If the revision includes a change to `overflow.service`, repeat section 6 as well:
`git pull` updates the copy in the tree, not the one systemd reads. Nothing
here refreshes `/root/overflow.service.pre-hardening` or the checkout it starts
from, which is what the last paragraph of section 9 is about.

## 11. Rotating the credential encryption key

`TOKEN_ENCRYPTION_KEY` seals three kinds of stored credential: each user's
GitHub OAuth token (`users.encrypted_oauth_token`), each linked forge access
token (`user_forge_identities.encrypted_token`) and each registration's webhook
secret (`registered_repositories.encrypted_webhook_secret`). Every value written
in the current format names the key that sealed it and is bound to its own row;
values stored before that format carry neither until they are re-sealed (see
"Re-sealing without changing the key" below).

**This section is the only sanctioned way to change `TOKEN_ENCRYPTION_KEY`.**
Replacing the value in the environment file any other way leaves every stored
credential sealed under a key the service no longer holds, and each one fails
until it is minted again: sponsors sign in again, forge identities are linked
again, webhook secrets are replaced. For the same reason, never run
`pnpm credentials:reencrypt` against the production database outside this
procedure.

The rotation runs while the service keeps serving, and costs two restarts. It
relies on the service reading two keys: `TOKEN_ENCRYPTION_KEY` is the current
key, which seals every new write and opens what it sealed, and the optional
`TOKEN_ENCRYPTION_KEY_PREVIOUS` only opens. While both are configured, every
row opens under whichever of the two sealed it.

Run every block as root from a fresh shell. Sourcing the environment file sets
variables and never unsets them, so a shell that loaded the file before an edit
keeps the values the edit removed. `pnpm` is on root's `PATH` and deliberately
not on the service's (section 3).

**Do not deploy (section 10) between step 3's edit and step 6's restart.** A
deploy restarts the service and runs the webhook upgrade with whatever the
environment file holds at that moment, or, from a shell sourced earlier, with
keys the file no longer holds. Finish or roll back the rotation first.

### Step 1: back up the database

Take a fresh dump first, the way [backup-restore.md](backup-restore.md)'s drill
does. Once the old key is retired, it is the only way back should the new key
be lost.

```bash
set -e
cd /srv/overflow
set -a; . /etc/overflow/overflow.env; set +a
bash scripts/db-backup.sh
```

The script prints the dump's path; record it with the rotation. The dump holds
the credentials sealed under the old key, so it restores usefully only together
with that key; step 3 keeps the old key in
`/etc/overflow/token-encryption-key.old` for that reason. The backup script
deletes `overflow-*.dump` files older than 14 days (section (d) of
backup-restore.md); copy this dump to a name outside that pattern, in the same
directory, if the rollback window has to outlast that.

### Step 2: generate the new key

The key goes straight into a root-only file and is never printed, so it stays
out of terminal scrollback. This block and the other guarded edits below run in
a subshell, `( … )`, so a refusal ends the subshell with a message and leaves
your shell open:

```bash
(
set -e
test ! -e /etc/overflow/token-encryption-key.new || { echo "Refusing: token-encryption-key.new already exists." >&2; exit 1; }
install -o root -g root -m 0600 /dev/null /etc/overflow/token-encryption-key.new
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > /etc/overflow/token-encryption-key.new
wc -c < /etc/overflow/token-encryption-key.new
)
```

Expect `43`: 32 random bytes as unpadded base64url, the only form the service
accepts. The refusal protects a key file left by an interrupted rotation; find
out whether that key was ever configured before removing it.

### Step 3: configure both keys and restart

This block keeps the old key in `/etc/overflow/token-encryption-key.old`,
renames the `TOKEN_ENCRYPTION_KEY` line to `TOKEN_ENCRYPTION_KEY_PREVIOUS`
without changing its value, appends the new key as `TOKEN_ENCRYPTION_KEY`,
confirms both lines read back as the two saved keys, and restores section 4's
ownership and mode. It refuses, changing nothing, unless:

- step 2's file holds a 43-character key;
- the environment file ends with a newline, so the appended line cannot be
  glued onto the last one;
- no line names `TOKEN_ENCRYPTION_KEY_PREVIOUS`, comments included. A file
  copied from `.env.example` carries its commented
  `# TOKEN_ENCRYPTION_KEY_PREVIOUS=` line and its explanation; delete both, and
  any empty `TOKEN_ENCRYPTION_KEY_PREVIOUS=` line, before running the block;
- exactly one line names `TOKEN_ENCRYPTION_KEY` at all, comments included (the
  pre-restart rollback counts the same way, so a file this block accepts is one
  the rollback accepts), and that line holds the bare value and nothing else: no
  quotes, spaces or comment. Rewrite a quoted line as
  `TOKEN_ENCRYPTION_KEY=<value>` first; systemd and the shell read the bare
  form identically;
- no `token-encryption-key.old` from an earlier rotation is in the way. Such a
  file belongs with that rotation's dump, so rename it rather than removing it.

```bash
(
set -e
grep -Eqx '[A-Za-z0-9_-]{43}' /etc/overflow/token-encryption-key.new || { echo "Refusing: token-encryption-key.new does not hold a 43-character key." >&2; exit 1; }
test -z "$(tail -c 1 /etc/overflow/overflow.env)" || { echo "Refusing: overflow.env does not end with a newline." >&2; exit 1; }
test "$(grep -c 'TOKEN_ENCRYPTION_KEY_PREVIOUS' /etc/overflow/overflow.env)" = 0 || { echo "Refusing: overflow.env already names TOKEN_ENCRYPTION_KEY_PREVIOUS." >&2; exit 1; }
test "$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)" = 1 || { echo "Refusing: overflow.env must name TOKEN_ENCRYPTION_KEY on exactly one line." >&2; exit 1; }
grep -Eqx 'TOKEN_ENCRYPTION_KEY=[A-Za-z0-9_-]{43}' /etc/overflow/overflow.env || { echo "Refusing: the TOKEN_ENCRYPTION_KEY value is not bare." >&2; exit 1; }
test ! -e /etc/overflow/token-encryption-key.old || { echo "Refusing: token-encryption-key.old already exists." >&2; exit 1; }
install -o root -g root -m 0600 /dev/null /etc/overflow/token-encryption-key.old
sed -n 's/^TOKEN_ENCRYPTION_KEY=//p' /etc/overflow/overflow.env > /etc/overflow/token-encryption-key.old
sed -i 's/^TOKEN_ENCRYPTION_KEY=/TOKEN_ENCRYPTION_KEY_PREVIOUS=/' /etc/overflow/overflow.env
{ printf 'TOKEN_ENCRYPTION_KEY='; cat /etc/overflow/token-encryption-key.new; printf '\n'; } >> /etc/overflow/overflow.env
test "$(sed -n 's/^TOKEN_ENCRYPTION_KEY=//p' /etc/overflow/overflow.env)" = "$(cat /etc/overflow/token-encryption-key.new)" || { echo "The edited file does not read back as the saved keys; roll back as below." >&2; exit 1; }
test "$(sed -n 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=//p' /etc/overflow/overflow.env)" = "$(cat /etc/overflow/token-encryption-key.old)" || { echo "The edited file does not read back as the saved keys; roll back as below." >&2; exit 1; }
rm /etc/overflow/token-encryption-key.new
chown root:root /etc/overflow/overflow.env
chmod 0600 /etc/overflow/overflow.env
)
```

Before restarting, confirm that both values are keys the service will accept.
The re-encryption script's check mode reads the same file and writes nothing:

```bash
cd /srv/overflow
set -a; . /etc/overflow/overflow.env; set +a
check_status=0
pnpm --silent credentials:reencrypt --check || check_status=$?
printf 'Check exit status: %s\n' "$check_status"
```

Expect one JSON line for each of the three columns and, while any credential is
stored, exit status 1, because nothing is sealed under the new key yet. (Node's
experimental-feature warning on standard error accompanies every run of the
script.) `{"failure":"KEYS_INVALID"}` instead means one of the two values is not
a 32-byte base64url key: roll back as below, before the restart. The running
service still holds the old configuration in memory, so nothing has changed
yet.

Then restart, proving the switch the way section 7 does:

```bash
set -e
systemctl show overflow.service -p MainPID --value > /run/overflow-preswitch-mainpid
systemctl restart overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/readiness
printf 'MainPID before the switch: %s\nMainPID now:               %s\n' \
  "$(cat /run/overflow-preswitch-mainpid)" \
  "$(systemctl show overflow.service -p MainPID --value)"
```

Expect `active`, `200` and two different `MainPID` values. systemd reads the
environment file only when it starts the process, so a `MainPID` that has not
moved means the old process, holding only the old key, is still serving. From
this restart on, the service seals every new or refreshed credential under the
new key and still opens everything sealed under the old one.

### Step 4: re-encrypt the stored credentials

```bash
cd /srv/overflow
set -a; . /etc/overflow/overflow.env; set +a
reencrypt_status=0
pnpm --silent credentials:reencrypt || reencrypt_status=$?
check_status=0
pnpm --silent credentials:reencrypt --check || check_status=$?
printf 'Re-encryption exit status: %s\nCheck exit status: %s\n' "$reencrypt_status" "$check_status"
```

Load the keys from the service's own environment file, as here, and never type
them on the command line. The script seals every row it rewrites under whatever
`TOKEN_ENCRYPTION_KEY` it is given, so a valid key the service does not hold
would re-seal those rows under a key the service cannot open.

The first command opens every stored credential not yet sealed under the
current key, with either key, and seals it again under the current key, bound
to its row. Rows whose credential is NULL are skipped. It prints one line per
column, `{"table":…,"column":…,"reencrypted":N,"alreadyCurrent":N,"skipped":N,"failed":N}`,
plus one line for each row it could not open (step 5), and exits 0 only when no
row failed. `skipped` counts rows the service rewrote between the script's read
and its write, or whose GitHub user id, forge identity or webhook credential id
(what the seal is bound to) changed in that interval; the script leaves them as
they now are. The script is idempotent and safe to re-run: a second run
rewrites only what is still not current, so run the block again after any
failure or interruption. `{"failure":"REENCRYPTION_FAILED"}` means the database
could not be read or written; rows already re-sealed stay re-sealed. The output
names tables, columns, row ids and counts, never a credential or a key, so
retain it with the rotation record.

The second command writes nothing. It prints
`{"table":…,"column":…,"current":N,"notCurrent":N}` for each column and exits 0
only when every stored credential is sealed under the current key. It reads
which key sealed each row; it does not open them. Both statuses 0 means step 6
may follow; a re-encryption status of 1 with `UNDECRYPTABLE` lines means step 5.

### Step 5: rows reported undecryptable

`{"table":"<table>","id":"<row id>","failure":"UNDECRYPTABLE"}` names a row that
neither configured key opens for that row: it was sealed under some other key,
damaged, or copied from another row. The service could not read it before the
rotation either, so the rotation did not cause it, and the script leaves it
untouched. Each one is repaired by minting the credential again.

**`users`.** The user's next GitHub sign-in stores a fresh token. Without
waiting for that, clear the reported row's token:

```bash
set -a; . /etc/overflow/overflow.env; set +a
row_id='REPLACE-WITH-REPORTED-ID'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "update users set encrypted_oauth_token = null where id = '$row_id'"
```

Expect `UPDATE 1`; `UPDATE 0` means no user has that id, so check it against
the reported line. A NULL token reads as "no token" everywhere the service
reads it, and the re-encryption skips it. Until the user signs in again, the
repositories they sponsor do not reconcile ("GitHub access token was not
available."), they cannot register a repository or read its labels, and the
webhook upgrade reports `CREDENTIALS_FAILED` for their registrations. Each of
those already failed while the token was unreadable. Signing in does not need
the stored token, and it writes a new one.

**`user_forge_identities`.** The user's next link of the same forge identity
stores a fresh token in the same row. Without waiting for that, clear the
reported row's token; never delete the row:

```bash
set -a; . /etc/overflow/overflow.env; set +a
row_id='REPLACE-WITH-REPORTED-ID'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "update user_forge_identities set encrypted_token = null where id = '$row_id'"
```

Expect `UPDATE 1`; `UPDATE 0` means no identity has that id. The row keeps its
provider, instance and forge user id, which is what GitLab authorship resolves
through, so the user's GitLab work stays attributed to them; deleting the row
would lose that. A NULL token is never selected for use and the re-encryption
skips it, the same state account deletion leaves. Until the user links the
identity again, everything that needs their GitLab token on that instance
fails as it would with no identity linked: reconciling the GitLab repositories
they sponsor there, registering or unregistering a repository there, reading
its labels, and the webhook upgrade for those registrations. Each of those
already failed while the token was unreadable.

**`registered_repositories`.** The sponsor unregisters and registers the
repository again, or you clear the row's credential and let the webhook
upgrade mint and configure a new one. The upgrade mints only for a
registration holding no credential; one still holding an unreadable secret
fails there as well.

```bash
set -a; . /etc/overflow/overflow.env; set +a
row_id='REPLACE-WITH-REPORTED-ID'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "update registered_repositories set webhook_credential_id = null, encrypted_webhook_secret = null, webhook_configured_at = null where id = '$row_id' and unregistered_at is null"
```

Expect `UPDATE 1`, then run the `webhooks:upgrade` package script with the same
environment and retain its output, as section 10 describes. The hook rejects
deliveries until the upgrade configures its new secret, as it already did while
the old one was unreadable. `UPDATE 0` means the id is not a registered
repository: either it is mistyped, or the repository is unregistered, in which
case the statement under "Webhook secrets of unregistered repositories" below
clears it.

Then run step 4 again. **Do not retire the previous key while any row still
fails** or while `--check` exits non-zero: a row it counts as not current may
be one that only the previous key opens.

### Step 6: retire the previous key

Only after step 4's `--check` has exited 0, with the environment file unchanged
since. Remove the previous key, then repeat step 3's restart block with the same
expectations:

```bash
(
set -e
sed -i '/^TOKEN_ENCRYPTION_KEY_PREVIOUS=/d' /etc/overflow/overflow.env
chown root:root /etc/overflow/overflow.env
chmod 0600 /etc/overflow/overflow.env
)
```

Then, from a fresh shell:

```bash
cd /srv/overflow
set -a; . /etc/overflow/overflow.env; set +a
check_status=0
pnpm --silent credentials:reencrypt --check || check_status=$?
printf 'Check exit status: %s\n' "$check_status"
```

It must print status 0 with `"notCurrent":0` on every line. Then exercise the
application and inspect its journal as in section 7. Keep
`/etc/overflow/token-encryption-key.old` for as long as you keep step 1's dump.

### Rolling back a rotation

- **Before step 3's restart**, the service still runs on the old configuration.
  If only step 2 ran, `rm /etc/overflow/token-encryption-key.new` is all. If
  step 3's edit ran, drop the new key and give the old one its name back. The
  block removes the copy step 3 kept only after the file reads back as exactly
  that old key, on exactly one line that names the key. Otherwise it refuses
  and keeps the copy, the only clean one: repair the file by hand from
  `/etc/overflow/token-encryption-key.old` before restarting anything.

  ```bash
  (
  set -e
  test "$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)" = 2 && test "$(grep -c '^TOKEN_ENCRYPTION_KEY=' /etc/overflow/overflow.env)" = 1 || { echo "Refusing: overflow.env does not hold exactly the two key lines step 3 wrote." >&2; exit 1; }
  test "$(sed -n 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=//p' /etc/overflow/overflow.env)" = "$(cat /etc/overflow/token-encryption-key.old)" || { echo "Refusing: the previous key does not match token-encryption-key.old." >&2; exit 1; }
  sed -i -e '/^TOKEN_ENCRYPTION_KEY=/d' -e 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=/TOKEN_ENCRYPTION_KEY=/' /etc/overflow/overflow.env
  test "$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)" = 1 || { echo "Refusing: overflow.env does not name the key exactly once; token-encryption-key.old is kept." >&2; exit 1; }
  test "$(sed -n 's/^TOKEN_ENCRYPTION_KEY=//p' /etc/overflow/overflow.env)" = "$(cat /etc/overflow/token-encryption-key.old)" || { echo "Refusing: the key does not match token-encryption-key.old, which is kept." >&2; exit 1; }
  rm /etc/overflow/token-encryption-key.old
  )
  ```

- **While both keys are configured**, from step 3's restart until step 6: swap
  them, so the old key is current and the new one previous, and restart with
  step 3's restart block. The block refuses unless the file holds exactly one
  current and one previous key line and names the key nowhere else; after
  step 6 there is no previous key to swap in, and swapping a lone key would
  leave the service with no current key:

  ```bash
  (
  set -e
  test "$(grep -c 'TOKEN_ENCRYPTION_KEY' /etc/overflow/overflow.env)" = 2 && test "$(grep -c '^TOKEN_ENCRYPTION_KEY=' /etc/overflow/overflow.env)" = 1 && test "$(grep -c '^TOKEN_ENCRYPTION_KEY_PREVIOUS=' /etc/overflow/overflow.env)" = 1 || { echo "Refusing: overflow.env does not hold exactly one current and one previous key line." >&2; exit 1; }
  sed -i -e 's/^TOKEN_ENCRYPTION_KEY_PREVIOUS=/TOKEN_ENCRYPTION_KEY=/' -e t -e 's/^TOKEN_ENCRYPTION_KEY=/TOKEN_ENCRYPTION_KEY_PREVIOUS=/' /etc/overflow/overflow.env
  )
  ```

  Every row stays readable whichever key sealed it, and new writes go back
  under the old key. To finish, run steps 4 to 6 with the keys in that order;
  it is the same rotation, back to the old key. `token-encryption-key.old`
  then holds the current key, so remove it after that step 6.
- **After step 6**, the rows are sealed under the new key alone. While the new
  key is still held, going back is another rotation by this section. If the new
  key is lost, the step 1 dump together with the old key is the only way back:
  restore it as section (e.2) of [backup-restore.md](backup-restore.md)
  describes, with `TOKEN_ENCRYPTION_KEY` set to the old key and no previous key.
  Everything written since the dump is lost.

Section 9's release rollback is not a key rollback. A build older than the
key-identified credential format reads no `TOKEN_ENCRYPTION_KEY_PREVIOUS` and
cannot open any credential written or re-sealed in that format, whichever key
sealed it.

### Re-sealing without changing the key

Every credential stored before the release that introduced key identifiers
stays in the old format until something re-seals it. Such a value names no key
and is bound to no row, so it still opens if it is copied into another row, and
`--check` counts it as not current and exits 1 with no rotation under way. The
service reads both formats, so nothing is broken; the row binding simply does
not cover those rows yet. Nothing re-seals them on its own. Run this pass once,
after that release is deployed.

**When:** only once the release is settled and no section 9 rollback to a
release older than it is intended. An older release accepts only the old format
and refuses every re-sealed value. The same is already true, with or without
this pass, of every value the new release writes on its own: a sign-in, a
forge relink, a registration and a webhook upgrade all store the new format. So
a rollback past this release leaves those rows unreadable too. The remedy then
is to clear each such row's credential as step 5 does, by id, and have its user
sign in again, relink the forge identity, or register the repository again.

**How:** with no key change and no restart, since the service already holds the
key the pass seals under:

1. Take step 1's backup. That dump holds the old format, which an older release
   can still read.
2. Run step 4's block. The environment file names only `TOKEN_ENCRYPTION_KEY`,
   so the script opens each old-format value with it and re-seals it under the
   same key, bound to its row.
3. Repair any row it reports undecryptable as step 5 describes, and run step
   4's block again until both statuses are 0.

After that, `--check` exits 0 until a rotation starts. It reads only which key
sealed each row, so it cannot see a row sealed under the current key but bound
to another row; the service refuses such a value, and step 5's remedy for its
table applies.

### Webhook secrets of unregistered repositories

Migration `048_unregistered_webhook_credentials.sql` clears the webhook
credential of every repository unregistered before the release that clears it
at unregistration. Before deploying it, count the rows it will clear; the query
only reads:

```bash
set -a; . /etc/overflow/overflow.env; set +a
psql "$DATABASE_URL" -tAc "select count(*) from registered_repositories where unregistered_at is not null and webhook_credential_id is not null"
```

Its statement is idempotent. The previous release keeps serving from the
migration until the switch (section 10) and does not clear the credential when
it unregisters, so a repository unregistered in that window, or while a
rolled-back release serves, keeps its secret; `pnpm db:migrate` never applies
048 a second time. After such a deploy or rollback, run the statement again and
repeat the count, which must then print `0`:

```bash
set -a; . /etc/overflow/overflow.env; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "update registered_repositories set webhook_credential_id = null, encrypted_webhook_secret = null, webhook_configured_at = null where unregistered_at is not null and webhook_credential_id is not null"
```
