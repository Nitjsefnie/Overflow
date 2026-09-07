# Dependency patches

Applied by `pnpm install` from the `patchedDependencies` entries in
`pnpm-workspace.yaml`. No extra step: CI and `deploy/README.md` both run plain
`pnpm install --frozen-lockfile`.

## `postgres@3.4.9.patch`

Six defects. The first is a shutdown that never settles; the second is a
reconnect loop that retries with no delay at all; the third is a `reserve()`
that never settles; the fourth answers a dead backend's error to the query that
replaces it; the fifth hands queued work to a connection the pool has already
taken back; the sixth lets a shutdown report itself finished while work the
pool accepted is neither run nor refused. The first two share an edit site and
the section below; the rest are unrelated and each has its own.

Sixteen separate edits carry them, and `git` renders those sixteen as twelve
hunks. Two hunks carry three edits each: in the package's `src/index.js`,
`reserve()`'s refusal once the client is ending, `reserve()`'s rejection
wrapper and `release()`'s guard sit close enough together to share one, and in
`closed()` the connect-phase failure, the retry bookkeeping and the settle
share another. The sections below call each edit a hunk, so their counts sum to
sixteen rather than to twelve.

### A connection that loses its backend leaves `sql.end()` waiting

Eight hunks, all in the `postgres` package's own `src/connection.js` — not this
repository's `src/`; `git` renders them as six, because three of them share
one. They settle the three orders in which a connection losing its backend
leaves `sql.end()` waiting on a message that will never arrive, they space the
reconnect attempts the third of those orders used to issue back to back, and
they let a shutdown that arrives between two of those attempts cancel the next
one rather than wait for it. `sql.end()` awaits every connection in the pool,
so a single stranded connection stalls the whole shutdown, and with it
`closeSql()` and everything awaiting it — `scripts/reconcile.ts` awaits it in a
`finally`, so the reconcile script simply never exits.

#### The connection died, then the shutdown was registered

A connection holds the query it is serving in a `query` slot, and only the
`ReadyForQuery` handler clears it. A backend that has gone away never sends
one, so once a connection died mid-query the slot stayed occupied: `end()` saw
a query still in flight, declined to terminate, and handed back a promise
nothing left on that path could resolve.

The first hunk clears the slot in `error()`, immediately after its `errored()`
call. `tests/db/closesql-connection-death.test.ts` holds the behaviour.

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

#### The shutdown was registered, then the connection died

Clearing the slot only settles the order in which `end()` runs after the death.
Called while a query is still on the wire, `end()` cannot take its fast path at
all: it returns `ending = new Promise(r => ended = r)`, and stock `postgres`
invokes `ended` from exactly one place, `terminate()`. Every route to
`terminate()` in `src/connection.js` is either an arm of `ReadyForQuery`, which
a dead backend never sends, or `end()`'s own fast path — and that fast path is
gated on the connection being **idle** rather than on the backend, so it does
run with the socket already nulled. That is the route the first hunk above
relies on. What puts it out of reach here is something else: `end()` opens
`return ending || …`, so once the slow path has assigned `ending` every later
call hands back that same promise, and the fast path is never taken again. The
promise stays pending forever.

`terminate` is also public on the connection object, and the pool has one
escape hatch that reaches it with no backend at all: `sql.end({ timeout })`
races the connections' own shutdown against a timer, and when the timer wins,
`destroy()` calls `c.terminate()` on every connection (`src/index.js`). That is
a deadline rather than a settle — it abandons the connections instead of
waiting for them — and only a caller that passes a timeout gets it.
`closeSql()` calls `end()` with no timeout, so this repository's shutdown path
never arms it. Once the pool has assigned its own `ending`, later `end()` calls
return that promise without arming a timeout. Calls made in the same turn can
still pass the guard before the first call resumes from `await 1` and assigns
`ending`, so a concurrent call with a timeout can still arm the deadline.
Without that additional call, the hunk below settles the shutdown.

The second hunk settles it from `closed()`, adding
`ended && (ended(), ending = ended = null)` after the line that fails the
in-flight query and before `onclose()`.
`tests/db/closesql-shutdown-before-death.test.ts` holds the behaviour.

`closed()` rather than `terminate()` because `closed()` is on the socket's own
event path, where `error()` above it also sits: the two are registered together
as the socket's `error` and `close` handlers. `closed()` is the one of them
that runs however the socket goes away, error or none, and by the time it runs
there is no protocol traffic left to hang on. `terminate()` is on no such path
— nothing in `src/connection.js` calls it when a socket dies.

The position **before** `onclose()` is conservative: settle the old shutdown
before handing the connection back to the pool. `onclose()` moves it to the
closed queue and can immediately start reconnecting it for queued work, so
settling first keeps the settle off a connection that is already being reused.

#### The connection died while it was still opening

Both orders above are settled from `closed()`, below its
`if (initial) return reconnect()` early return — and a connection that dies
while it is still **opening** takes that return, with `initial` still holding
the query that opened it. Nothing below it ran: not the in-flight failure, not
the settle, and not `closedTime`, the retry counter or `delay`.

What that costs depends on how the reconnect attempts end, and one ending is
unbounded:

- An attempt that **completes** with an ordinary initial query executes that
  query and clears `initial`; the query's `ReadyForQuery` reaches the
  `ending ? terminate()` arm once no query remains in flight. A reservation
  is not executed as a query: with array-type fetching off, the startup arm
  clears `initial` and terminates an already-ending connection directly.
  With array-type fetching on, it clears the reservation from `initial`
  before fetching types, whose `ReadyForQuery` reaches the ending arm.
- An attempt that raises an error reaching `errored()` — a refused connect, a
  `CONNECT_TIMEOUT`, a startup `ErrorResponse` — nulls `initial`, so the
  **next** `closed()` falls past the early return and is settled by the hunk
  above.
- An attempt that ends in a plain socket close, with no `error` event and no
  protocol message, does neither, and nothing else ever will. That is what a
  pooler, a TCP load balancer, a Kubernetes service or any non-postgres service
  on the port produces while the backend is gone. Against such a peer the
  pending `end()` was never settled at all: measured still pending at 90
  seconds, having made 32,605 reconnect attempts in that time. Overflow issue
  164.

The third hunk fails the startup query where a shutdown is already pending,
above the early return, with the same `CONNECTION_CLOSED` the established path
uses. `error()` clears `initial` on its way through `errored()`, so the close
then continues into the same tail as a death after the handshake — settle,
then hand the connection back — rather than taking the return at all. Where no
shutdown is pending the return survives, so a client whose database is merely
down keeps trying.

The startup query is **failed rather than replayed** on a retry, even when the
server is reachable again by the time a retry would run. That is the contract
the established path already has: `postgres` never re-runs a query whose socket
died, at any phase, and a retry issued while ending is exactly the reconnect
that keeps a shutting-down process from exiting.
`tests/db/connect-phase-death.test.ts` holds all of it, driving the library
client through a local TCP proxy rather than through `closeSql()`.

#### The reconnect attempts were issued with no delay at all

`reconnect()` schedules the next attempt at
`closedTime ? Math.max(0, closedTime + delay - performance.now()) : 0`, and
`closedTime`, `options.shared.retries++` and `delay` are all assigned below the
same early return. A connect-phase death therefore left `closedTime` at its
initial zero, the ternary took its zero branch, and every attempt went out back
to back — the 32,605 above, in ninety seconds. The retry counter never advanced
either, so a configured `backoff` was asked for the delay of attempt zero
forever and could never grow one. (A connection that has lived before carries a
previous `closedTime`, and reconnects then use the remaining backoff computed
from that value, which is why the storm needs a connection dying in its *first*
connect phase.)

The fourth hunk records all three before returning, so attempts are scheduled
rather than issued and the counter advances: `backoff` is asked for attempt 1,
then 2, and so on. It advances unconditionally rather than on `hadError`,
because the close this arm exists for is a clean FIN, where `hadError` is false
and stock's form would never advance at all. On the one route where a socket
error can still reach the arm with `initial` set — the multi-host fallback the
caveat below describes, where `error()` returns before `errored()` — the two
forms agree, as they do wherever `hadError` is true.

**That counter is pool-wide, and this hunk makes it move more often.**
`options.shared` is one object per client, so `options.shared.retries` is
advanced by *any* connection's close and read by *every* connection's next
`backoff()` — the spacing one connection earns is the spacing they all get. The
sharing is stock's own arrangement, not something introduced here: stock already
advances the same counter on an errored close from any connection. What changes
is what advances it, since a connect-phase close is a clean FIN and stock's
`hadError` form ignored it. The consequence scales with `max`: a pool of ten
whose connections all fail to open climbs the curve ten times faster than a
single connection would, and with the package's default `backoff` —
`(0.5 + random / 2) · min(3 ** retries / 100, 20)` seconds — that reaches the
10-to-20-second cap inside the first round of ten, so every connection then
waits out a cap it did not individually earn. Deliberate: the peer this hunk
exists for is a database that is trying to come back, and trading a slower
notice of its return for far less load on it is the trade the storm asks for. A
client that wants a different curve passes its own `backoff`, and a single
completed startup resets the counter to zero, so one connection getting through
re-arms the whole pool.

#### The shutdown that arrives between two attempts

Spacing those attempts lengthened a wait the settle above then had to sit
through. With the next attempt scheduled rather than immediate, an `end()`
arriving *between* attempts settled only once that attempt had been made and
closed — up to the backoff cap, measured at 12.6 to 15.9 seconds at this
repository's pool size where the same shape took roughly 19 milliseconds
before. The two halves are one edit site, so the fix for one has to carry the
other.

Four hunks make the scheduled attempt cancellable: `reconnect()` hands its
timer back, the connect-phase arm keeps the handle, `connect()` spends it, and
`end()` clears it when nothing else is in flight — which turns *waiting to
retry* into the same nothing-in-flight case `end()`'s fast path already
terminates at once, with the same rejection for the startup query it strands.
The handle is armed only by a close, never by a first connect, so a query the
pool has just dispatched is untouched and still runs; recognising the state by
the absence of a socket instead would reject that one too.
`tests/db/connect-phase-death.test.ts` holds the cancel, the boundary, and a
live handshake left to its own `connect_timeout` rather than terminated.

#### Where this diverges from upstream

Upstream tracks the first order as `porsager/postgres` issue 1097, and open
pull request 1142 proposes a fix. **Ours is deliberately not the same change.**
It makes two edits to `src/connection.js`. It clears the slot inside
`errored()` — the placement described above, so it carries the
silent-wrong-answer defect — and it splits `closed()`'s in-flight failure in
two, giving the `hadError` close its own branch that rejects `query` and drains
`sent` inline, clearing `query` there as well, and leaving the existing
`error()` call to the errorless close. It is also unmerged and unreleased. Do
not resync this patch with it.

Neither edit settles a pending `end()`, so upstream has nothing at all for the
second order: issue 1097 describes only the death-then-`end()` interleaving,
and pull request 1142 leaves `end()`, `terminate()` and `ending` alone. On the
description above it has nothing for the third order or for the spacing either:
its `closed()` edit is the in-flight failure, which sits below the connect-phase
early return, and nothing in either edit moves that return or the bookkeeping
under it. When a release does land, judge it against the tests named here rather
than against the pull request.

#### What it still does not cover

- **The cancel reaches only a retry a *close* scheduled.** The pool's own
  `connection.connect(query)` calls `reconnect()` and discards the handle it
  returns, so a shutdown arriving inside *that* scheduled window still waits it
  out — measured at 43 milliseconds on `main` against 17,099 milliseconds here,
  because the spacing above lengthens a window that already existed. Widening
  the cancel to cover it would reject a query the pool has just dispatched,
  which every build serves today, so it is left alone deliberately. Overflow
  issue 224.
- **Two `reserve()` orderings leave `sql.end()` itself pending**: a `reserve()`
  issued in the same turn as `end()`, which wins the race to `end()`'s own
  `await 1`, and a reservation held across `end()` and released afterwards,
  whose `release()` calls `onopen()` and so bypasses the
  `ending ? terminate()` arm. Both reproduce identically on `main`: they are
  stock, not something this patch introduced or failed to remove. Overflow
  issue 226.

#### Caveat if you reuse this patch elsewhere

`error()` returns early when
`connection.queue === queues.connecting && options.host[retries + 1]` — the
multi-host fallback, at `src/connection.js` lines 382-383. It is the one route
into `error()` that skips the clear, and `errored()` does not run on it either.
The connection is still connecting there, so the pending work is `initial`
rather than `query` — `connect()` assigns it at line 114, and `query` is taken
only inside the types fetch — and a slot of either kind is enough to send
`end()` down its slow path, so the hang survives. Unreachable here: this
repository's `DATABASE_URL` names a single host. The route stays **unfiled**,
and no test in this repository exercises it.

One thing about it has since been run rather than read. With a comma-separated
host list and a shutdown already pending, the route settles in 2 to 3
milliseconds, in both orderings, two runs each — which is what the connect-phase
hunk above predicts, because `ending` is assigned only by `end()`, and `end()`
moves the connection out of `queues.connecting` before assigning it, so the
early return cannot be taken with a shutdown pending. That measurement
establishes only that the *covered* case is covered. The uncovered one — a
multi-host connect-phase death with **no** shutdown pending, where `initial`
survives a socket error and `closed(true)` reaches the retry arm with `hadError`
set — is still read off the package's source rather than run, so treat it
differently from the claims in this file that a probe and a test stand behind.

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

#### Why nothing is sent upstream

Every `porsager/postgres` reference in this file — issues 1195, 751 and 1097, and
pull request 1142 — is cited so that a future release can be judged against it.
None of them is a promise that this repair will be submitted: the maintainer has
decided not to submit it, and this patch is carried indefinitely by that choice
rather than by an unfinished errand.

The project is active — 54 open pull requests, the oldest opened in 2022, 241
open issues, and a pull request merged as recently as 2026-09-02 — but it passes
over this class of fix. Issue 1097 has been open since 2025-07-31, and pull
request 1142, which fixes it, has sat unmerged since 2026-01-05 while other pull
requests merged around it. Issue 751 has been open since 2023-12-05. So judge a
release by the tests named in each section above, and do not wait on either
tracker.

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

### A dead backend's error is answered to the query that replaces it

One hunk, in the package's own `src/connection.js`.

`ErrorResponse` does not reject the query it arrives for. While a query is in
flight it only *stores* the error in `errorResponse`, because a postgres error
is not final until the `ReadyForQuery` that ends the query decides what to do
with it — a prepared statement whose plan has gone stale is retried there rather
than failed. A backend that dies mid-query sends its `FATAL` and then goes away
without ever sending that `ReadyForQuery`, so the stored error is neither read
nor cleared.

`closed()` resets the rest of the per-socket parse state — `incoming`,
`remaining`, `incomings` — and leaves that one set, and the connection is
reused. The pool's `onclose` hands it the oldest queued query as its `initial`
and reconnects it, so the handshake's own `ReadyForQuery` is the first to arrive
on the *new* socket. With no query in flight it takes that function's other arm,
`else if (errorResponse)`, and fails `initial` through `errored()`. The pool's
oldest queued work is then refused with the error of a backend it never reached,
by a connection that is up and answering. Overflow's shape of it is `57P01`,
`terminating connection due to administrator command`, returned to a caller
whose query was merely queued at the moment somebody else's connection died.

The hunk resets `errorResponse` at the top of `closed()`, beside the parse state
the function already clears. **Not** lower down beside this patch's other
`closed()` line: `closed()` returns early for a connection still in its connect
phase (`if (initial) return reconnect()`), and that connection is reused by the
very same route, so a reset below the early return would miss it. A connect-phase
close really can carry a stored error, because the connect phase runs real
queries of its own: `fetchArrayTypes()` and `fetchState()` both go out while
`initial` is still set, so an `ErrorResponse` arriving for either is stored
rather than failed, exactly as it is for a caller's query. Not in
`ReadyForQuery` either — clearing it there is what already happens, and it is
the *read* that is too late rather than the write.

`tests/db/reserve-contract.test.ts` holds it, with a query queued behind a
reserved connection whose backend is terminated while that reservation has a
query of its own in flight. The in-flight query is the point: it is what makes
`ErrorResponse` store rather than fail. Terminate an *idle* reserved connection
and nothing is stored — `ErrorResponse` takes its no-query arm and calls
`errored()` immediately — which is why the neighbouring case that queues work
behind an idle reserved connection passes without this hunk and says nothing
about it.

The **placement** is held by a second case in the same file, *clears a
connect-phase error before the socket that replaces it reports ready*. A proxy
in front of the backend answers the array-type fetch with a `FATAL` and closes
the socket with a FIN — a reset would reach the client as an `error` event and
fail `initial` on the way past, which is a different path — so the close arrives
with the error stored and `initial` still set, and takes the early return. The
caller's query must still be served by the socket that replaces it. Relocating
the reset to immediately below the early return fails that case alone, with the
caller refused `57P01`, and leaves the other nine in the file green: deleting
the line is not the mutation that asks this question, and before that case
existed nothing here would have noticed a later regeneration moving it.

#### What it does not cover

Only `errorResponse`. The stored error is one of several pieces of state that
`closed()` leaves behind, and the reset says nothing about the others.

### Releasing a reservation the pool has already taken back

One hunk, in the package's own `src/index.js`.

`release()` hands a reserved connection back to the pool: it nulls
`c.reserved` and calls the pool's `onopen()`, which dispatches queued work onto
that connection. It does so unconditionally, and the pool takes reservations
back on its own as well — its `onclose()` nulls `c.reserved` when the backend
goes away, then moves the connection to `connecting` and schedules a reconnect.
Between that and the reconnect there is no socket, and a `release()` landing in
that window dispatches queued work onto a connection that has none.

Both of what happens next are wrong, and which one a run gets is a race:

- `execute()` buffers the bytes and arms `setImmediate(nextWrite)`, whose first
  line is `socket.write(chunk, fn)`. With `socket` null that throws
  `TypeError: Cannot read properties of null (reading 'write')` out of a timer
  callback, where no caller can catch it, and node exits 1. This is the shape
  Overflow issue 161 was filed for.
- Where the flush is *not* armed, the query simply sits in the connection's
  query slot unsent, and the first `ReadyForQuery` on the replacement socket —
  the handshake's — resolves it with the empty result set collected so far. The
  caller is told its query returned no rows.

Overflow reaches this on every reconciliation: `withRepositoryReconciliation`
releases its coordination connection in a `finally`, and that connection's
backend dying mid-reconciliation is a case the coordination code otherwise
handles.

The hunk gives `release()` the connection's current reservation to compare
against and makes it inert unless it still holds it.

#### Why not at the write, which is where it throws

A null check in `nextWrite` is the obvious repair and it is not enough. It stops
the throw and leaves the pool wedged, and the order is what does it. The flush
that throws here is armed **after** `closed()` has already run: the dispatch
`release()` causes is what calls `write()`, which buffers the query's bytes into
`chunk` and, finding `nextWriteTimer` null, sets it. `closed()`'s own
`clearImmediate(nextWriteTimer)` ran before any of that and is a no-op on this
path — it clears a flush still pending at the close, which is a real shape but a
different one. What survives is then whatever `nextWrite` leaves: it throws on
its own first line, before reaching the `chunk = nextWriteTimer = null` at its
end, so a null check that returns there leaves both the buffered bytes and the
non-null handle set with the socket gone. `write()` arms a flush only while that
handle is null, so nothing is ever scheduled again: the reconnect's
`StartupMessage` is appended behind the dead query's bytes and never sent, the
server answers a connection that never introduced itself, and `connect_timeout`
refuses everything queued on the pool while the database is reachable
throughout. That refusal is the issue's second reported symptom and it is this
same defect, not a separate one.

Guarding `release()` keeps the dispatch from happening at all, which is what
leaves the reconnect free to introduce itself normally.

#### Why identity and not truthiness

`c.reserved` is not a flag that only this reservation writes. A later
`reserve()` sets it to *its* own function, and so does `begin()` for a
transaction. A spent `release()` that merely checked `c.reserved` for
truthiness would see one of those, null it, and hand the connection to the pool
while its new holder still believes the connection is exclusively theirs — one
backend, two callers, and the newer one's queued work never drained. Comparing
against the reservation this `sql` was built for is what distinguishes *still
mine* from *reserved again by someone else*, and it is also what makes a second
`release()` inert: the first one nulls `c.reserved`, and null is not the
captured reservation either.

`tests/db/reserve-contract.test.ts` holds both halves. The crash case enters the
window by ordering rather than by racing for it: the pool's `onclose` calls the
`onclose` *option* before it schedules the reconnect, and resuming from a
promise resolved there is a microtask of that same turn, so no timer can have
run in between. It asserts on what the code did — the queued queries' answers,
and an `uncaught` list the case fills from an `uncaughtException` listener it
installs and removes, because an exception thrown from a timer reaches no
`await`. The second case releases a spent reservation after the pool has served
a new one from the same connection, and requires that a third reservation still
has nothing to be served with.

#### What it does not cover

A `release()` that arrives while the connection is still the caller's is
unchanged, including one that arrives after the caller's own queries have
failed: the reservation is still held, so the connection is still handed back.
Nor does the guard settle anything the reservation was holding. A reservation
has a queue of its own that `handler` fills while the connection is `full`, and
`c.reserved` is the only thing that drains it, so ending a reservation with
items still in it looks from the source like it leaves them unsettled — as true
of an ordinary `release()` on a healthy connection as of a spent one here.
Read off the package's source rather than run: nothing in this repository has
reproduced it and no issue tracks it, so treat it differently from the claims
above that a test stands behind.

### A shutdown reports itself finished with work the pool accepted still in hand

Two hunks in the package's own `src/index.js`; `git` renders the second as part
of the hunk the `reserve()` and `release()` edits above already share.

`handler()` queues a query whenever every connection is busy, and `end()`
settles connections rather than that queue. What stock then does with the
backlog depends on something the caller cannot see, and neither outcome is the
shutdown being over. A connection that finishes its work during the shutdown
takes `ending ? terminate()`, and `terminate()` nulls its `ending` — so the
socket close behind it reaches `onclose` with the backlog still in the queue and
**resurrects that connection to serve it**, after `sql.end()` has already
resolved. Where the server is unreachable instead, the resurrected connection
never completes and the same work is never settled at all: at this repository's
pool size, five queries of fifteen were left pending permanently.

The first hunk drains the queue in `end()`, with the `CONNECTION_DESTROYED` that
`destroy()` — the path `sql.end({ timeout })` reaches when its timer wins —
already uses on the same queue, so the two shutdown paths agree. It runs
**before** the connections are told to end. Nothing can serve the backlog after
that point: no connection takes queued work while it is ending, because
`ReadyForQuery` ends in `ending ? terminate() : onopen(connection)`, and
`handler()` refuses everything new the moment the pool's `ending` is assigned,
which happens in the same turn with no I/O in between. Draining first rather
than last is what keeps the disposal off the liveness of the very promise this
section is about — a connection whose own `end()` never settles would otherwise
take the backlog with it — and it empties the queue before any `onclose` can
read it. Each entry is shifted out before it is rejected, exactly as `destroy()`
does it: a queued reserve's own rejection removes it from this queue, and an
entry already shifted out is the only kind that removal is inert on. Rejecting
without shifting is not merely untidy — the loop reads its head each pass, so an
entry that does not remove itself is read forever, and the drain becomes a
synchronous spin that takes the event loop with it.

That shape **is** detected, and the signal is the worst kind: not an assertion,
and not even a per-test timeout, because the timers a timeout needs are on the
event loop the spin has taken. What a reader sees is a run that never finishes —
locally a suite that has to be interrupted, in CI the workflow's own 45-minute
job limit. So this is a detection with an unnamed signal rather than a gap in
coverage, and the difference matters if anyone improves it: making the loop
terminate by construction — shifting every entry into a local array first, then
rejecting from that — would retire the question instead of renaming the failure.
It is left as it is here because it matches `destroy()` line for line, and
agreeing with the path this hunk exists to agree with is worth more than the
signal.

The second hunk gives `reserve()` the `ending` check `handler()` already has. A
reservation requested after the shutdown was pushed into the same queue without
consulting that flag, and `end()` drains once and before the flag is set, so
nothing would drain it either: against an unreachable server that left a promise
nothing settles, and against a reachable one the pool opened a fresh socket for
it after the shutdown had resolved. It now answers with the same
`CONNECTION_ENDED` an ordinary query in that position already gets.

`tests/db/shutdown-backlog-drain.test.ts` holds all of it: queued queries and a
queued `reserve()` settled by an ordinary shutdown, the drain running before a
connection that cannot finish ending, and a reservation requested afterwards
refused beside a query that already was.

This is Overflow issue 223. The visible change is that a shutdown of a perfectly
healthy client now rejects queued work it used to run behind the caller's back —
which is the point: a caller can tell "your query ran" from "your query never
will", and got neither answer from a promise settled by whether a resurrected
connection happened to reach the server.

#### What it does not cover

The resurrection itself is not guarded, only made unreachable. `onclose` still
hands a connection the head of `queries` and starts a fresh connect with the
connection's `ending` cleared; what stops it is that the queue is empty by then,
not a check. A future edit that queues work after `end()` has drained would
bring it back, and the only route that still can is `reserve()`, which the hunk
above closes.

### Housekeeping

- **Only the ESM build is patched.** All twelve hunks land in `src/`. The package
  also ships `cjs/src/` and `cf/src/` copies, and both still leave the dead
  query in the slot in `error()`, leave `closed()` without the settle and with
  the stale `errorResponse`, still take the connect-phase early return above
  both of those and above the retry bookkeeping, still discard the reconnect
  timer so no shutdown can cancel it, still drop a reserve that reaches the
  startup handler with array-type fetching off, still shift the queue in
  `onclose`, still hand `reserve()`'s pseudo-query a bare `reject`, still let a
  spent `release()` hand a connection back to the pool, still leave `end()`'s
  backlog neither run nor refused, still let `reserve()` queue into an ending
  pool, and carry no `peek` in their
  `queue.js` — the same as on `main`, so this is a standing property of the
  patch rather than something a release regressed. It does not bite today: the package's
  `exports` map sends `import` to `src/`, and `next build` bundles that build
  into every server chunk that reaches the `postgres` client, the edge chunk
  included. Reaching `postgres` through `require` (`default` →
  `cjs/src/index.js`) or under the `workerd` condition (`cf/src/index.js`)
  would silently get the unpatched client, so re-check this before moving
  anything that talks to the database onto either route.
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
  `tests/db/closesql-shutdown-before-death.test.ts`,
  `tests/db/connect-phase-death.test.ts`,
  `tests/db/shutdown-backlog-drain.test.ts`,
  `tests/db/pipelined-query-after-build-failure.test.ts`,
  `tests/db/reserve-contract.test.ts`,
  `tests/db/postgres-queue.test.ts` and
  `tests/fold/reconciliation-stranded-reservation.test.ts` between them say
  whether the release really carries every fix without the regression. All of
  them: the first three name one interleaving each, and a release that settles
  one and not the others passes a check that names only its own and reinstates
  the hang unnoticed. A release that carries only some of the fixes keeps the
  patch, minus the hunks it made redundant.
