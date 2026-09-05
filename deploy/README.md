# Deploying Overflow as an unprivileged service

`overflow.service` in this directory is the systemd unit the production
deployment runs. It starts Next as the dedicated `overflow` system account, with
the filesystem read-only apart from one cache directory, no capabilities, and no
path under `/root`. `tests/deploy/unit-file.test.ts` fails if any of that is
removed from the unit.

This file is the procedure that makes a host match what the unit expects. The
commands are run as root. Everything except the running service is root-owned:
the service account can read the code it executes and cannot write it, so
code execution inside the web process cannot rewrite what the next restart runs.

Values used throughout: deployment tree `/srv/overflow`, service account
`overflow:overflow`, Node 24.17.0 at `/usr/local/lib/nodejs/node-v24.17.0`,
secrets in `/etc/overflow/overflow.env`, listener `127.0.0.1:3000` behind nginx.

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

## 4. Build the deployment tree

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

## 5. Restrict the environment file

The secrets file holds `DATABASE_URL`, `AUTH_SECRET`, the OAuth credentials,
`TOKEN_ENCRYPTION_KEY` and the webhook secret. The service must read it and must
not be able to write it, and no other account may read it at all.

```bash
chown root:overflow /etc/overflow
chmod 0750 /etc/overflow
chown root:overflow /etc/overflow/overflow.env
chmod 0640 /etc/overflow/overflow.env
```

## 6. Install the unit

```bash
install -o root -g root -m 0644 \
  /srv/overflow/deploy/overflow.service /etc/systemd/system/overflow.service
systemd-analyze verify /etc/systemd/system/overflow.service
systemctl daemon-reload
systemctl enable --now overflow.service
```

`systemd-analyze verify` prints nothing and exits 0 for a well-formed unit; it
names any directive systemd does not recognise.

## 7. Verify

```bash
systemctl is-active overflow.service
systemctl show overflow.service -p User -p Group -p NoNewPrivileges -p ProtectSystem
ps -o user= -C node
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

Expected: `active`; `User=overflow`, `Group=overflow`, `NoNewPrivileges=yes`,
`ProtectSystem=strict`; `overflow` from `ps`, never `root`; `200` from curl.
`systemd-analyze security overflow.service` reports the remaining exposure and
is worth reading after any change to the unit.

Restrictions only bite on the code paths that use them, so exercise the
application through the browser before calling the switch done: sign in with
GitHub, open the dashboard, and register a repository. That is what makes DNS
resolution, an outbound HTTPS call to GitHub and a database write happen inside
the sandboxed process; `pnpm reconcile` does not, because it runs as root
outside the unit and so is subject to none of these restrictions. The unit sets
`SystemCallErrorNumber=EPERM`, so a syscall the filter blocks surfaces as an
error in the journal rather than as a killed process:

```bash
journalctl -u overflow.service -n 100 --no-pager
```

## 8. Test the rollback before you need it

Do this once, immediately, while the previous unit and checkout are still on
the host. Restore the saved copy, confirm the service comes back on it, then
reinstall the hardened unit and confirm again with section 7.

```bash
systemctl stop overflow.service
cp -a /root/overflow.service.pre-hardening /etc/systemd/system/overflow.service
systemctl daemon-reload
systemctl start overflow.service
systemctl is-active overflow.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

`active` and `200` mean the rollback path works. Then repeat section 6 and
section 7 to get back to the hardened unit. A rollback that has never been run
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
- The service cannot read `/etc/overflow/overflow.env` — ownership or mode was
  not changed in section 5, or the directory is still `0700 root:root`.
- `/usr/local/bin/node` is missing or is a dangling symlink into `/root`.
- The tree is unreadable to the group, so `next` cannot load its own build.

Then restore, with the same commands as section 8. `systemctl is-active`
reporting `active` and the HTTP check returning `200` are the evidence the
rollback worked; a journal that shows the process starting as `root:root` is
what tells you the old unit — not the new one — is the one now running.

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
systemctl restart overflow.service
systemctl is-active overflow.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
```

A merge changes nothing a user can see until that rebuild and restart. If the
revision includes a change to `overflow.service`, repeat section 6 as well:
`git pull` updates the copy in the tree, not the one systemd reads.
