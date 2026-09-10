# Overflow forge-evidence contract — GitLab as a settlement source (issue 296, step 1)

Status: draft for sign-off · step 1 of issue 296 · 2026-09-10
Provenance: two inputs, both verbatim-preserved. Code side: an enumeration of every
evidence item the settlement/fold pipeline consumes, frozen at tree `c65fa7ec809c` —
30 items across five groups, with `file:line` citations. Forge side: a live probe of
the GitLab REST API v4 (~60 unauthenticated requests against `gitlab.com`, 2026-09-10,
zero 429s), grading every capability LIVE-VERIFIED, DOC-VERIFIED (doc file fetched live
from `gitlab-org/gitlab@master` via the repository-files API, because the docs site
serves a challenge to plain HTTP clients), PARTIAL, NOT SUPPLIED, or UNVERIFIED.

Every capability claim in this document matches that probe. Nothing here upgrades a
DOC verdict to LIVE, and nothing asserts what the probe marks UNVERIFIED.

---

## 1. Purpose and scope

Step 1 of issue 296 ONLY. This document enumerates what the settlement ledger
requires as evidence and states, item by item, whether GitLab can supply it. It is
the input a human signs off before any later step designs against it.

**Explicitly out of scope** (later steps, or never):

- any migration or schema change;
- any change to `users`, `registered_repositories`, or `settlements`;
- any second forge gateway implementation;
- any code change at all.

**Settled shape, stated as a premise and not re-opened:** GitHub stays the sole
sign-in and the account key. Additional identities are *linked* identities. The
identity key is the exact triple `(provider, instance_url, forge_user_id)`. Login is
never a key, because logins are renameable (issue 91 exists because a stale login
mispriced reservations) and login uniqueness is per-instance only.

## 2. The evidence contract

Thirty items, grouped as the pipeline consumes them. Columns: what the ledger
needs; the GitHub supplier in the current tree; the GitLab supplier; the verdict
exactly as the probe grades it; and the access requirement where the probe found
one.

**Verdict legend**

| Verdict | Meaning |
|---|---|
| LIVE-VERIFIED | Exercised live against `gitlab.com` during the probe, response preserved. |
| DOC-VERIFIED | Shape from the GitLab doc file fetched live from the source repo; not exercised live. |
| PARTIAL | Supplied, but with a named deficiency the later steps must design around. |
| NOT SUPPLIED | GitLab supplies nothing for this item. Where none is required, that is stated — a successful outcome, not a failure. |
| UNVERIFIED | Existence or shape could not be established by the probe; do not design on either assumption. |

### 2a. Crediting — evidence that credits a settlement

| # | Ledger needs | GitHub supplier today | GitLab supplier | Verdict | Access |
|---|---|---|---|---|---|
| 1 | PR author actor identity: login + numeric account id (null for Bot/Mannequin/Organization) | `src/lib/github/client.ts:963,981,1059` (query), `:1258-1259,1295-1298` (`accountGitHubUserId`) → `pull_requests.author_github_login` (003:43), `author_github_user_id` (013:46-51) | MR object `author {id, username}` embedded on every MR (live: `GET /projects/:id/merge_requests/:iid`) | LIVE-VERIFIED — id + username always emitted together | Public |
| 2 | Local account binding keyed by the same numeric id (`users` row) | `src/lib/fold/postgres-store.ts:828-853`, `src/lib/fold/repository-fold.ts:351,480-482` → `users.github_user_id` unique (001:15-16) | Numeric user ids are the stable key: embedded on actor objects; `GET /users?username=` resolves login→id publicly; `GET /users/:id` is sign-in-required (403 unauthenticated, documented) | LIVE-VERIFIED (forge half: id↔username identity) | Public for login→id; id→username lookup needs sign-in |
| 3 | Sponsor (debtor) identity of the repository | `src/lib/fold/postgres-store.ts:578-611`, `src/lib/fold/repository-fold.ts:354` → `registered_repositories.sponsor_id` (001:30) | Project identity: `GET /projects/:id` by numeric id returns `path_with_namespace`, visibility, timestamps | LIVE-VERIFIED | Public |
| 4 | PR-in-registered-repository ownership decision, keyed on numeric repo id | `src/lib/fold/repository-ownership.ts:62-66`, `src/lib/fold/repository-fold.ts:770` | Numeric project id is the instance-wide key, stable across path renames; path and numeric id both resolve | LIVE-VERIFIED | Public |
| 5 | Participation eligibility of creditor and debtor at merge time (moderation replay) | `src/lib/fold/repository-fold.ts:506-512,1407-1421`; SQL twin `db/migrations/007:109-151` used by `claimGitHubIdentity` (`postgres-store.ts:1480,1518-1519`) | Provider-neutral fold logic; GitLab inputs are the per-item actor id + timestamp evidence (items 1, 11, 13) | LIVE-VERIFIED (inputs) — the replay logic itself is forge-neutral fold code | Public |
| 6 | Evidence that author == sponsor (self-work split) | `src/lib/fold/repository-fold.ts:514-532,1234` → `self_work_calibrations` (001:123) | Numeric user ids comparable across MR author and project sponsor records | LIVE-VERIFIED | Public |
| 7 | Retroactive identity claim: an account signing in claims past work | `src/lib/fold/postgres-store.ts:1454-1522` (`claimGitHubIdentity`), invoked from `src/auth.ts:119`; pinned by `tests/db/schema.test.ts:1349-1417` | The link credential itself: `GET /user` with the PAT returns the token owner's id + username | DOC-VERIFIED — the one call a probe without a token cannot exercise | PAT |

### 2b. Pricing — evidence that prices a settlement

| # | Ledger needs | GitHub supplier today | GitLab supplier | Verdict | Access |
|---|---|---|---|---|---|
| 8 | Difficulty catalog (opening + settled schemes, version history) | `src/lib/fold/repository-fold.ts:373-377,399-410` → `registered_repositories.difficulty_scheme` (002:148-156), `repository_difficulty_scheme_versions` (030:8-14) | None required — the catalog is forge-neutral and lives in the ledger | NOT SUPPLIED (none required) | — |
| 9 | Opening label: a LABELED history event in the opening catalog, applied in the opening window by the sponsor | `src/lib/fold/repository-fold.ts:565-636` → `issues.opening_*` columns (007:1-13), immutability trigger 007/018/031 | `GET .../resource_label_events` (action `add`/`remove`, `user {id, username}`, `created_at`; tier Free+) | DOC-VERIFIED (shape) — auth live-verified as required on gitlab.com | read_api PAT |
| 10 | Opening-window bound: first ASSIGNED event | `src/lib/fold/repository-fold.ts:588-591`; `AssignedEvent` timeline item (`client.ts:950,1320-1332`) | Not in the probe's typed-endpoint inventory (resource event endpoints documented for labels, state, milestone, weight — not assignment). Any webhook or system-note carry is unverified. | NOT SUPPLIED (typed endpoint); any other carry UNVERIFIED | — |
| 11 | Settled label: exactly one actual-catalog LABELED standing at merge+15min, applied by the sponsor in `[finalCommit−15min, merge+15min]` | `src/lib/fold/repository-fold.ts:813-935` → `issues.settled_*` columns (007:6-10; CHECKs 007, 031; tolerance 010) | Same `resource_label_events` add/remove stream replayed standing-at-merge | DOC-VERIFIED (shape) — auth required on gitlab.com | read_api PAT |
| 12 | Rationale comment: nonblank sponsor comment in the label window, not edited after window close, tie-ordered by monotonic per-comment creation sequence | `src/lib/fold/repository-fold.ts:962-1018,1363-1405` (`compareRationaleSequence` on `IssueComment.databaseId`) → `issues.settled_rationale_*` (007:11-13) | `GET .../notes` (body, `author {id, username}`, `system` flag, `created_at`/`updated_at`) | PARTIAL — comment evidence supplied (DOC shape, PAT-gated), but monotonic note-id creation-order semantics are UNVERIFIED; the tie-break may need to fall back to `created_at` | read_api PAT |
| 13 | Sponsor attribution predicate: numeric actor id wins, login only when no id reported | `src/lib/fold/repository-fold.ts:1228-1234` | Numeric ids embedded on every actor object | LIVE-VERIFIED — with the bot-attribution semantics caveat (gap 9) | Public |
| 14 | Merged closing PR selection: MERGED, valid timestamps, `finalCommitAt <= mergedAt`, 40-hex `mergeCommitOid`, earliest merge wins | `src/lib/fold/repository-fold.ts:750-776` (oid regex `:761`) → `pull_requests` merge columns (007:95-107) | MR object: `state=merged`, `merged_at`, `merge_commit_sha` | LIVE-VERIFIED — 40-hex check excludes SHA-256 repositories (gap 2) | Public |
| 15 | Closing-issues linkage (PR ↔ issues) | `src/lib/github/client.ts:193-210` (`closingIssuesReferences`), used `src/lib/fold/reconcile.ts:282-289` → `pull_request_issues` (003:46-57) | `GET /projects/:id/issues/:iid/closed_by` and `GET /projects/:id/merge_requests/:iid/closes_issues` — both directions, live-verified, empty-array-is-evidence | LIVE-VERIFIED | Public |
| 16 | Issue state (CLOSED) and `stateReason` | `src/lib/fold/repository-fold.ts:389-391,451-478` (`NOT_PLANNED` gate `:469`) | Issue `state` (opened/closed) live-verified; there is NO state-reason equivalent | PARTIAL — state supplied; state-reason NOT SUPPLIED (gap 1) | Public |
| 17 | Review rounds (deduction) — definition in section 4 | `src/lib/fold/repository-fold.ts:483,1073-1103`, `src/lib/domain/settlement.ts:41,58-60` → `settlements.review_rounds` (001:102), `review_rounds` rows (001:85-92) | Approvals read live (`approved_by` + `approved_at`, Free and Ultimate); retraction observable only via webhook or system notes — no append-only REST approval-event endpoint; `approved_by` is a mutable snapshot | PARTIAL — approvals state public; the retraction event stream is webhook-or-notes only; `review_rounds.github_review_id` cannot be populated | Public (approvals); webhook secret + maintainer setup, or read_api PAT (system notes), for retraction |
| 18 | Raw unified diff of the merged PR, hashed as settlement proof | `src/lib/github/client.ts:358-367` (REST diff media type), hash at `repository-fold.ts:484,1190-1192` → `proof_sha256` (001:104, 003:44) | Diff endpoint not probed; `diff_refs` present on the MR object. Diff representation differs between forges regardless. | UNVERIFIED — and proof hashes are never comparable cross-forge (gap 12) | — |
| 19 | Issue raw view ordering (webhook vs fold clocks) | `src/lib/fold/postgres-store.ts:1532` (`acceptsRawView`) → `issues.github_updated_at` (027:25) | Issue `updated_at` live-verified on issue objects | LIVE-VERIFIED | Public |
| 20 | Claim assignee: exactly-one-assignee login + numeric id, reserved ambiguity sentinel | `src/lib/github/client.ts:986-988,1219-1241`; sentinel `src/lib/github/types.ts:12` | Assignee fields on MR/issue objects were not probed; id+username embedding is general (item 1) | UNVERIFIED (assignee fields); sentinel collision hazard applies regardless (gap 4) | — |

### 2c. Recomputation — immutability + replay anchors

| # | Ledger needs | GitHub supplier today | GitLab supplier | Verdict | Access |
|---|---|---|---|---|---|
| 21 | Whole upstream evidence re-fetched per run, cached between runs | `src/lib/fold/reconcile.ts:218-333`; cache store `postgres-store.ts:1087-1106` → jsonb blobs (026:1-9) | None required beyond the per-item endpoints; deep collections must paginate (gap 6) | NOT SUPPLIED (none required) | — |
| 22 | Issue identity cross-check on dirty-subject hydration | `src/lib/github/client.ts:176-191` | Issue-by-iid resolution live-verified (unauthenticated) | LIVE-VERIFIED | Public |
| 23 | Immutable opening proof re-derivation check | `src/lib/fold/postgres-store.ts:1595-1603` | `resource_label_events` rows carry stable event `id`s usable as anchors | DOC-VERIFIED — anchor is a different id kind than GitHub's opaque timeline node ids; the drift-refusal check ports | read_api PAT |
| 24 | Derived-row revision stamp forcing recomputation | `src/lib/fold/fold-revision.ts:8` (`FOLD_REVISION = 3`) → `fold_revision` (022:18-25) | Forge-internal machinery | NOT SUPPLIED (none required) | — |
| 25 | Granted settlement overrides (moderator corrections at materialization) | `src/lib/fold/postgres-store.ts:1016-1020,1724-1762` → `settlement_override_requests` (009) | Forge-internal machinery | NOT SUPPLIED (none required) | — |
| 26 | Repository identity verify each run (numeric id → fresh owner/name/visibility) | `src/lib/fold/reconcile.ts:236-258`; store `postgres-store.ts:633-677` | `GET /projects/:id` by numeric id, live-verified | LIVE-VERIFIED — self-hosted unreachability maps onto `unavailable_reason`/`unavailable_since` (gap 13) | Public |

### 2d. Ingress — webhooks

| # | Ledger needs | GitHub supplier today | GitLab supplier | Verdict | Access |
|---|---|---|---|---|---|
| 27 | Delivery identity + event/action vocabulary + signature verification | `src/app/api/github/webhooks/route.ts:16-18`; `src/lib/github/webhook-signature.ts` | `merge_request`, `comment`, `push`, and work-item hooks (DOC): actions incl. `approval`/`unapproval`/`merge`, `changes.labels previous/current`, `object_attributes.merge_commit_sha`/`merged_at`; inbound secret verified by receiver | PARTIAL — hook surface documented; a per-delivery identity header equivalent to GitHub's delivery id was not itemized by the probe (UNVERIFIED) | Inbound secret; setup needs a maintainer on the target project |
| 28 | Payload: repository id/name, subject id+number, raw issue view | `src/lib/github/webhook-schema.ts:30-55,59-109` | `object_attributes` + `changes` structure documented (subject evidence); the repository-identity object inside payloads was not itemized by the probe | DOC-VERIFIED (subject fields) — repository-object field detail UNVERIFIED | Inbound secret |

### 2e. Registration

| # | Ledger needs | GitHub supplier today | GitLab supplier | Verdict | Access |
|---|---|---|---|---|---|
| 29 | Repository lookup, label-catalog existence, webhook create/delete | `src/lib/repositories/register.ts:58-67` gateway seam → `registered_repositories` (001:26-36) | Project lookup live-verified; label-catalog listing returned 401 on one public project while issues returned 200 (unexplained instance policy — gap 8); webhook creation is a maintainer configuration step (DOC) | PARTIAL | Public (lookup); label catalog potentially auth-gated; webhook setup maintainer-only |
| 30 | Claim-path workflow evidence (assignment automation detection) | `src/lib/github/client.ts:374-468` + `src/lib/domain/claim-path.ts:159-162` (GitHub Actions syntax) | No equivalent probed; GitHub Actions YAML detection does not port | NOT SUPPLIED | — |

### 2f. Access model (probe, live-verified across four projects)

- **200 unauthenticated:** project by path or numeric id; MR list + single MR with
  merge fields; approvals + approval-rules READ (not premium-gated — observed 200 on
  a Free-tier project); issues list; `closed_by` / `closes_issues`; repository
  commits; `GET /users?username=`.
- **401 unauthenticated (instance-wide on gitlab.com):** notes, `resource_label_events`,
  discussions, `/search`. Stable across four projects and repeat probes; observed
  behavior, not documented policy — treat a 401 here as a signal to authenticate.
- **Auth of another kind:** `GET /users/:id` is 403 sign-in-required (documented);
  webhook payloads carry an inbound secret; webhook setup needs a project maintainer.

## 3. Decision 1 — how a link is verified

**The link credential is a user-supplied personal access token (PAT).** Three
reasons, in order of weight:

1. **Per-instance OAuth app registration does not scale.** Every self-hosted
   instance would need its own OAuth application registered before a single link
   could be verified there; the operator of Overflow cannot register apps on
   instances they do not control and will never enumerate them all.
2. **A PAT cannot be obtained for an account the linker does not control.** A PAT
   is created signed-in as that account, on that instance. This is what makes
   linking a verified credit-claiming action rather than an assertion.
3. **The same credential serves the reconciliation reads afterwards.** The probe
   live-verified that reconciliation reads of comments and label events REQUIRE a
   PAT anyway — `gitlab.com` returns 401 unauthenticated for notes,
   `resource_label_events`, discussions, and search, across four unrelated
   projects. The verification credential and the reconciliation credential are the
   same object.

**Verification mechanics.** At link time the server performs an authenticated
`GET {instance_url}/api/v4/user` with the submitted token. On success the returned
`id` and `username` are frozen as `(forge_user_id, forge_login)` — never re-resolved
from the mutable login afterwards — and `verified_at` is stamped. Minimum scope:
`read_api` (the probe's doc fetch confirms `read_api` grants read access to the API;
`read_user` is NOT sufficient for project-scoped evidence endpoints). The token is
encrypted at rest with the mechanism already used for `users.encrypted_oauth_token`.
PATs are issued by a single instance and carry no cross-instance authority, so the
stored `(instance_url, token)` pair is namespaced by construction.

**Re-verification.** A 401 on a reconciliation read against a linked identity marks
that identity unverified and excludes it from credit resolution until re-verified.
This is fail-closed in the same direction as the timeline-completeness apparatus.

**Honest boundary:** webhook *setup* is a maintainer configuration step on the
target project (probe, DOC) — the PAT makes the account's identity and its
reconciliation reads possible; webhook configuration additionally requires the
maintainer role on that project and is a separate act.

## 4. Decision 2 — what a review round means on GitLab

**GitHub semantics first, precisely** (from the enumeration, current tree):
a round is one GitHub review submission whose **effective state at the merge
instant** was `CHANGES_REQUESTED`, submitted strictly before merge
(`review.submittedAt < mergeTime`), and not dismissed before merge. Distinctness is
per review id, not per reviewer — reviews deduplicate into a map keyed by review id,
reviewer identity is never fetched. A `DISMISSED` review still counts if its
`previousReviewState` was `CHANGES_REQUESTED` and the dismissal happened at/after
merge; a pre-merge dismissal withdraws the round. Count feeds
`credits = max(0, settled_points − review_rounds)`.

**The GitLab answer: a round is one unapproval (approval-retraction) event that
stands at merge.** That is, an approval was given and later retracted, and the same
user did not re-approve before merge. The definition mirrors GitHub's on every axis:

- **Distinctness per unapproval event id**, mirroring per-review-id distinctness.
  (Note for later steps: `review_rounds.github_review_id bigint > 0` unique cannot
  be populated — the round key on GitLab is the unapproval event id. Schema is out
  of scope here.)
- **Standing-at-merge replay** mirrors GitHub's effective-state-at-merge replay: a
  re-approval before merge cancels the retraction, exactly as a pre-merge dismissal
  withdraws a GitHub round.
- **Push-triggered approval resets fall out correctly.** A reset arrives as an
  `unapproval` action with `system_action = approvals_reset_on_push`; the replay
  does not care why an approval was retracted, only whether it stands at merge.

**Evidence source:** GitLab webhooks — the `merge_request` hook fires with
`object_attributes.action` `approval` / `unapproval` (structured; preferred) — or,
as fallback, system notes read with the `read_api` PAT. **Flag on the fallback:**
parsing system-note bodies is locale-fragile on self-hosted instances, because note
text is presentation, not contract. This is the same reason the typed
`resource_label_events` endpoint is preferred over label system notes for item 11.

**The limitation, stated honestly:** GitLab has no changes-requested concept. A
reviewer who comments demanding rework, but never approves and never retracts,
produces **no round** on GitLab where the equivalent GitHub review would price one.
Identical work can under-price on GitLab under this definition. That is accepted:
the alternative definitions price *more* wrongly, as follows.

**Rejected alternatives:**

- *Counting mere absence of approval as a round* — rejected: absence of approval is
  not evidence of demanded rework; many merged GitLab MRs legitimately carry zero
  approvals, and every one of them would price a deduction it did not earn.
- *Counting distinct approvers as rounds* — rejected: on GitHub two reviewers
  approving adds no round, so this would not price identically either; it would
  over-price exactly where GitHub under-prices by design.

## 5. Decision 3 — whether creditor_id resolves at fold time or freezes at settlement

**Fold time, retroactive.** Grounded in code facts:

- Creditor resolution is **already fold-time today**. The fold resolves the
  author's forge account id to a local account in memory and writes both
  `creditor_id` and the forge account id on every run
  (`src/lib/fold/repository-fold.ts:480-482,1119-1122`); no local match writes the
  row UNCLAIMED with only the forge account id (`:1143-1152`).
- **GitHub already has a retroactive claim path.** `claimGitHubIdentity`
  (`src/lib/fold/postgres-store.ts:1454-1522`), invoked at every sign-in
  (`src/auth.ts:119`), flips past UNCLAIMED rows matching the signing account's
  forge id to SETTLED or self-work — guarded by merge-time participation
  eligibility. It does not re-derive the rows; it claims them.

The fold recomputes derived rows per run (the `fold_revision` machinery forces
exactly this). Therefore a newly linked identity participates at the next
reconciliation run, and past UNCLAIMED GitLab settlements claim exactly the way
GitHub UNCLAIMED rows claim at sign-in.

**Guards carried unchanged:**

- Resolution matches only the exact triple `(provider, instance_url, forge_user_id)`,
  never the login.
- Participation-eligibility-at-merge (the moderation replay) still gates every
  claim, retroactive or not.

**Why frozen-at-settlement is rejected:** it would make GitLab semantics diverge
from existing GitHub semantics — the same retroactive claim exists on GitHub today,
so freezing for GitLab only creates two meanings of one ledger. And linking is a
PAT-verified action (decision 1), so the retroactive claim carries exactly the
legitimacy of GitHub's sign-in claim. Freezing buys no credit-integrity gain while
requiring new exemption machinery inside the fold.

## 6. Gaps and hazards

Numbered for reference from later steps.

1. **Issue state-reason has no GitLab equivalent.** The not-planned gate
   (`repository-fold.ts:469`, string constant `NOT_PLANNED`) is GitHub-vocabulary
   and needs a forge-neutral reformulation in later steps; the unwritable-closure
   prose ("No merged GitHub GraphQL closing pull request was found.") bakes GitHub
   into moderator-facing text.
2. **The 40-hex merge-commit CHECK and the fold regex exclude SHA-256
   repositories.** `db/migrations/007:105-107` requires `^[0-9a-f]{40}$` and the
   fold's selector re-tests the same regex (`repository-fold.ts:761`). Newer GitLab
   instances can run SHA-256; those repos cannot key a settlement today.
3. **`registered_repositories.owner_name` is globally unique** (001:29) — the same
   `owner/name` on two forges collides. An identity key must become
   `(provider, instance_url, project_id)`.
4. **The claim-ambiguity sentinel can collide with a real GitLab username.** The
   sentinel `__overflow_ambiguous_claim__` (`src/lib/github/types.ts:12`) is safe
   only under GitHub's login charset rule (`types.ts:6-9`); GitLab usernames permit
   underscores, so the sentinel is a legal GitLab username.
5. **Squash-merge SHA duality.** On a squash-merged MR the probe live-verified
   `sha == squash_commit_sha != merge_commit_sha`. A GitLab gateway must capture
   all three fields (`merge_commit_sha`, `sha`, `squash_commit_sha`) — either alone
   is incomplete evidence.
6. **Three timestamp formats must be normalized on receipt:** API objects ISO8601
   UTC with milliseconds + Z (`merged_at`, `approved_at`); commit dates ISO8601
   with numeric offsets (`committed_date`); webhook `changes` values in
   `YYYY-MM-DD HH:MM:SS UTC` shape (not ISO8601).
7. **`per_page` silently clamps to 100** (live-verified: a 101 request returned 100
   rows, no error) and deep collections need keyset pagination
   (`pagination=keyset`, cursor live-verified; offset walls are per-instance).
   Never rely on `per_page > 100`.
8. **The per-project labels endpoint returned 401 where issues returned 200** on
   one public project — unexplained instance policy. Treat label-catalog existence
   checks (item 29) as potentially auth-gated per project, and prefer the labels
   arrays embedded in issue/MR objects (public).
9. **GitLab bot users are real user rows with ids.** GitHub's null rule for
   Bot/Mannequin/Organization actors has no GitLab analog; attribution semantics
   differ, and the sponsor predicate's login-fallback is calibrated to GitHub
   account types.
10. **Timeline-completeness witnesses are provider-specific and must be RE-DERIVED
    for GitLab, not ported.** The current witnesses consume GraphQL timeline
    counts, REST events/comments manifests, node ids, and Link-header pagination —
    all GitHub-specific, and the subsystem where this repository's hardest defects
    have occurred.
11. **Claim-path workflow detection is GitHub Actions-specific and does not port**
    (item 30). Assignment-automation detection needs a GitLab-native re-derivation;
    the assignment-event evidence itself is item 10's gap.
12. **Diff representation differs between forges, so settlement proof hashes are
    never comparable cross-forge.** `proof_sha256` provenance is forge-local by
    construction.
13. **Self-hosted instance reachability maps onto the existing
    `unavailable_reason` / `unavailable_since` columns** (016:12-20); no new
    mechanism needed, but the decline-reason vocabulary is GitHub-worded today.
14. **Assignment-event evidence (opening-window bound, item 10) has no typed
    endpoint in the probe's inventory.** The window that bounds opening-label
    validity needs either a GitLab-native assignment event source or a
    reformulated bound in later steps.

## 7. Negative results are deliverables

The brief for this step said so, and the probe returned several. Listed as
first-class outcomes — these are what GitLab cannot supply, or supplies only
partially, and any later step designs around them rather than discovering them:

- **No issue state-reason equivalent.** `closed as not planned` is unportable as
  written; the gate needs reformulation (gap 1).
- **No append-only REST approval-event endpoint.** `approved_by` is a mutable
  snapshot; retraction is observable only through webhooks (structured,
  `approval`/`unapproval` actions) or system notes (auth-gated, locale-fragile).
  This is why review rounds are PARTIAL and why decision 2 keys on the webhook
  stream.
- **No changes-requested concept.** Reviewer-demanded rework without an
  approval/retraction cycle prices no round on GitLab (decision 2's stated
  limitation) — identical work can under-price.
- **No typed assignment-event endpoint in the probe's inventory.** The
  opening-window bound has no verified GitLab supplier (items 10, gap 14).
- **Label-catalog listing is auth-gated on at least one public project** where
  issues answer 200 — unexplained, stable, and a hazard for registration checks
  (item 29, gap 8).
- **Claim-path workflow detection has no GitLab equivalent** (item 30, gap 11).
- **`GET /users/:id` is sign-in-required** (403, documented): the id→username
  direction is not publicly queryable on gitlab.com, though embedded actor objects
  make it unnecessary for evidence captured at event time.
- **The Audit Events API is UNVERIFIED** (Ultimate tier, token-authenticated, not
  probed): a hypothetical complete append-only admin surface may exist; nothing in
  this contract relies on it.
- **Self-managed variance is UNVERIFIED.** Every auth observation here is
  gitlab.com SaaS. A self-managed instance with default settings may allow
  unauthenticated reads of notes and label events; do not assume either direction.
- **Methodological negative:** the GitLab docs site serves a challenge to plain
  HTTP clients, so every DOC-VERIFIED item was verified by fetching the doc file
  live from `gitlab-org/gitlab@master` through the public repository-files API.
  Re-verification of any DOC item should use that mechanism, not the docs site.

---

*Overflow forge-evidence contract · step 1 of issue 296 · 2026-09-10.
Inputs: evidence enumeration frozen at `c65fa7ec809c`; GitLab REST v4 live probe,
2026-09-10. Companion document: this file's HTML twin, same content.*
