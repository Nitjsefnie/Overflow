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

pnpm is needed for installs, migrations and builds, all of which run as root.
The service never runs pnpm, so the corepack shims go in `/usr/local/sbin`,
which the unit's `PATH` of `/usr/local/bin:/usr/bin:/bin` does not reach and
root's default `PATH` does.

```bash
ln -sfn /usr/local/lib/nodejs/node-v24.17.0/bin/corepack /usr/local/sbin/corepack
corepack enable --install-directory /usr/local/sbin
corepack prepare pnpm@10.33.0 --activate
pnpm --version
```

The last command must print `10.33.0`, the version `package.json` pins.

## 4. Create the environment file

The secrets file holds `DATABASE_URL`, `AUTH_SECRET`, the OAuth credentials,
`TOKEN_ENCRYPTION_KEY` and the webhook secret; the repository's own `README.md`
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
from the environment file so `pnpm db:migrate` reaches the right database.
Run these blocks in Bash and stop on a failed command; `set -e` makes a pasted
block stop too, before a failed build can be switched into service.

```bash
set -e
git clone https://github.com/Nitjsefnie/Overflow.git /srv/overflow
cd /srv/overflow
pnpm install --frozen-lockfile
set -a; . /etc/overflow/overflow.env; set +a
pnpm db:migrate
release=".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)"
mkdir "$release"
node scripts/release.ts prepare /srv/overflow
NEXT_DIST_DIR="$release" pnpm build
```

Each build gets a new directory at the tree root, alongside `.next`, named
`.next-release-<YYYYMMDDTHHMMSSZ>-<7 to 40 lowercase hex characters>`.
The UTC timestamp makes the names sort in deployment order, and the SHA
identifies the source revision. The explicit `--short=7` requests at least seven
hexadecimal characters even when `core.abbrev` is shorter. `prune` deletes
directories, so it only touches names matching this grammar to be certain they
are ones the deployment procedure
created. A directory named `.next-release-notes` is safe beside the releases:
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
local `pnpm build` still uses `.next`. Do not export
`NEXT_DIST_DIR` for the service or add it to `/etc/overflow/overflow.env`:
`next start` uses `.next` at runtime, with the variable unset.

Before each release build, `node scripts/release.ts prepare <tree>` generates
the ignored `tsconfig.release.json` from the tracked `tsconfig.json`, preserving
its compiler settings and source includes while removing all `.next*` includes.
With `NEXT_DIST_DIR` set, `next.config.ts` selects this file through
`typescript.tsconfigPath`. Next appends only the current release's type entries
to it and type-checks those validators. Regenerate it for every build so it never
includes types from a previous release, including one whose routes were removed.
The script copies the config rather than using `extends` because Next 16.3.4
skips automatic type-include updates on configs with `extends` or `references`.

Next also regenerates the ignored `next-env.d.ts`. Release builds leave the
tracked `tsconfig.json` untouched, including on failure, so no restore step is
needed. With `NEXT_DIST_DIR` unset, local development keeps using the tracked
config. Start a deploy with a clean tracked tree.

Then set the ownership the unit assumes. The tree is root-owned and readable by
the `overflow` group; nothing in it is group-writable.

```bash
chown -R root:overflow /srv/overflow
chmod -R u=rwX,g=rX,o= /srv/overflow
```

These ownership and mode changes also affect pnpm package files hardlinked from
a shared store, so every checkout sharing those inodes sees the changes.
[Issue 214](https://github.com/Nitjsefnie/Overflow/issues/214) tracks this defect;
it predates this release layout and remains unfixed here, including in section
10's reset.

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
pnpm release:switch /srv/overflow "$release"
```

`pnpm release:switch <tree> <releaseDir>` runs
`node scripts/release.ts switch <tree> <releaseDir>`; a relative release argument
is relative to the tree. The resolved directory must be a direct child of the
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
pnpm release:switch /srv/overflow "$release"
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
Continue with section 10's verification before pruning.

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
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
printf 'MainPID before the switch: %s\nMainPID now:               %s\n' \
  "$(cat /run/overflow-preswitch-mainpid)" \
  "$(systemctl show overflow.service -p MainPID --value)"
systemctl show overflow.service \
  -p MainPID -p User -p Group -p NoNewPrivileges -p ProtectSystem
ps -o user=,pid=,args= -p "$(systemctl show overflow.service -p MainPID --value)"
```

Expected: `active`; `200` from curl; the two `MainPID` values differ and the current
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
the sandboxed process; `pnpm reconcile` does not, because it runs as root
outside the unit and so is subject to none of these restrictions. The unit sets
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
is an assumption.

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
release last ran.

```bash
set -e
cd /srv/overflow
previous_release='.next-release-REPLACE-WITH-RECORDED-ID'
test -f "$previous_release/BUILD_ID"
test -d "$previous_release/cache"
chown -R overflow:overflow "$previous_release/cache"
chmod -R u=rwX,g=rX,o= "$previous_release/cache"
pnpm release:switch /srv/overflow "$previous_release"
systemctl restart overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

Expect `active` and HTTP `200`, then exercise the application and inspect its
journal as in section 7. Restart immediately after switching: a process running
across the swap retains its old writable cache mount, while the fresh start
picks up the selected release's cache. A symlink switch alone is not a deploy
or a rollback.

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

Install, migrate and build run as root inside the tree. Only the service runs as
`overflow`, and the ownership reset afterwards is what keeps it that way: a
build writes new files as root, and the new cache has to be handed back while
the serving cache stays writable. Build into a new release directory every time
so Next cannot rewrite the serving build's manifests, chunks and fallback error
page during the build. Run one deploy at a time; concurrent installs, config
generation, switches or prunes share the same tree.
On a host whose `.next` is still a real directory, use section 5's one-time
migration block at the switch step.

```bash
set -e
cd /srv/overflow
git pull --ff-only origin main
pnpm install --frozen-lockfile
set -a; . /etc/overflow/overflow.env; set +a
pnpm db:migrate
release=".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)"
mkdir "$release"
node scripts/release.ts prepare /srv/overflow
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
pnpm release:switch /srv/overflow "$release"
systemctl restart overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

The generated deploy config excludes serving and retained release validators;
Next adds the new release's types to that file. The tracked config stays clean,
and `set -e` stops a failed preparation or build before the switch.

The ownership reset keeps code root-owned and group-readable while preserving
the serving cache's Unix permissions. Resolve `.next` before resetting ownership:
`find` does not follow the symlink, so its exclusion must name the actual release's
cache. `-prune` skips that directory and everything inside it in both passes;
`chown -h` changes symlink ownership without following links, and the mode pass
skips symlinks. The old process can keep writing its cache throughout preparation,
even if preparation or switching stops before the restart. During the one-time
migration the resolved path is the real `.next`, so the same exclusion preserves
`.next/cache`. The shared-store inode limitation in section 5 still applies.

The new cache lives at `/srv/overflow/$release/cache`, so create and hand over
that directory before the switch and restart. The unit still names
`/srv/overflow/.next/cache` and resolves it through the symlink. A running process
keeps its old writable mount across a swap, but that mount does not bypass Unix
ownership or mode checks; preserving the old cache permissions is required too.
The immediate restart picks up the new release's cache.

Expect `active` and HTTP `200`, then exercise the application and inspect the
journal as in section 7. Only prune after those checks succeed. Before pruning,
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
pnpm release:prune /srv/overflow --keep 3
```

`pnpm release:prune <tree> [--keep N]` runs
`node scripts/release.ts prune <tree> [--keep N]`; pass the arguments directly,
without an extra `--` separator, for both pnpm release commands. `--keep` must
be a positive integer and defaults to `3`. Like the listing above, the script
enumerates only real directories directly inside the tree whose names match the
release grammar in section 5, ignoring files, symlinks and all other directory
names. It checks no build markers when pruning, so even a failed build with a
matching name counts. It keeps the newest N directory names in descending
lexical order, not by modification time or build success. It also protects the
release `.next` resolves to and directories needed to resolve its symlink chain,
even outside that N. It prints each removed
directory, or a no-op line if nothing was removed. A missing or dangling `.next`
is reported but protects no release and does not prevent deletion; do not prune
to recover from a failed switch. Pruning knows the symlink target, not which
build a still-running process has loaded, which is another reason to restart
and verify first.

Release-directory builds fix the build's writes under the serving output path;
they do not isolate `git pull` or `pnpm install`, which still change the live
checkout and `node_modules`. Testing on this host found that a same-lockfile
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
