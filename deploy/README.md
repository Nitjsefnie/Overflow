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

```bash
git clone https://github.com/Nitjsefnie/Overflow.git /srv/overflow
cd /srv/overflow
pnpm install --frozen-lockfile
set -a; . /etc/overflow/overflow.env; set +a
pnpm db:migrate
pnpm build
```

Then set the ownership the unit assumes. The tree is root-owned and readable by
the `overflow` group; nothing in it is group-writable.

```bash
chown -R root:overflow /srv/overflow
chmod -R u=rwX,g=rX,o= /srv/overflow
```

`next start` writes inside `.next/cache` — the image optimizer's output and the
`.previewinfo` and `.rscinfo` files — and that directory is the only one the
unit makes writable. It must exist before the service starts: `ReadWritePaths`
naming a missing path is a start failure.

```bash
mkdir -p /srv/overflow/.next/cache
chown -R overflow:overflow /srv/overflow/.next/cache
chmod -R u=rwX,g=rX,o= /srv/overflow/.next/cache
```

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

```bash
systemctl is-active overflow.service
printf 'MainPID before the switch: %s\nMainPID now:               %s\n' \
  "$(cat /run/overflow-preswitch-mainpid)" \
  "$(systemctl show overflow.service -p MainPID --value)"
systemctl show overflow.service \
  -p MainPID -p User -p Group -p NoNewPrivileges -p ProtectSystem
ps -o user=,pid=,args= -p "$(systemctl show overflow.service -p MainPID --value)"
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

Expected: `active`; the two `MainPID` values differ and the current one is not
`0`; `User=overflow`, `Group=overflow`, `NoNewPrivileges=yes`,
`ProtectSystem=strict`; one `ps` line, owned by `overflow` and never `root`;
`200` from curl.

The two `MainPID` values are the check that distinguishes a switch from a
reload. `systemctl show` reports the *loaded fragment*, so it answers
`User=overflow` from the moment `daemon-reload` runs, whether or not anything
restarted; only a new PID says the process serving requests is the one the
hardened unit started. A pair that has not moved means the old process is still
serving and section 6's `restart` did not run.

Two details in those commands are the point of them. Ask `systemctl` for the
PID instead of asking `ps` for Node processes: `ps -C node` matches on `comm`,
and Next rewrites its process title to `next-server (v…`, so `ps -o user= -C
node` never sees this service at all and answers `root` from whatever unrelated
Node processes the host happens to run — the alarming answer whether the
hardening worked or not. And `Type=simple` has no readiness barrier, so
`systemctl start` returns as soon as the process is forked, before Next binds
the port; the curl retry is what absorbs that race instead of reporting a
connection refusal as a failed deploy.

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

If the hardened unit fails to start, capture why before restoring — the restored
state runs the application as root again, which is the state this procedure
exists to leave behind, so the failure has to be fixed rather than forgotten.

```bash
systemctl status overflow.service --no-pager
journalctl -u overflow.service -n 100 --no-pager
```

The failures this configuration produces:

- `ReadWritePaths` names a path that does not exist — `/srv/overflow/.next/cache`
  was not created, or a rebuild replaced `.next` without it.
- `/etc/overflow/overflow.env` does not exist — section 4 was skipped. Its mode
  is not a start failure: systemd reads the file as root, before the drop to
  `User=overflow`, so `0600 root:root` is correct and a service that cannot
  read the file itself is the design, not a fault.
- `postgresql.service` does not exist on this host, so the unit's
  `Requires=postgresql.service` refuses the start outright. That is the
  remote-database case; see the note at the top of this file.
- `/usr/local/bin/node` is missing or is a dangling symlink into `/root`.
- The tree is unreadable to the group, so `next` cannot load its own build.

Check section 8's three preconditions, then restore with the same commands.
`systemctl is-active` reporting `active` and the HTTP check returning `200` are
the evidence the rollback worked; a journal that shows the process starting as
`root:root` is what tells you the old unit — not the new one — is the one now
running.

The rollback decays with every deploy, and neither of those two checks reports
it. Section 10 migrates the production database and does not touch
`/root/overflow`, so from the first revision deploy onwards the saved unit runs
older code against a newer schema. Once the hardened service is trusted, stop
treating the old checkout as the rollback: roll back by revision instead, with
`/srv/overflow` checked out at the previously deployed SHA and rebuilt.

## 10. Deploying a new revision

Install, migrate and build run as root inside the tree. Only the service runs as
`overflow`, and the ownership reset afterwards is what keeps it that way: a
build writes new files as root, and `.next/cache` has to be handed back.

```bash
cd /srv/overflow
git pull --ff-only origin main
pnpm install --frozen-lockfile
set -a; . /etc/overflow/overflow.env; set +a
pnpm db:migrate
pnpm build
chown -R root:overflow /srv/overflow
chmod -R u=rwX,g=rX,o= /srv/overflow
mkdir -p /srv/overflow/.next/cache
chown -R overflow:overflow /srv/overflow/.next/cache
chmod -R u=rwX,g=rX,o= /srv/overflow/.next/cache
systemctl restart overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

A merge changes nothing a user can see until that rebuild and restart. If the
revision includes a change to `overflow.service`, repeat section 6 as well:
`git pull` updates the copy in the tree, not the one systemd reads. Nothing
here refreshes `/root/overflow.service.pre-hardening` or the checkout it starts
from, which is what the last paragraph of section 9 is about.
