# Backing up and restoring the Overflow database

This runbook covers the production `overflow` database on the local
PostgreSQL cluster. It exists because before the drill of 2026-09-10 the host
held no backup of that database anywhere, and no restore had ever been
performed. The `overflow.service` unit and the deployment procedure live in
[README.md](README.md); this file is only about the database.

Values used throughout: the database is `overflow` (the name in the app's
`DATABASE_URL`); the application **role** on this host is `overflow_app` —
not `overflow`, which is only the database's name. The role name is
host-specific: it is whichever login role owns the application's tables,
the one whose credentials the app's `DATABASE_URL` carries. On another
host substitute that role everywhere below; every command and SQL block
here runs verbatim on this one.

## (a) What is backed up

The whole `overflow` database, dumped with `pg_dump --format=custom` by
`scripts/db-backup.sh`, into `overflow-<UTC timestamp>.dump` files. The stamp
has one-second resolution, so a second run landing in the same UTC second
installs `overflow-<stamp>-1.dump` and a third `overflow-<stamp>-2.dump`
instead of replacing the first run's dump, and the name is taken atomically,
so runs racing each other cannot collide on it either. A custom-format dump
restores selectively (`pg_restore --list`, table-level `-L`/`-T` listing and
filtering) and compressed; it restores only into the same major version,
which is the cluster's own (17). The dump reads the database through a normal
connection and takes no lock beyond `ACCESS SHARE`, so the application keeps
serving during the backup.

Not backed up: roles, and anything outside the `overflow` database (other
databases, cluster-wide settings such as `postgresql.conf` and
`pg_hba.conf`). Those are host state; recreate them from this runbook and the
deploy procedure, or dump them separately with
`pg_dumpall --globals-only` if the host is ever migrated.

## (b) The least-privilege backup role

The steady state dumps through a dedicated role that can read, and nothing
else. Run as a database superuser (`sudo -u postgres psql`):

```sql
CREATE ROLE overflow_backup LOGIN PASSWORD '<generated password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE overflow TO overflow_backup;
```

then, connected to the `overflow` database (`\c overflow`):

```sql
GRANT USAGE ON SCHEMA public TO overflow_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO overflow_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO overflow_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE overflow_app IN SCHEMA public
  GRANT SELECT ON TABLES TO overflow_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE overflow_app IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO overflow_backup;
```

The default privileges name `FOR ROLE overflow_app` because migrations create new
tables as the application role, so grants that only cover existing objects go
stale at the next migration; the `FOR ROLE` form covers future objects. The
backup role owns nothing and creates nothing.

Its credentials live only in `/etc/overflow/backup.env`
(root:root `0600`, section (c)). Generate the password with
`openssl rand -hex 24` and never reuse the application role's password.
Hex, not base64: base64 output contains a raw `/` in a large share of
draws, and a raw `/` in the userinfo ends the authority section of a
`postgresql://` URL, so the parse garbles; hex characters are URL-safe.
One accepted exposure: the scripts pass the connection string to the client
tools as a command-line argument, which is briefly visible in the process
list to other local processes. The file it is sourced from is `0600` and the
box is single-administrator; if that trade ever stops being acceptable, the
fix is parsing `DATABASE_URL` into `PG*` environment variables inside the
scripts, which libpq reads without publishing it to the process list.

## (c) Scheduled backups

`deploy/overflow-backup.timer` fires `overflow-backup.service` daily at
01:30 UTC (`Persistent=true`, so a backup missed while the host was down runs
at the next boot). The service runs `scripts/db-backup.sh` as root with
`EnvironmentFile=/etc/overflow/backup.env` — a dedicated file carrying the
backup role's `DATABASE_URL`, **not** the application's
`/etc/overflow/overflow.env`, so the backup path never holds the application
role's credentials or any other secret the app needs.

Create the environment file (as root):

```bash
install -d -o root -g root -m 0700 /etc/overflow
[ -e /etc/overflow/backup.env ] \
  || install -o root -g root -m 0600 /dev/null /etc/overflow/backup.env
chmod 0600 /etc/overflow/backup.env
chown root:root /etc/overflow/backup.env
```

Put one line in it:

```bash
DATABASE_URL=postgresql://overflow_backup:<password>@127.0.0.1:5432/overflow
```

`<password>` is the hex string generated above: hex embeds in the URL
safely, which is one reason the recipe is `rand -hex` and not `rand
-base64`.

Then install and enable the units:

```bash
install -o root -g root -m 0644 \
  /srv/overflow/deploy/overflow-backup.service /etc/systemd/system/
install -o root -g root -m 0644 \
  /srv/overflow/deploy/overflow-backup.timer /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/overflow-backup.service \
  /etc/systemd/system/overflow-backup.timer
systemctl daemon-reload
systemctl enable --now overflow-backup.timer
systemctl list-timers overflow-backup.timer
```

`enable --now` is right for a timer — there is no serving process to switch —
unlike the deploy procedure's warning against it for the web service.

Verify the first scheduled run in the journal:

```bash
journalctl -u overflow-backup.service -n 50 --no-pager
```

and that a dump file appeared in `/var/backups/overflow`. A failed run
notifies the maintainer by email through `OnFailure=` — see
[failure alerts](README.md#12-failure-alerts).

## (d) Backup location and retention

Backups land in `/var/backups/overflow`, root:root `0700`, created by the
script on first use; dump files inside are `0600` because the script sets
`umask 077` before creating anything — a manual drill run has no unit
involved and produces `0600` all the same. The unit's `UMask=0077` is
defense in depth for the same property, not the mechanism.
`db-backup.sh` prunes `overflow-*.dump` files older than 14 days
(`--retention-days`, default 14) after each successful dump — 15 daily dumps
are retained at the steady state, and nothing not matching `overflow-*.dump`
in the directory is ever deleted. The pattern covers the `-1`, `-2` suffixed
names a same-second extra run takes, so those are retained and pruned on the
same schedule. The exception: a run's partial, `.overflow-<pid>.dump.incomplete`,
older than one day is reclaimed by the next run's sweep. The first real backup
was `overflow-20260910T154923Z.dump` (22.7 MB), taken during the 2026-09-10
drill; it later aged out under the 14-day retention policy.

The directory is on the same filesystem as the database. That is fine for the
failure modes this runbook targets — a bad migration, a bad deploy, a dropped
table — where the database volume itself survives; it is not protection
against a lost disk. If off-host copies are wanted later, `rsync` or
`rclone` out of `/var/backups/overflow` from a second timer; the dump files
are plain files.

## (e) Restoring

`scripts/db-restore.sh [--allow-live] TARGET_DATABASE DUMP_FILE` restores a
dump with `pg_restore --clean --if-exists --no-owner --no-privileges`. The
connection comes from `DATABASE_URL` with the target name substituted; a
target equal to the database `DATABASE_URL` names is refused unless
`--allow-live` is passed, because `--clean` drops existing objects. The
archive is streamed on stdin, so the dump file only has to be readable by
whoever runs the script.

### (e.1) Drill: restore into a scratch database and compare

The quarterly drill (section (g)). Everything here is read-only against
production; the scratch database is dropped afterwards. As root, from the
deployment tree:

```bash
set -a; . /etc/overflow/overflow.env; set +a
# Named before the drill runs, because the later blocks of this section — the
# comparison, the grant, the listing, the dropdb — need it, and a subshell
# cannot hand a variable back to the shell it was typed in.
scratch="overflow_drill_$(date +%s)"

(
  set -e
  # Take the run's LAST stdout line, which is the path it installed. The run's
  # status is read before the line is picked, because `$(… | tail -1)` reports
  # tail's status and would let a failed backup carry on with an empty path,
  # surfacing much later as "install: cannot stat ''".
  output=$(bash scripts/db-backup.sh)
  dump=$(printf '%s\n' "$output" | tail -1)
  # $dump is e.g. /var/backups/overflow/overflow-<stamp>.dump — or
  # overflow-<stamp>-1.dump when another run had already taken the plain name
  # in that second. Copy that exact path; do not reconstruct it from the
  # timestamp.
  [ -n "$dump" ] || { printf '%s\n' "no dump path printed — the backup run failed" >&2; exit 1; }

  # Everything below is gated on the backup having worked, so a failed run stops
  # HERE rather than leaving an overflow_drill_<epoch> database behind for the
  # cleanup at the end of this section to never reach.
  sudo -u postgres createdb "$scratch"

  # The backup directory is root-only, and the deployed restore script is 0750
  # root:overflow, unreadable by postgres. Stage postgres-readable copies of
  # both; the restore runs as the postgres OS user over peer auth.
  install -o postgres -g postgres -m 0400 \
    "$dump" /tmp/overflow-drill-dump-staging.dump
  install -o postgres -g postgres -m 0500 \
    /srv/overflow/scripts/db-restore.sh /tmp/overflow-drill-restore.sh
  sudo -u postgres env DATABASE_URL=postgresql:///"$scratch" \
    bash /tmp/overflow-drill-restore.sh --allow-live "$scratch" \
    /tmp/overflow-drill-dump-staging.dump
)
```

The subshell is what makes the gate safe to paste: the `set -e` and the `exit`
belong to it, and it is the operator's shell that keeps running afterwards.
This runbook sets no `set -e` in the shell the operator is standing in, and an
`exit` typed there would close it — which is why the refusal above is a
subshell's `exit 1` and not a bare one. If the block stops without printing the
path, the backup failed and nothing was created.

Note the `--allow-live`: the target equals the database the drill's
`DATABASE_URL` names, so the safety guard demands the flag be typed on
purpose; nothing live is named. Then compare, per public table, production
against the scratch:

```bash
for t in $(sudo -u postgres psql -d overflow -tAc \
    "select tablename from pg_tables where schemaname='public' order by tablename"); do
  p=$(sudo -u postgres psql -d overflow -tAc "select count(*) from \"$t\"")
  s=$(sudo -u postgres psql -d "$scratch" -tAc "select count(*) from \"$t\"")
  printf '%-45s prod=%-9s scratch=%-9s %s\n' "$t" "$p" "$s" \
    "$([ "$p" = "$s" ] && echo match || echo MISMATCH)"
done
```

A restored copy is EXPECTED to lag the tree, and by how much is the drift
between the dump and the deploys since it was taken — the same count of
migrations (e.2) has to apply before its replacement can serve, which is why
the drill records it. `scripts/deploy-migration-status.ts` prints one line
per migration the tree carries that the database it names does not record,
and prints nothing at all when there is no lag. Point it at the scratch copy
the way (e.2) points at its replacement — the environment is already loaded
from this section's first block, so only the database name changes — but read
the copy as the application role, and the restore left it unreadable to that
role: `db-restore.sh` runs with `--no-owner --no-privileges`, so every table
in the scratch belongs to `postgres` with default ACLs and the application
role holds nothing on it. Grant it the read (as superuser, the same identity
the comparison loop above already uses, which is why that loop is unaffected):

```bash
sudo -u postgres psql -q -d "$scratch" \
  -c "GRANT USAGE ON SCHEMA public TO overflow_app; GRANT SELECT ON ALL TABLES IN SCHEMA public TO overflow_app"
```

then the listing, with its status recorded alongside it:

```bash
scratch_url="${DATABASE_URL%/*}/$scratch"
pending="$(DATABASE_URL="$scratch_url" node scripts/deploy-migration-status.ts)"
status=$?
printf 'pending migrations in %s (listing exit %s):\n%s\n' \
  "$scratch" "$status" "${pending:-(none)}"
```

That `printf` is what makes the recording trustworthy rather than merely
present. A listing that could not be produced prints nothing, which is exactly
what no lag also prints, so the two would otherwise reach the drill log
looking alike — the same trap (e.2)'s gate refuses on for the same reason.
Carrying the command's exit status in the line distinguishes them: `0` beside
`(none)` is a current copy, and any other value beside it is a listing that
never arrived, which is a failed drill step and not a measurement.

The scratch copy is NOT migrated: the drill compares data, and migrating it
would measure nothing about the restore. The migration step belongs to (e.2).
Record the outputs — dump bytes, backup and restore durations, per-table
counts, pg_restore stderr, the pending-migration line above — in the drill
log. Append the entry to
`/var/backups/overflow/drill-log.md` (root:root `0600`). Then clean up,
keeping the dump:

```bash
sudo -u postgres dropdb "$scratch"
rm /tmp/overflow-drill-dump-staging.dump /tmp/overflow-drill-restore.sh
```

The latest drill (2026-09-28) measured `db-backup.sh` at 48.8 s and
`db-restore.sh` at 75.1 s wall clock against a 167.7 MB dump covering 28
public tables and about 1,342,000 rows. Its full measurements and per-table
comparison are in the latest entry of `/var/backups/overflow/drill-log.md`.

### (e.2) Replacing the live database

The path for "the current database is lost, or must be rolled back". Stop the
application first so no writes go to the old database mid-swap:

```bash
systemctl stop overflow.service
```

As root and from the deployment tree (`/srv/overflow`), create the replacement
owned by the application role and restore **as the application role**, using
its own `DATABASE_URL`: every command below is relative to that tree.
`--no-owner` then makes the app role own every restored object, which is the
production shape, so this path needs no ownership fixups at all.

```bash
sudo -u postgres createdb -O overflow_app overflow_replacement
set -a; . /etc/overflow/overflow.env; set +a
bash scripts/db-restore.sh overflow_replacement \
  /var/backups/overflow/overflow-<stamp>.dump
```

Substitute the dump you mean, spelled exactly as the backup run printed it:
the plain `overflow-<stamp>.dump`, or the `overflow-<stamp>-1.dump` that run
installed when another run already held the plain name for that second.

The restored copy carries the schema the dump was taken with, and a dump
carries `schema_migrations` as of the moment it ran — 01:30 UTC, before
whatever deploys have landed since. Deploys apply migrations
([README.md section 10](README.md#10-deploying-a-new-revision)), so a restored
database is normally behind the tree, and that is exactly the state the
readiness endpoint refuses: it answers `200` only when every migration the
served build bundles is recorded applied, so a schema behind the build answers
`503 {"status":"unavailable"}` while a row count still passes. Migrate the
replacement before anything else touches it:

```bash
cd /srv/overflow
replacement_url="${DATABASE_URL%/*}/overflow_replacement"
DATABASE_URL="$replacement_url" pnpm db:migrate
```

Three things about that block are traps rather than preferences:

- **The inline assignment wins over the tree's `.env`.** `db:migrate` is
  `node --env-file-if-exists=.env scripts/migrate.ts`, and `node --env-file`
  does not override a variable already present in the process environment —
  so the replacement is the target even on a tree that carries a `.env`
  naming production.
- **It runs from `/srv/overflow`, not from a checkout.** The migrations
  applied must be the ones the SERVING build bundles, and
  `src/lib/db/migration-manifest.ts` is the served build's own record of them,
  pinned equal to `db/migrations/*.sql` by
  `tests/db/migration-manifest.test.ts`. A restore driven from any other tree
  can leave a schema the readiness probe still refuses.
- **It runs before the rename, not after.** The live `overflow` is untouched
  while it runs, the replacement is still verifiable under its own name, and a
  failing migration aborts before anything has been swapped. The readiness
  endpoint cannot answer at this point — the service is stopped — so the
  schema gate below is the pre-rename check, and the end-to-end confirmation
  stays where deploy/README.md section 7 puts it, after the restart.

The restore carries no privileges: `--no-privileges` skips every ACL the
dump recorded, so the replacement database has neither section (b)'s
backup-role table SELECT nor its DEFAULT PRIVILEGES, and the first nightly
backup after the swap would fail with "permission denied" for
`overflow_backup`. Re-apply section (b)'s grants to the replacement now, after
the migration above rather than before it. `GRANT SELECT ON ALL TABLES IN
SCHEMA public` is a snapshot of the tables that exist at the moment it runs;
reaching objects created after it is the `ALTER DEFAULT PRIVILEGES` half's
job, and that half covers objects the application role creates in `public` and
nothing else. On this path that is enough — migrations run as the application
role, in `public`, so a swap made in the other order would still leave the
backup role able to read every table the migration added, and the order is not
covering a failure this path has today. It is the general rule written down:
migrate, then grant, so the snapshot covers the whole schema whatever ends up
creating it, so a future migration creating an object under another role, or
outside `public`, is covered by the same block rather than by default
privileges. As superuser, connected to the replacement:

```bash
sudo -u postgres psql -d overflow_replacement <<'SQL'
GRANT CONNECT ON DATABASE overflow_replacement TO overflow_backup;
GRANT USAGE ON SCHEMA public TO overflow_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO overflow_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO overflow_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE overflow_app IN SCHEMA public
  GRANT SELECT ON TABLES TO overflow_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE overflow_app IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO overflow_backup;
SQL
```

CONNECT is usually already effective — it is granted to `PUBLIC` by default
and `--no-privileges` revokes nothing — so that line only matters where a
cluster has revoked it; every statement is idempotent.

The target (`overflow_replacement`) differs from the database the URL names
(`overflow`), so no `--allow-live` is needed. Verify as in (e.1), with
`overflow_replacement` in the scratch's place, schema first. A row count
answers "can the app role read" and says nothing about "can the served build
run", and those are exactly the two things a stale restore separates: the
count passes on the database the readiness endpoint refuses.
`scripts/deploy-migration-status.ts` prints one line per migration the tree
carries that this database does not record — the name, a tab, then a marker:
`-`, or `review` when the file carries the literal `overflow: mixed-version
review` — and prints nothing at all when the database is current. Here the
listing says only one thing: which migrations the swap would go live without.
The marker is the deploy procedure's own mixed-version signal
([README.md section 10](README.md#10-deploying-a-new-revision)) and it does not
bind a restore — the previous release is stopped, so nothing serves against the
old schema while this runs, and there is no mixed-version window to review:

```bash
pending="$(DATABASE_URL="$replacement_url" node scripts/deploy-migration-status.ts)"
status=$?
if [ "$status" -ne 0 ]; then
  printf 'could not list the pending migrations; the replacement is NOT verified — do not swap it in\n' >&2
  false
elif [ -n "$pending" ]; then
  printf 'the replacement is behind the tree by:\n%s\ndo not swap it in — re-run the migration block above from /srv/overflow, then this gate\n' "$pending"
  false
fi
```

Three properties of that gate are deliberate. The status half follows
[README.md section 10](README.md#10-deploying-a-new-revision), which stops on
a failed status command in both its forms — the deploy script wraps the same
call in `|| { …; exit 1; }`, and the manual path says to run it by hand and
stop if it fails. It matters because `deploy-migration-status.ts` prints
nothing to stdout when it cannot run at all — `node` off `PATH`, the wrong
working directory, a database that is not there, a database carrying no
`schema_migrations` — and puts the reason on stderr with a nonzero status, so
an empty listing is both "current" and "could not ask". All four are refused
here, and two of them would have been caught anyway by the row count below,
which errors on an absent database and on one carrying no `schema_migrations`
rather than printing a count. The one with nothing behind it is a listing
that could not be produced at all — `node` off `PATH`, the wrong working
directory — because the ledger and the tables are intact there, the row count
answers, and a replacement two migrations behind would have gone live exactly
as (e.2) exists to prevent. The `elif` half is the other side of the same
command and is not covered by that precedent: the script exits `0` whether or
not it printed anything, because the deploy procedure reads its listing rather
than its status, so only the output can tell "current" from "behind". The
status is captured into a variable rather than tested inline with `||` because
the second branch has to be reached on the same condition — an
`|| { …; false; }` in front of it runs that branch and then falls straight
through the `if` on an empty listing, which ends the pasted block `0` and
reads as a pass. And nothing here calls `exit`: no block in this runbook sets
`set -e`, and an `exit` inside a pasted block closes the shell the operator is
standing in.

A refusal here is a cheap state to be in, because it happens before the
rename: nothing has been swapped, the live `overflow` is exactly as it was,
and the whole recovery is `systemctl start overflow.service` — the database
was never touched, only the service was stopped. Fix whatever the gate named,
the migration it could not apply or the listing it could not produce, and run
this section again from the top — the stop first, since the service is running
again, then `sudo -u postgres dropdb overflow_replacement`. The replacement is
disposable until the rename and the live database is not, and a half-restored
replacement cannot simply be restored over: `--clean` drops only the objects
the dump names, so a table a migration has added since the dump still holds its
foreign key onto the parent the restore is trying to drop, the second restore
errors out on that drop and leaves less behind than it started with, and the
retry ends in a worse state than the refusal it was recovering from. Drop the
database and the section starts again from an empty one.

Then the smallest real check that the replacement serves before the rename —
the app role can authenticate, and the restored tables answer a read — with
the environment and `$replacement_url` already loaded from the blocks above:

```bash
psql "$replacement_url" -tAc "select count(*) from issues"
```

It must print a row count, not an error. Then swap the names and start the
service:

```bash
sudo -u postgres psql -c "alter database overflow rename to overflow_old_<epoch>"
sudo -u postgres psql -c "alter database overflow_replacement rename to overflow"
systemctl start overflow.service
```

and verify the service per deploy/README.md section 7. To repoint by
configuration instead of renaming, skip the two `alter database` lines and
change `DATABASE_URL` in `/etc/overflow/overflow.env` to name
`overflow_replacement` before the restart — the rename exists so the
environment file, the unit and the deploy procedure stay untouched. Drop
`overflow_old_<epoch>` only after a soak period: the old database is the
rollback for a bad restore, and dropping it is the point of no return.

### (e.3) Ownership fixups

Only needed when a dump was restored by a role that is not the intended
owner — the drill path restores as `postgres`. As superuser, in the restored
database:

```sql
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO overflow_app', r.tablename);
  END LOOP;
  FOR r IN SELECT sequencename FROM pg_sequences WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO overflow_app', r.sequencename);
  END LOOP;
END $$;
```

plus, if the restoring role is not already the database owner:
`ALTER DATABASE <name> OWNER TO overflow_app;`. Ownership is not the only
thing a `--no-privileges` restore leaves behind: ACLs are skipped too, so a
database restored on this path also needs section (b)'s grants re-applied —
exactly what (e.2) does before its rename — or the nightly backup fails
with "permission denied" for `overflow_backup`. The replacement path (e.2)
needs neither repair.

## (f) RPO and RTO

**RPO (data at risk): up to 24 hours.** The timer fires daily; a failure at
any moment loses the commits since the previous 01:30 UTC dump. This is the
accepted tradeoff. To tighten it: add more `OnCalendar=` lines to
`overflow-backup.timer` (for example every six hours) — retention only needs
lowering if disk pressure says so. For a sub-hour RPO, PostgreSQL WAL
archiving is the real mechanism and is out of scope here.

**RTO (time to restored service): machine time seconds, end-to-end minutes.**
The drill of 2026-09-28 measured, against the 167.7 MB production dump
(28 tables, about 1,342,000 rows): `db-backup.sh` 48.8 s and
`db-restore.sh` 75.1 s wall clock, with empty pg_restore stderr. At comparison
time, 26 public tables matched; the write-active
`repository_reconciliation_dirty_subjects` (29 production vs 25 scratch) and
`webhook_deliveries` (13,686 vs 13,675) tables had drifted between the dump
and the live count. Machine time scales with the dump size; the dominant RTO
terms are the operator steps of (e.2) — create the replacement, migrate it,
verify, rename, restart the service — so budget tens of minutes including
human response time, not seconds.

## (g) Restore-testing cadence

- **Per change:** the automated restore test
  `tests/db/backup-restore.test.ts` runs in CI on every PR: it seeds a
  containerized Postgres, runs both scripts against it with the client tools
  exec'd inside the container, mutates the source after the dump, and asserts
  the restored rows equal the seed.
- **Manual drill: at least quarterly.** Run (e.1) end to end, compare all
  public tables, and record the outputs where the deployment records live.
  Re-run the drill and re-measure when the newest dump has grown to roughly
  twice the size recorded in the latest drill-log entry. A restore that has
  not been rehearsed is an assumption; the drill is what keeps this runbook
  true.

## (h) Failure alerts

A failed `overflow-backup.service` run starts
`overflow-alert@overflow-backup.service.service` — the alert template with
the failed unit's full name as the instance — through the unit's
`OnFailure=`, which mails the backup unit's current-boot journal tail — the
`pg_dump` error among it — to the address in `/etc/overflow/alert-recipient`.
That
file is host configuration (root only, one line) and is never committed;
[README.md section 12](README.md#12-failure-alerts) installs the route and
verifies it.

The drill in (e.1) proves a restore works on the day it runs; the alert
route is what tells you a backup failed between drills. Without it, a
nightly backup can fail for weeks unnoticed — an expired backup-role
password, or the grants gap section (e.2) warns about: a swap that skipped
the grants fails the first nightly backup with "permission denied" for
`overflow_backup`.

The template covers `overflow.service` as well as the backup unit
([README.md section 12](README.md#12-failure-alerts)), so an alert can also
carry the service itself — but not the other way round. A restore that
skipped (e.2)'s migration step leaves a service that is up, healthy to every
data check, and answering `503` at `/api/readiness` on a schema behind its
build; nothing about that state fails the unit, so nothing alerts. Two checks
stand between the dump and that state, and neither is the alert route:
(e.2)'s schema gate refuses the swap before the rename, while the live
database is untouched and a wrong answer costs a re-run, and the readiness
curl in README section 7 confirms it end to end once the service is restarted.
A swap that reached a `503` readiness skipped both.
