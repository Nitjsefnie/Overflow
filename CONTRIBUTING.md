# Contributing to Overflow

Overflow is a cooperative ledger for open-source work: a repository sponsor
offers an issue, an outside contributor closes it through GitHub, and Overflow
records a settled credit transfer with auditable proof. `README.md` describes
what the ledger records. This file describes how to change it.

**Overflow is already running at <https://overflow.nitjsefni.eu>, and that
instance is what this repository exists to serve.** If you have not looked at it
yet, sign in there first — the ledger, the settlement proofs and the rules page
are much easier to reason about from the inside than from a description of them.
Using Overflow never requires running your own copy; the setup in this file is a
development environment.

Issues and pull requests are welcome. So is the smaller kind of contribution —
a report that says "the rules page claims X and the fold code does Y, here is
the query" is worth as much as a patch, because everything here is meant to be
reproducible from GitHub's own record.

Two things about this repository are unusual enough to be worth reading before
you start. Its `.gitignore` denies by default, so a new file is invisible to git
until you name it. And its `offered:` and `settled:` labels are not workflow
decoration — they are ledger input, and the ledger reads them from the live
issue. Both have their own sections below.

## Agent-authored contributions are welcome

For scripts and agents registering repositories, see
[Programmatic repository registration](API.md#programmatic-repository-registration)
in `API.md` for token generation, the request contract, and a complete example.

You may use an LLM or a coding agent to write your contribution. There is no
penalty, no separate review queue, and no expectation that you launder its
output through a hand rewrite.

Two conditions, and both are about honesty rather than provenance:

1. **Disclose the model** with a trailer on each commit it authored:

   ```
   Co-Authored-By: <Model Name> <noreply@example.com>
   ```

   The plain model name — a context-window suffix such as `(1M context)` is not
   part of the name and does not belong in the trailer. One trailer per model
   that authored the commit.

2. **Do not submit claims you have not verified.** Paste the command and its
   real output. "Tests pass" without the run is not evidence, and this codebase
   is an easy one to be confidently wrong about: most of the interesting logic
   is a fold over GitHub events where ordering, actor identity and a
   fifteen-minute tolerance decide the outcome, and a plausible reading of the
   code and its actual behaviour part company quietly.

## Getting a development copy running

What follows builds a **development environment for working on Overflow's own
code**. It is not how you use Overflow — that is
<https://overflow.nitjsefni.eu>. A copy you run yourself keeps its own ledger in
its own PostgreSQL database, and nothing in this codebase moves balances,
settlements or calibration between deployments, so a local instance starts empty
and stays private to itself.

Node and pnpm are pinned in `package.json`. `engines` names Node `24.17.0` and
pnpm `10.33.0`, and `packageManager` names `pnpm@10.33.0`, which is what CI
installs through corepack. Use those versions; the lockfile is installed frozen,
so a different pnpm is the first thing that will argue with you.

Copy `.env.example` to `.env` and set or adjust the following variables as
needed. Replace angle-bracket placeholders with local values; optional values
can stay at their defaults or be omitted as noted:

- `DATABASE_URL` — set to a PostgreSQL 17 connection string.
- `AUTH_SECRET` — set to a secret generated with `openssl rand -base64 32`.
- `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` — set to a GitHub OAuth
  application's credentials. Its callback URL is
  `<APP_URL>/api/auth/callback/github`.
- `TOKEN_ENCRYPTION_KEY` — set to 32 random bytes as unpadded base64url with
  `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`.
  This is the AES-256-GCM key for stored OAuth tokens, so it is a real key even
  locally.
- `APP_URL` — set to the public application URL.
- `GITHUB_WEBHOOK_URL` and `GITLAB_WEBHOOK_URL` — set to public HTTPS callback
  URLs their forges must be able to reach. You need the callback URLs to
  exercise webhook registration and delivery end to end; the test suite does
  not.
- `DATABASE_STATEMENT_TIMEOUT_MS` — optional deadline for database statements;
  this variable is not in `.env.example` and can be added to `.env` when you
  want to set it. See the [Environment reference](OPERATING.md#environment-reference)
  for its default and validation behavior.
- `GITHUB_GRAPHQL_BUDGET_RESERVE` — optional GraphQL admission threshold for
  worker passes. `.env.example` includes the default `500`, which can stay as-is
  or be changed or omitted. See the
  [Environment reference](OPERATING.md#environment-reference) for its default
  and behavior.
- `MODERATOR_GITHUB_USER_IDS` — optional comma-separated GitHub account ids
  granted the moderator role at sign-in. `.env.example` shows placeholders to
  replace if you use this setting (`gh api users/<login> --jq .id`).

Placeholders only in anything checked in. Never commit OAuth credentials,
webhook secrets, database passwords or encryption keys.

The database must be **PostgreSQL 17**. Point `DATABASE_URL` at a server you
already run, or start the one `docker-compose.yml` ships:

```bash
docker compose up -d postgres
docker compose ps
```

That service is `postgres:17-alpine` with database, user and password
`overflow` / `overflow` / `overflow_local_only`, published on loopback only,
and a `pg_isready` healthcheck, so `docker compose ps` telling you it is
healthy is the signal to continue. `POSTGRES_HOST_BIND` widens that binding on
purpose, and `POSTGRES_HOST_PORT` overrides the host port (default `5432`, with
the container port remaining `5432`). Compose reads both from your shell or
from the same root `.env` the application uses, so values left in that file
affect every later `docker compose up`. That password is committed and well known, so any
address other than a loopback one publishes a database with known credentials
to everything that can route to this machine. To reach it from elsewhere,
forward the loopback port over SSH — `ssh -L 5432:127.0.0.1:5432 <host>` —
instead of widening the bind address. Then install, migrate and run:

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm dev
```

The development server binds port 3000 by default. To use another port, pass
Next.js's `--port` flag, for example `pnpm dev --port 3130`.
If you override `POSTGRES_HOST_PORT`, set `DATABASE_URL` to use that host port
too. If the dev server uses another port, set `APP_URL` and the GitHub OAuth
callback URL (`<APP_URL>/api/auth/callback/github`) to use it; sign-in and origin
checks depend on those origins agreeing.

`pnpm db:migrate` runs `scripts/migrate.ts`, which applies every
`db/migrations/NNN_*.sql` in sorted order and records each name in a
`schema_migrations` table. It skips what is already recorded, so running it
twice is safe and running it after a `git pull` is the habit to build.

**Each migration gets its own transaction, together with the
`schema_migrations` row that records it.** The two commit together or not at
all, so no migration is ever half-applied or applied without being recorded.
The run is not one transaction: PostgreSQL refuses to read an enum label that
`alter type ... add value` added until the adding transaction has committed, so
a migration can only build on the catalogue an earlier one committed.

**A failed upgrade therefore keeps every migration before the failure.** The
run stops at the migration that raised, and a re-run resumes there rather than
replaying from the start. Fix whatever the failure named and run
`pnpm db:migrate` again — do not restore a backup on the assumption the run
rolled back, and do not expect a half-migrated database to be an error state in
itself. Trip `014`'s opening-authority precondition, for instance, and `013`
stays applied, having already dropped the `users_github_login_key` constraint;
that is the intended resting place until the data the precondition names is
corrected.

## The checks

CI is defined by `.github/workflows/ci.yml`: `verify` runs on pushes to `main`,
pull requests targeting `main`, and manual dispatch, and a separate `calibrate`
job handles eligible `main` pushes and the manual refusal self-test. `verify`
starts PostgreSQL 17, installs the pinned toolchain, applies migrations, and
runs tests, lint, module-size, typecheck, build and page-geometry checks, with
coverage, ratchet, migration-immutability and freshness checks as applicable.
Docs-only changes run the test suite without coverage; other changes also
measure coverage and check the floor. Run this local baseline in the same order:

```bash
pnpm db:migrate
pnpm test --run
pnpm lint
node scripts/check-module-size.ts
pnpm typecheck
pnpm build
node scripts/check-page-geometry.mjs
```

The order is CI's, and it is the useful one: the migration runs first because
the database suites migrate a container of their own and a broken migration
should fail before the whole suite does, and the build runs after the static
checks because it is the slowest and the least likely to tell you something
the other three did not.

The geometry check runs after the build because it measures the build's
output. It needs a Chrome/Chromium binary — `LAYOUT_CHECK_CHROME` overrides
discovery; otherwise `google-chrome-stable`, `google-chrome`, `chromium` or
`chromium-browser` on `PATH` and `/usr/bin` — and, when it spawns its own
server, `DATABASE_URL` from the environment or a repo-root `.env` file.
`--base-url URL` measures an already-running server instead. The signed-in
contracts also read `AUTH_SECRET` — the same secret the target server was
started with, whether this check spawned it or `--base-url` named it — from
the environment or the repo-root `.env` file (the only env file the check
loads, not the wider Next.js family). A run with no signed-in contract never
requires it; the default contracts include signed-in pages. Refusals exit 2;
measured failures exit 1.

On pull requests the job ends with a Base freshness step that certifies the
run when the base is unchanged, or has advanced only disjointly from the
files this pull request changes — an advance that touched none of them
carried its own required checks, so only cross-file interaction goes
unverified. An advance that shares a file with the pull request fails the
step: update the branch onto current `main` so the required checks re-run
across the interaction. The gate also refuses on anything it cannot judge —
a failed or empty API response, or an unrepresentative compare (more than
200 commits, an empty file list, or exactly 300 files, the compare API's
truncation bound).

Use `pnpm test --run` — the same command CI runs — for anything you are going
to report. `--run` is what pins a single non-interactive pass regardless of how
your terminal is attached; `pnpm test:watch` is the watching variant, for use
while you work rather than in a result you paste into a pull request.

**Suites that start a container need a container runtime.** A growing set of
suites starts a real `postgres:17-alpine` through testcontainers — most via
the shared helper `tests/support/postgres-container.ts` — and runs the actual
migrations against it. The set moves as suites adopt the helper, so enumerate
it rather than trusting a list printed here:

```bash
grep -rl testcontainers tests/
```

Without Docker reachable, they fail in `beforeAll` with

```
Error: Could not find a working container runtime strategy
```

and their tests are reported as **skipped** while the run as a whole exits
nonzero. Read that summary carefully: skipped is not passed, and those suites
are precisely the ones that pin the migration path, the materialization
invariants the schema enforces, and the moderation state transitions — the
parts most likely to break and the parts a unit test with a stubbed store
cannot notice. If you changed anything under `db/`, `src/lib/db/`,
`src/lib/fold/` or `src/lib/moderation/` and your run says skipped, you have
not tested it.

A second workflow, `.github/workflows/actionlint.yml`, checks the workflows
themselves: actionlint for schema, expression and shell correctness, and zizmor
for workflow security and supply-chain posture, both over
`.github/workflows/*.yml`. It exists because a broken workflow does not go red,
it silently stops running.

If you edit a workflow, note that `tests/api/ci-workflows.test.ts` asserts its
contents — the triggers, the `permissions` block, the concurrency group, the
PostgreSQL 17 service, forty-character commit pins on every action, the pinned
Node version, and the release commands the job must run. That is deliberate: it
makes a quietly weakened gate fail the suite rather than pass unnoticed. It also
means a workflow change is two edits, and the same is true of `package.json`,
whose pinned versions that test reads.

## Conventions that reject work silently

These three are the reason this file exists. Each of them lets a change look
finished and be wrong, with nothing on screen to say so.

### A new file is invisible until you name it

`.gitignore` denies by default. It starts with `*` and then names back, by hand,
every single file the repository ships. There is no generator: adding a file
means editing that list.

Until you do, the file is untracked and **does not appear in `git status`**.
`git add` on it reports nothing, and the commit lands without it. Nothing fails
on your machine, because the file is right there on your disk — the loss only
exists in everyone else's checkout, which is where it will be found.

Naming a file back takes three lines, not one, because git never descends into a
directory it has already excluded — a `!` rule underneath an un-reopened
directory never matches. Reopen the directory, deny its contents again, then
name the files back with a glob scoped to that directory, which is what stops
the pattern reaching into subdirectories you did not mean:

```gitignore
!src/app/rules/
src/app/rules/*
!src/app/rules/*.tsx
```

For a file at the repository root, one `!` line beside the other root entries at
the top of the file is enough, since the root is not excluded by a parent.

Prove it rather than reading the file and assuming. Both of these, on the new
path:

```bash
git check-ignore -v path/to/new-file.tsx
git status --porcelain
```

`git check-ignore -v` prints the **last** pattern that matched the path, and
that pattern is the whole answer. Before you name a file back you get the
catch-all:

```
.gitignore:1:*	CONTRIBUTING.md
```

and afterwards you get the negation that rescued it:

```
.gitignore:6:!CONTRIBUTING.md	CONTRIBUTING.md
```

Read the pattern, not the exit status: both of those exit zero, because a
pattern matched in both cases. Then confirm with `git status --porcelain` that
the file shows up as untracked. A file still caught by the catch-all is absent
from `git status` altogether, which is exactly what makes this failure quiet.

### A migration has a second edit site

`tests/db/schema.test.ts` asserts the exact list of applied migrations, name by
name, and that each was applied exactly once. The list lives in
`tests/support/applied-migrations.ts`. Adding `db/migrations/NNN_something.sql`
therefore fails that suite until that list names it too. Same commit, both
files.

The assertion is not bureaucracy: `runMigrations` decides what to apply by
reading the directory and diffing against `schema_migrations`, so nothing else
in the codebase records what the schema is supposed to be. That test is the
record.

### Cards need their own padding class

`src/app/globals.css` defines `.surface` alongside `.ledger-card`, `.issue-card`
and `.empty-state`, and all it supplies is a border and a background. It has no
padding. A new panel that reaches for `className="surface"` and nothing else
renders with its text flush against the border — legible enough in a screenshot
to be missed, wrong on every viewport.

Give the panel its own class next to `.surface` and put the spacing there.
`.rules-card` is the pattern to copy: it sets `margin-top`, a fluid
`padding: clamp(...)`, and the measure and rhythm of the headings and paragraphs
inside it.

### Workflow-name scopes require the ci type

A commit subject may use a workflow's name — the top-level `name:` under
`.github/workflows/` — as its scope only with type `ci`.
The gate arms only on `type(scope):`-shaped subjects with a lowercase type and
a whitespace-free scope. Subjects outside that grammar are never rejected by
it; conventional commit subjects are not required. A workflow name containing
spaces, such as `code scanning`, cannot appear as a scope the gate reads.
The top-level `name:` must be a plain scalar; the gate refuses other spellings
rather than guessing. Adding or renaming a workflow requires updating the
real-name pin in `tests/ci/commit-scopes.test.ts` in the same change.
`scripts/commit_scopes.py` enforces the rule in the verify job.

### Module size is ratcheted

`node scripts/check-module-size.ts` enforces per-family line ceilings against
the committed baseline in `scripts/module-size.json`. The measured families,
each capped by the ceilings key of the same name, are:

- `src` — TypeScript under `src/`, 800 lines;
- `tests` — TypeScript under `tests/`, 2500 lines;
- `tooling` — `scripts/*.ts`, `scripts/*.mjs`, `scripts/*.sh`, `scripts/*.py` and the
  repository-root `*.ts` and `*.mjs` config modules, 800 lines;
- `stylesheets` — CSS under `src/`, 800 lines;
- `migrations` — `db/migrations/*.sql`, 400 lines.

Every other tracked file is a recorded exclusion, listed with its reason in
the script itself. A tracked file that is in no family and no exclusion fails
the check as `unclassified`: add it to a family or record it as an exclusion
there. A ceilings key that names no family also fails, and a family with no
ceilings key is a configuration error.

The check fails when a baseline file grows past its recorded count, when an
unlisted file crosses its family's ceiling, when a baseline file is deleted,
when a baseline file shrinks below the ceiling and its entry has not been
dropped, or when a baseline file shrinks below its recorded count while
staying at or over its ceiling and the lower count has not been recorded.
Run `node scripts/check-module-size.ts --tighten` to record shrinkage, in the
same change that made it: it lowers counts and drops graduated, deleted or
unmeasured entries, and it never writes an increase. There are exactly two
remedies for an over-ceiling file: shrink it, or relocate code into a new
module. Recorded counts are never raised by hand. An entry is added only when
a family starts being measured, at the file's current count, and the ratchet
guard (`scripts/check-ratchets.ts`) verifies it against the merge base.

### Coverage is floored

CI measures line coverage over `src/` with
`pnpm test --run --coverage --coverage.include='src/**'`, and
`node scripts/check-coverage-floor.ts` fails when the measurement falls below
the floor recorded in `scripts/coverage.json`. A change that touched only
documentation — the `.md`, `.txt`, `.rst` and `.adoc` extensions, plus
`LICENSE` — skips the measurement entirely, because it cannot move the
number.

The floor was seeded from the tree that introduced it: the first real
measurement, 92.89% lines, with the floor one point below it. From there the
number moves in one direction only. After a `main` push whose measurement
beat the record by more than 0.5 points, CI attempts to record the raise:
the calibrate job rewrites `scripts/coverage.json` and pushes it to `main`.
That push is always refused — a bot commit can never carry the checks main's
branch protection requires — so the calibrate job fails visibly, naming the
measured and recorded floors in its error. The refusal is the alarm, not a
regression: the raise is then recorded by hand. Run the suite with coverage,
run `node scripts/calibrate-coverage.ts`, commit `scripts/coverage.json`,
and open an ordinary pull request; the ratchet guard permits a raise to the
floor and only a raise. A raise that lands without the failed job — an
automatic push through a token that can bypass protection — waits on the
GitHub App route. A drop, or a rise within the hysteresis, changes nothing.
**The floor is never lowered by hand.** A red floor means coverage
regressed, and the remedy is to test the code you changed — not to edit the
record.

## Pull-request admission

Use [the pull-request template](.github/PULL_REQUEST_TEMPLATE.md), keeping its
section names and order and removing its instruction comments. Claim the issue
before submitting, confirm its assignment, and put closing references under
Related Issues and Pull Requests.

Overflow's [caller workflow](.github/workflows/pr-gate.yml) uses the
[shared admission action at the reviewed revision](https://github.com/Nitjsefnie-Actions/pr-gate/tree/679744b0807472d5fd681e42759f081494f2f562).
That SHA-pinned action is the implementation authority; its documentation
describes the admission and recovery rules.

If the gate comments or closes your PR, correct the reported items and edit
that same PR body. Every corrective edit reruns the caller. Once checks pass,
the shared action can reopen a PR it closed itself.

## Issues

The repository ships one issue template,
[`.github/ISSUE_TEMPLATE/bug-report.md`](.github/ISSUE_TEMPLATE/bug-report.md),
and its section order is fixed. The
title lives in GitHub's own title field — one plain-language line, no
ticket-speak and no trailing punctuation, because it gets copied verbatim into a
pull request's Bugs Discovered list and has to stand alone there.

The rule worth internalising is that **Description is observed behaviour only**:
what is actually wrong, not the mechanism and not the fix. If you have proved a
mechanism, it goes under Suggested Fix, clearly marked unverified. This is not
pedantry. A description that is really a hypothesis sends the next reader
straight to the place the hypothesis points at, and when the hypothesis is
wrong — which it often is — the real defect is now harder to find than it was
before the report existed.

Expected Behavior and Discovered During are required too; Discovered During
cites the pull request, task or session that surfaced the issue, and a session
identifier is a fine answer when there is no pull request.

Reproduction Steps is conditional. If the behaviour is not reliably
reproducible, delete that section entirely and say so in the Description,
rather than writing steps that do not actually trigger it — steps that fail for
the reader get the report closed as unreproducible when the defect was real.
Environment / Context and Suggested Fix are optional; keep them only when
version, configuration or data conditions genuinely matter.

### Claim it before you start

The [claim caller](.github/workflows/claim.yml) uses the
[shared claim action at the reviewed revision](https://github.com/Nitjsefnie-Actions/claim/tree/8abff4f2f27d59b984528cb736f64b9391952a25).
That SHA-pinned action is the implementation authority for the claim and release
commands; the caller retains this repository's event, permission, concurrency and
claim policy.

Comment `/claim` on an open, unassigned issue and
[`.github/workflows/claim.yml`](.github/workflows/claim.yml) assigns you. You do
not need write access, which is the entire point: GitHub's built-in slash
commands do not include assignment, so without this workflow the people Overflow
calls outside contributors are exactly the people who cannot perform the action
it prices. The assignment is also what reserves the sponsor's credit — available
headroom is settled balance minus the reserve points of open issues assigned to
outside contributors — so a claim is a ledger event, not a courtesy.

The comment body must be **exactly** the command after trimming whitespace and
carriage returns. "I'll `/claim` this one" is a sentence and is ignored. A bot's
comment starts no run at all; a `/claim` on a pull request or on a closed issue
starts one that declines the command in a reply, because the reply is the only
thing that tells you the workflow saw the command. The workflow also tells you
in a reply when an issue is already held by someone else. Read that reply: it
confirms the assignment, or explains why there was none.

One account may hold a limited number of open issues assigned to you in this
repository at once — two at read tier, four at triage, six at write, ten at
maintain — so an issue you cannot claim is often one you already hold.

`/unclaim` and `/release` are the same command under two names. Either removes
**your own** assignment and nobody else's.

Release an issue you stop working on, and do it before the merge that would
close it, because a stale assignment on a closed issue may no longer be
removable, and "probably still works" is not a reason to find that out after the
merge. A claim does not lapse by itself: after seven idle days another commenter
may take it over and someone with write access may release it, but until one of
those happens the assignment stands and the sponsor's points stay reserved.
Closing the issue is what releases the reserve immediately — only open issues
hold points against the sponsor.

## The `offered:` and `settled:` labels are product data

This is the convention with real consequences outside the repository, so it gets
its own section.

Overflow prices work from labels on the issue. This repository's own catalog is
`offered: trivial` through `offered: deep` for the opening catalog, each
carrying comparison and reserve points from 1 through 10, and `settled: 1`
through `settled: 10` for the actual catalog. `README.md` and the in-product
rules page at `src/app/rules/page.tsx` state the rules the ledger applies; they
are worth reading in full before you touch a label.

The two consequences to hold on to:

- **`offered:` belongs to the repository sponsor, at filing.** Opening difficulty is
  the earliest opening label the sponsor applied *before the first assignment*.
  Work has to be priced before it is spoken for, so a label applied after
  someone has taken the issue cannot set its price — it is not a late correction,
  it is nothing. Labels from anyone else, including the issue's author, do not
  price it at all.
- **`settled:` has a window with two halves.** The label must be applied by the
  repository sponsor between the closing pull request's **final commit** and its
  **merge**, and a nonblank comment from the sponsor must name
  the label. Both halves are the evidence; a label with no comment, or a comment
  that does not name the label, settles nothing. A comment edited after the
  window closes settles nothing either — its current body is not evidence of
  what was written before the close. Exactly one actual-catalog label may be
  active — two settle nothing. Labels on the pull request never price anything.

Those orderings are checked with a **fifteen-minute tolerance**, because they
are a sequence people perform by hand and the order things land in is routinely
off by a little — labelling and assigning in one `gh issue create` invocation
applies the assignee first, for instance. The tolerance absorbs that. It does
not widen the rule: evidence outside it is still rejected. **The settlement
window closes fifteen minutes after merge and cannot be reopened.** A settled
label applied an hour later proves nothing about what the reviewer saw. The
earliest qualifying comment at or after the standing label is used, including
when a label is reapplied; if none exists, a comment up to fifteen minutes
before that label can count. The comment must be created by the window close
and must not be edited after it.

Review rounds are frozen at merge. `credits = max(0, actual points − distinct
review rounds)` counts the changes-requested reviews submitted before merge as
they stood when the pull request merged: dismissing one after the merge does
not remove it, and dismissing one before the merge does. A dismissal exactly at
merge also leaves the round counted; no timing tolerance applies to reviews.
A dismissed review counts only if its dismissal history establishes that it
requested changes; missing history or an unknown previous state does not count.

So: labels are never applied to tidy an issue up, and never adjusted because a
branch turned out harder or easier than expected. Retitling an issue is
housekeeping; relabelling one is editing a ledger. If a price looks wrong, say
so in a comment and leave the label alone.

## Pull requests

The repository ships [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md),
and it is the shape to fill in. Summary, Changes and Testing are required and
stay even when the honest answer is "None". Related Issues and Pull Requests is
conditional but always worth checking — closing keywords go there and nowhere
else. Bugs Discovered is a pointer list only, one line per filed issue with the
title copied verbatim and no commentary. Breaking Changes, Follow-ups / Known
Limitations and Dependencies are optional; delete the heading and its comment
when it does not apply. The Footer is required and names every model that
touched the pull request.

Testing means what you actually ran and what it said. For a change to the fold
or the schema, that includes confirming the container-backed suites ran rather
than skipped.

Small and single-purpose beats large and comprehensive. One logical change per
commit, with a message that says what changed and why the previous behaviour was
wrong. `main` accepts **rebase merges only**, so your commits land on `main`
exactly as you wrote them — the history everyone else reads is the one in your
branch, not a squashed summary of it.

That is also why, if you find a second defect while fixing the first, you should
**file it** rather than fold it in. A commit that fixes two things is a commit
that cannot be reverted for one of them.
