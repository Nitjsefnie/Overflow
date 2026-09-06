# Dependency patches

Applied by `pnpm install` from the `patchedDependencies` entries in
`pnpm-workspace.yaml`. No extra step: CI and `deploy/README.md` both run plain
`pnpm install --frozen-lockfile`.

## `postgres@3.4.9.patch`

`errored()` in the `postgres` package's own `src/connection.js` — not this
repository's `src/` — rejected the in-flight query but left the connection's
own `query` reference pointing at it. Only the `ReadyForQuery` handler ever
cleared that reference, and a backend that has gone away never sends one — so
`end()` saw a query still in flight, declined to terminate, and handed back a
promise nothing left on that path could resolve. `sql.end()` awaits every
connection in the pool, so a single dead connection stranded the whole
shutdown, and with it `closeSql()` and everything awaiting it —
`scripts/reconcile.ts` awaits it in a `finally`, so the reconcile script simply
never exited. The patch clears the reference immediately after rejecting it,
the way the next line already does for `initial`.

Upstream tracks this as `porsager/postgres` issue 1097, and open pull request
1142 carries the same one-line change alongside a wider repair of the
connection-reset path. Neither is in a release yet, which is why the fix is
carried here.

Two things to know before touching this:

- **The patch file and `pnpm-lock.yaml` move together.** The lockfile pins the
  patch by content hash, so hand-editing the patch without re-running
  `pnpm patch-commit` makes `pnpm install --frozen-lockfile` fail.
- **Drop the patch once a `postgres` release contains the fix.** Delete
  `patches/postgres@3.4.9.patch` and the `patchedDependencies` entry in
  `pnpm-workspace.yaml`, then re-run `pnpm install` and commit the regenerated
  `pnpm-lock.yaml` — by the coupling above, the lockfile still carries the
  `patchedDependencies` block and its content hash until you do, and
  `pnpm install --frozen-lockfile` fails on the mismatch. Then let
  `tests/db/closesql-connection-death.test.ts` say whether the release really
  carries the fix.
