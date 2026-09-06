# Dependency patches

Applied by `pnpm install` from the `patchedDependencies` entries in
`pnpm-workspace.yaml`. No extra step: CI and `deploy/README.md` both run plain
`pnpm install --frozen-lockfile`.

## `postgres@3.4.9.patch`

Two defects, four hunks. The first is a shutdown that never settles; the second
is a `reserve()` that never settles. They are unrelated, and each has its own
section below.

### A dead connection's query slot is never cleared, so `end()` never settles

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

#### The placement is the fix, and it is not where it looks like it belongs

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

#### Where this diverges from upstream

Upstream tracks the hang as `porsager/postgres` issue 1097, and open pull
request 1142 proposes a fix. **Ours is deliberately not the same change.** That
pull request clears the slot inside `errored()` — the placement described
above — so it carries the silent-wrong-answer defect; it is also unmerged and
unreleased. Do not resync this patch with it. When a release does land, judge
it against both tests named here rather than against the pull request.

#### It fixes one interleaving, not both

The patch settles `end()` called **after** the connection died. The reverse
order — `end()` called while a query is still in flight, the backend dying
afterwards — still never settles, because `end()` has by then returned a
promise whose only resolver is a `terminate()` that nothing on that path
reaches. That is tracked as Overflow issue 156. Do not read this patch as
making `end()` always settle.

#### Caveat if you reuse this patch elsewhere

`error()` returns early when
`connection.queue === queues.connecting && options.host[retries + 1]` — the
multi-host fallback, at `src/connection.js` lines 382-383. It is the one route
into `error()` that skips the clear, and `errored()` does not run on it either.
The connection is still connecting there, so the pending work is `initial`
rather than `query` — `connect()` assigns it at line 114, and `query` is taken
only inside the types fetch — and a slot of either kind is enough to send
`end()` down its slow path, so the hang survives. Unreachable here: this
repository's `DATABASE_URL` names a single host.

### A queued `reserve()` is dropped when the connection it waits on dies

`reserve()` promises a connection or an error. When the pool is at its bound and
a reserve is queued behind it, `onclose` in the package's `src/index.js` shifts
that reserve out of the pool's `queries` and hands it to the dying connection's
reconnect as its startup query — and a reserve is never *executed* as a startup
query. It is now absent from `queries`, which is the only place `onopen` settles
a reserve from, so it is neither resolved nor rejected and its caller waits for
the life of the process.

Overflow reserves a coordination connection per repository reconciliation, so
this reached users as a reconciliation refused at the full 60-second lock-wait
deadline with its work never run — indistinguishable in the logs from a
repository someone else genuinely held for a minute, while the pool served every
other queued reconciliation in under a second.

Three hunks restore the invariant the queue already assumes: **a reserve stays in
`queries` until an `onopen` resolves it, and is never consumed as a connection's
startup query.**

- `src/index.js` — `onclose` leaves a head-of-queue reserve in `queries` and
  reconnects the socket for it, rather than shifting it out. That is already what
  `reserve()` itself does when it hands a queued reserve to a freshly opened
  connection, so the two paths now agree.
- `src/queue.js` — a `peek`. `Queue` had `push`, `shift` and `remove`, and no way
  to read the head without taking it, which is exactly what `onclose` needs.
- `src/connection.js` — the startup handler opens the connection when its startup
  query is a reserve. Without this the reserve is dropped a second way whenever
  array-type fetching is off (`fetch_types: false`): that branch neither executes
  the reserve nor calls `onopen`, so the connection is stranded in the pool's
  `connecting` queue as well. `fetch_types` defaults on here, so this hunk covers
  a configuration Overflow does not use — it is in because it is the same drop,
  and because leaving it means the repair holds only by the accident that
  fetching array types happens to end in an `onopen`.

`tests/fold/reconciliation-stranded-reservation.test.ts` holds the behaviour at
the level it was reported — the coordination pool at its production bound, one
held backend terminated, every queued reconciliation still served.
`tests/db/reserve-contract.test.ts` holds the client contract directly, with
array-type fetching off.

#### Where this diverges from upstream

Upstream tracks the drop as `porsager/postgres` issue 1195, with no pull request
and no comments as of 2026-09-06. Its reporter states the same invariant and
suggests the same shape: leave a head-of-queue reserve in `queries` on close and
reconnect the socket for it. They also note that issue 751 — a first-ever connect
with `fetch_types: false` never settling its reserve — is likely the same root
cause seen from the other side; the `src/connection.js` hunk is what covers that
path, and `tests/db/reserve-contract.test.ts` exercises it.

#### What it does not fix

A reserve that is a connection's startup query when that connect *fails* is
rejected by `errored()` and left in `queries` anyway, so a later `onopen` shifts
it and settles an already-settled promise while its connection stays in
`connecting`. That is stock behaviour on the `reserve()` path, which has always
left the reserve queued, and this patch does not change it either way.

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
  `tests/db/closesql-connection-death.test.ts`,
  `tests/db/pipelined-query-after-build-failure.test.ts`,
  `tests/db/reserve-contract.test.ts` and
  `tests/fold/reconciliation-stranded-reservation.test.ts` between them say
  whether the release really carries both fixes without the regression. A
  release that carries only one of the two defects' fixes keeps the patch,
  minus the hunks it made redundant.
