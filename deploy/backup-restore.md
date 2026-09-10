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
`scripts/db-backup.sh`, into `overflow-<UTC timestamp>.dump` files. A
custom-format dump restores selectively (`pg_restore --list`, table-level
`-L`/`-T` listing and filtering) and compressed; it restores only into the
same major version, which is the cluster's own (17). The dump reads the
database through a normal connection and takes no lock beyond
`ACCESS SHARE`, so the application keeps serving during the backup.

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
`openssl rand -base64 24` and never reuse the application role's password.
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

and that a dump file appeared in `/var/backups/overflow`.

## (d) Backup location and retention

Backups land in `/var/backups/overflow`, root:root `0700`, created by the
script on first use; dump files inside are `0600` because the script sets
`umask 077` before creating anything — a manual drill run has no unit
involved and produces `0600` all the same. The unit's `UMask=0077` is
defense in depth for the same property, not the mechanism.
`db-backup.sh` prunes `overflow-*.dump` files older than 14 days
(`--retention-days`, default 14) after each successful dump — 14 daily dumps
are retained at the steady state, and nothing not matching `overflow-*.dump`
in the directory is ever deleted. After the drill of 2026-09-10 the directory
holds the first real backup, `overflow-20260910T154923Z.dump` (22.7 MB).

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
bash scripts/db-backup.sh
# prints /var/backups/overflow/overflow-<stamp>.dump

scratch="overflow_drill_$(date +%s)"
sudo -u postgres createdb "$scratch"

# The backup directory is root-only, so stage a postgres-readable copy of the
# dump; the restore runs as the postgres OS user over peer auth.
install -o postgres -g postgres -m 0400 \
  /var/backups/overflow/overflow-<stamp>.dump /tmp/overflow-drill-dump-staging.dump
sudo -u postgres env DATABASE_URL=postgresql:///"$scratch" \
  bash scripts/db-restore.sh --allow-live "$scratch" \
  /tmp/overflow-drill-dump-staging.dump
```

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

Record the outputs — dump bytes, backup and restore durations, per-table
counts, pg_restore stderr — in the drill log. Then clean up, keeping the
dump:

```bash
sudo -u postgres dropdb "$scratch"
rm /tmp/overflow-drill-dump-staging.dump
```

### (e.2) Replacing the live database

The path for "the current database is lost, or must be rolled back". Stop the
application first so no writes go to the old database mid-swap:

```bash
systemctl stop overflow.service
```

Create the replacement owned by the application role and restore **as the
application role**, using its own `DATABASE_URL`:
`--no-owner` then makes the app role own every restored object, which is the
production shape, so this path needs no ownership fixups at all.

```bash
sudo -u postgres createdb -O overflow_app overflow_replacement
set -a; . /etc/overflow/overflow.env; set +a
bash scripts/db-restore.sh overflow_replacement \
  /var/backups/overflow/overflow-<stamp>.dump
```

The target (`overflow_replacement`) differs from the database the URL names
(`overflow`), so no `--allow-live` is needed. Verify as in (e.1), with
`overflow_replacement` in the scratch's place — and exercise the application
against the replacement before renaming, by pointing a throwaway
`DATABASE_URL` at it. Then swap the names and start the service:

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
`ALTER DATABASE <name> OWNER TO overflow_app;`. The replacement path (e.2) needs
none of this.

## (f) RPO and RTO

**RPO (data at risk): up to 24 hours.** The timer fires daily; a failure at
any moment loses the commits since the previous 01:30 UTC dump. This is the
accepted tradeoff. To tighten it: add more `OnCalendar=` lines to
`overflow-backup.timer` (for example every six hours) — retention only needs
lowering if disk pressure says so. For a sub-hour RPO, PostgreSQL WAL
archiving is the real mechanism and is out of scope here.

**RTO (time to restored service): machine time seconds, end-to-end minutes.**
The drill of 2026-09-10 measured, against the 22.7 MB production dump
(25 tables, about 149,000 rows): `db-backup.sh` 3 s, `db-restore.sh` 4 s
wall clock, empty pg_restore stderr, and all 25 public tables matching
production row counts. Machine time scales with the dump size; the dominant
RTO terms are the operator steps of (e.2) — create the replacement, verify,
rename, restart the service — so budget tens of minutes including human
response time, not seconds.

## (g) Restore-testing cadence

- **Per change:** the automated restore test
  `tests/db/backup-restore.test.ts` runs in CI on every PR: it seeds a
  containerized Postgres, runs both scripts against it with the client tools
  exec'd inside the container, mutates the source after the dump, and asserts
  the restored rows equal the seed.
- **Manual drill: at least quarterly.** Run (e.1) end to end, compare all
  public tables, and record the outputs where the deployment records live. A
  restore that has not been rehearsed is an assumption; the drill is what
  keeps this runbook true.
