# Dependency patches

Applied by `pnpm install` from the `patchedDependencies` entries in
`pnpm-workspace.yaml`. No extra step: CI and `deploy/README.md` both run plain
`pnpm install --frozen-lockfile`.

## `postgres@3.4.9.patch`

Two defects, five hunks. The first is a shutdown that never settles; the second
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
repository's `DATABASE_URL` names a single host. That also means this route is
**unreproduced and unfiled** — it is read off the package's source, nobody here
has run it, and no issue tracks it, so treat it differently from the claims in
this file that a probe and a test stand behind.

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

Four hunks restore the invariant the queue already assumes: **a reserve sits in
`queries` until exactly one thing takes it out — the `onopen` that resolves it,
or its own rejection — and it is never consumed as a connection's startup
query.**

- `src/index.js` — `onclose` leaves a head-of-queue reserve in `queries` and
  reconnects the socket for it, rather than shifting it out. That is already what
  `reserve()` itself does when it hands a queued reserve to a freshly opened
  connection, so the two paths now agree.
- `src/index.js` — `reserve()` takes its own pseudo-query back out of `queries`
  when it is rejected. The rejection this repairs happens in the package's
  `errored()`, which has no handle on the pool's queue, so the rejected reserve
  would otherwise stay queued and swallow the next connection that reaches it.
  See *What it fixes that stock did not* below. A queued reserve is also rejected
  by the pool's own `destroy()`, which *does* hold the queue and shifts each item
  out before rejecting it — `Queue.remove`'s `-1` guard is what keeps the wrapper
  inert there. Removing by identity rather than by position is what makes that
  safe: a positional removal would take the *next* queued item out instead, and
  the drain would stop one short of it with its caller left waiting forever.
- `src/queue.js` — a `peek`. `Queue` had `push`, `shift` and `remove`, and no way
  to read the head without taking it, which is exactly what `onclose` needs.
- `src/connection.js` — the startup handler opens the connection when its startup
  query is a reserve, or terminates it when the pool is already ending, which is
  what the bottom of the same function does for every other opening connection.
  Without this the reserve is dropped a second way whenever array-type fetching
  is off (`fetch_types: false`): that branch neither executes the reserve nor
  calls `onopen`, so the connection is stranded in the pool's `connecting` queue
  as well. `fetch_types` defaults on here, so this hunk covers a configuration
  Overflow does not use — it is in because it is the same drop, and because
  leaving it means the repair holds only by the accident that fetching array
  types happens to end in an `onopen`.

`tests/fold/reconciliation-stranded-reservation.test.ts` holds the behaviour at
the level it was reported — the coordination pool at its production bound, one
held backend terminated, every queued reconciliation still served.
`tests/db/reserve-contract.test.ts` holds the client contract directly: a reserve
that opens the pool's first connection and one queued behind a terminated
connection, both with array-type fetching off; a later reservation served after a
reconnect's connect timed out; a non-reserve query queued behind a terminated
reserved connection running exactly once; `end()` settling instead of handing
a connection out of a pool that is shutting down; and every reservation queued
behind a destroyed pool refused rather than only the first, which is what says
the rejection removes by identity and not by position.
`tests/db/postgres-queue.test.ts` holds the `peek` those paths read the queue
with — that it names the element the next `shift` returns at every read position,
not only the first, across a refill of a partly drained queue as well.

#### Where this diverges from upstream

Upstream tracks the drop as `porsager/postgres` issue 1195, with no pull request
and no comments as of 2026-09-06. Its reporter states the same invariant — a
reserve is settled out of `queries` by an `onopen`, never executed as a startup
query — but sketches a **different repair**: leave the reserve in `queries` on
close and reconnect the socket *empty*, explicitly rather than routing it through
`initial`, which drops it.

**This patch routes it through `initial` on purpose.** The whole startup
handshake lives inside `if (initial)` in `ReadyForQuery` — the
`target_session_attrs` check and the array-type fetch both — so a socket
reconnected empty silently skips it: no array types on that connection, and no
check that the host it landed on is the kind the caller asked for. Handing the
still-queued reserve to `connect()` is also exactly what `reserve()` does on the
open path, so the close path becomes the same path rather than a second one, and
the reserve is still settled out of `queries` by the `onopen` the handshake ends
in.

Nothing in the tests named above tells the two shapes apart — both settle the
reserve — so a release built on 1195's sketch has to be read for whether it kept
the handshake, not assumed to agree with this.

The reporter also notes that issue 751 — a first-ever connect with
`fetch_types: false` never settling its reserve — is likely the same root cause
seen from the other side; the `src/connection.js` hunk is what covers that path,
and `tests/db/reserve-contract.test.ts` exercises it.

#### What it fixes that stock did not

A reserve that is a connection's startup query when that *connect* fails is
rejected by `errored()`, which cannot reach the pool's `queries` and so leaves it
there. Stock got away with that on the close path, because `onclose` had shifted
the reserve out before the failing connect; the `onclose` hunk above deliberately
keeps it in, so on its own it would widen the path rather than leave it alone. A
later `onopen` would then shift a rejected reserve, call `resolve` on it — a
no-op — and return **without moving the connection out of `connecting`**, leaving
the pool a slot down. That connection is alive and idle where nothing looks for
it, and with no `idle_timeout` configured — `src/lib/db/client.ts` passes only
`max` for both pools, so the package's idle timer is a noop pair — the only thing
that ends it is its own `max_lifetime` timer, started when its socket connected
and defaulted by `max_lifetime()` in `src/index.js` to a random 30 to 60 minutes;
every caller in between finds the pool full.

The `reserve()` hunk closes it: the pseudo-query leaves `queries` at the moment it
is rejected, so the connection that opens afterwards finds either the next queued
item or an empty queue, and is placed either way. A connect that reaches
`errored()` is what a restarting server looks like — one that accepts TCP and then
does not answer until `connect_timeout` fires, or one that refuses the connection
outright.

That also settles the refused-connect shape of the same defect, which is
pre-existing rather than introduced here and is filed as Overflow issue 160: a
database restart outlasting one reconnect attempt with a reservation queued left
the coordination pool serving no further reservations for the life of the
process, on `main` as well as on this patch before this hunk.

### Housekeeping

- **Only the ESM build is patched.** All five hunks land in `src/`. The
  package also ships `cjs/src/` and `cf/src/` copies, and both still shift the
  queue in `onclose`, still hand `reserve()`'s pseudo-query a bare `reject`, and
  carry no `peek` in their `queue.js` — the same as on `main`, so this is a
  standing property of the patch rather than something a release regressed. It
  does not bite today: the package's `exports` map sends `import` to `src/`, and
  `next build` bundles that build into every server chunk that reaches the
  `postgres` client, the edge chunk included. Reaching `postgres` through
  `require` (`default` → `cjs/src/index.js`) or under the `workerd` condition
  (`cf/src/index.js`) would silently get the unpatched client, so re-check this
  before moving anything that talks to the database onto either route.
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
  `tests/db/reserve-contract.test.ts`,
  `tests/db/postgres-queue.test.ts` and
  `tests/fold/reconciliation-stranded-reservation.test.ts` between them say
  whether the release really carries both fixes without the regression. A
  release that carries only one of the two defects' fixes keeps the patch,
  minus the hunks it made redundant.
