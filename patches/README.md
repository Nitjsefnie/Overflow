# Dependency patches

Applied by `pnpm install` from the `patchedDependencies` entries in
`pnpm-workspace.yaml`. No extra step: CI and `deploy/README.md` both run plain
`pnpm install --frozen-lockfile`.

## `postgres@3.4.9.patch`

In the `postgres` package's own `src/connection.js` — not this repository's
`src/` — a connection holds the query it is serving in a `query` slot, and only
the `ReadyForQuery` handler clears it. A backend that has gone away never sends
one, so once a connection died mid-query the slot stayed occupied: `end()` saw
a query still in flight, declined to terminate, and handed back a promise
nothing left on that path could resolve. `sql.end()` awaits every connection in
the pool, so a single dead connection stranded the whole shutdown, and with it
`closeSql()` and everything awaiting it — `scripts/reconcile.ts` awaits it in a
`finally`, so the reconcile script simply never exited.

The patch clears the slot in `error()`, immediately after its `errored()` call.
`tests/db/closesql-connection-death.test.ts` holds the behaviour.

### The placement is the fix, and it is not where it looks like it belongs

`errored()` is the tempting spot, one frame further in, and it is wrong: it is
also reached with the connection **alive**. `execute()`'s catch calls it when a
query's parameters cannot be serialised (`UNDEFINED_VALUE`,
`MAX_PARAMETERS_EXCEEDED`, `NOT_TAGGED_CALL`) and then recovers by writing a
`Sync` — and that `Sync`'s `ReadyForQuery` still has to find the rejected query
in the slot. Clear it there and the next query takes the empty slot and is
resolved by the failed query's answer instead: no rows, no error, a silent
wrong answer to a caller that did nothing wrong. The pool reaches that state
whenever every connection is busy, because its `handler` falls through to
`busy.shift()`. `error()` has no such route — every call site is a dead or
closing socket — which is what makes clearing safe there.
`tests/db/pipelined-query-after-build-failure.test.ts` holds the placement.

### Where this diverges from upstream

Upstream tracks the hang as `porsager/postgres` issue 1097, and open pull
request 1142 proposes a fix. **Ours is deliberately not the same change.** That
pull request clears the slot inside `errored()` — the placement described
above — so it carries the silent-wrong-answer defect; it is also unmerged and
unreleased. Do not resync this patch with it. When a release does land, judge
it against both tests named here rather than against the pull request.

### It fixes one interleaving, not both

The patch settles `end()` called **after** the connection died. The reverse
order — `end()` called while a query is still in flight, the backend dying
afterwards — still never settles, because `end()` has by then returned a
promise whose only resolver is a `terminate()` that nothing on that path
reaches. That is tracked as Overflow issue 156. Do not read this patch as
making `end()` always settle.

### Caveat if you reuse this patch elsewhere

`error()` returns early when
`connection.queue === queues.connecting && options.host[retries + 1]` — the
multi-host fallback, at `src/connection.js` lines 382-383. It is the one route
into `error()` that skips the clear, and `errored()` does not run on it either.
The connection is still connecting there, so the pending work is `initial`
rather than `query` — `connect()` assigns it at line 114, and `query` is taken
only inside the types fetch — and a slot of either kind is enough to send
`end()` down its slow path, so the hang survives. Unreachable here: this
repository's `DATABASE_URL` names a single host.

### Housekeeping

- **The patch file and `pnpm-lock.yaml` move together.** The lockfile pins the
  patch by content hash, so hand-editing the patch without re-running
  `pnpm patch-commit` makes `pnpm install --frozen-lockfile` fail.
- **Drop the patch once a `postgres` release contains the fix.** Delete
  `patches/postgres@3.4.9.patch` and the `patchedDependencies` entry in
  `pnpm-workspace.yaml`, then re-run `pnpm install` and commit the regenerated
  `pnpm-lock.yaml` — by the coupling above, the lockfile still carries the
  `patchedDependencies` block and its content hash until you do, and
  `pnpm install --frozen-lockfile` fails on the mismatch. Then let
  `tests/db/closesql-connection-death.test.ts` and
  `tests/db/pipelined-query-after-build-failure.test.ts` between them say
  whether the release really carries the fix without the regression.
