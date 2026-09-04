# Overflow MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Overflow as a GitHub-native mutual-credit platform whose PostgreSQL state can be reproduced by folding registered repositories.

**Architecture:** A Next.js 16 App Router service owns OAuth, explicit repository registration, webhook acceleration, reconciliation, and the UI. GitHub GraphQL state is authoritative; PostgreSQL is a rebuildable materialization with derived ledger/calibration views, and pure domain modules keep scoring and policy independent of any repository's label vocabulary.

**Tech Stack:** Node.js 24, pnpm 10, Next.js 16.3.4, React/React DOM 19.2.8, TypeScript 5.9.3, Auth.js 5.0.0-beta.32, postgres 3.4.9, Zod 4.5.4, Tailwind CSS and `@tailwindcss/postcss` 4.3.3, Vitest 5.0.0, `@vitejs/plugin-react` 6.1.1, Testing Library 16.3.3, `@testing-library/jest-dom` 7.0.1, jsdom 30.0.1, Testcontainers 12.1.0, ESLint 10.9.1, `eslint-config-next` 16.3.4, `@types/node` 26.4.1, `@types/react` 19.2.18, `@types/react-dom` 19.2.7, PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-09-04-overflow-mvp-design.md`

## Global Constraints

- A repository participates only after a signed-in member explicitly registers that repository; never enumerate or register every accessible repository.
- Difficulty label text and display semantics are repository configuration, never hardcoded domain logic. Opening labels may be categories such as S/M/L and map to repository-chosen comparison/reservation points; actual labels use arbitrary text but must map onto every integer from 1 through 10 exactly once.
- Opening difficulty is captured at filing and remains immutable in the fold; settlement difficulty is supplied by the issue owner after issue-plus-diff review and before outsider settlement.
- The issue-to-closing-PR relationship comes only from GraphQL `closedByPullRequestsReferences`; REST timelines/cross-reference events are forbidden settlement sources.
- Awarded credits equal `max(0, settled difficulty - unique formal CHANGES_REQUESTED review IDs before merge)`.
- Comments, additions, deletions, file count, commit count, elapsed time, tokens, and every other churn metric never enter scoring.
- Self-work is retained as calibration evidence but creates no settlement or ledger row.
- Ledger entries and balances are derived views over settlement facts and remain zero-sum by construction; no hand-entered adjustment exists.
- Miscalibration is evaluated only as an account-level statistical pattern; no individual settlement can be disputed, reversed, or rerated through moderation.
- Webhooks require a valid raw-body `X-Hub-Signature-256` HMAC and idempotency by `X-GitHub-Delivery`; reconciliation is the correctness backstop.
- OAuth tokens are encrypted with AES-256-GCM before persistence and never logged.
- All new behavior follows red-green-refactor; every behavior test must fail for the expected missing behavior before production code is written.
- Each commit stages explicit task-owned paths and includes the implementing agent's verified `Co-Authored-By` trailer.

---

### Task 1: Project foundation, neutral rating domain, and relational materialization

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `tsconfig.json`
- Create: `next.config.ts`
- Create: `postcss.config.mjs`
- Create: `eslint.config.mjs`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `db/migrations/001_initial.sql`
- Create: `scripts/migrate.ts`
- Create: `src/lib/db/client.ts`
- Create: `src/lib/db/types.ts`
- Create: `src/lib/domain/difficulty-scheme.ts`
- Create: `src/lib/domain/settlement.ts`
- Create: `src/lib/domain/ledger.ts`
- Test: `tests/domain/difficulty-scheme.test.ts`
- Test: `tests/domain/settlement.test.ts`
- Test: `tests/domain/ledger.test.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `DifficultyScheme = { openingName: string; actualName: string; openingLabels: { label: string; comparisonPoints: number; reservePoints: number }[]; actualLabels: { label: string; points: number }[] }`.
- Produces: `validateDifficultyScheme(scheme): { ok: true } | { ok: false; reason: string }`, `parseOpeningDifficulty(labels, scheme)`, and `parseActualDifficulty(labels, scheme)` with `ok`, `none`, and `ambiguous` results.
- Produces: `calculateSettlement(input): SettlementDecision`, where status is `SETTLED`, `SELF_WORK`, or `UNSETTLED`.
- Produces: `foldLedger(settlements): LedgerEntry[]` and `foldBalances(entries): Map<string, number>`.
- Produces: lazy `getSql()` and `withTransaction(fn)` database adapters.

- [ ] **Step 1: Create the harness and failing neutral-domain tests**

Install the exact Tech Stack versions and create tests before domain files. Required examples:

```ts
const scheme = {
  openingName: "Size",
  actualName: "Delivered difficulty",
  openingLabels: [
    { label: "size/S", comparisonPoints: 2, reservePoints: 2 },
    { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
    { label: "size/L", comparisonPoints: 8, reservePoints: 8 },
  ],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
};
expect(validateDifficultyScheme(scheme)).toEqual({ ok: true });
expect(parseOpeningDifficulty(["bug", "size/M"], scheme)).toEqual({ kind: "ok", label: "size/M", comparisonPoints: 5, reservePoints: 5 });
expect(parseOpeningDifficulty(["size/S", "size/L"], scheme)).toEqual({ kind: "ambiguous" });
expect(parseActualDifficulty(["delivered/7"], scheme)).toEqual({ kind: "ok", label: "delivered/7", points: 7 });
```

Reject empty/duplicate label text, overlap between opening and actual catalogs, empty display names, out-of-range mapping values, duplicate actual point mappings, and actual catalogs that do not cover 1 through 10 exactly once.

```ts
expect(calculateSettlement({ creditorId: "u1", debtorId: "u1", opening: 8, settled: 9, reviewIds: ["r1"] })).toEqual({ status: "SELF_WORK", credits: 0 });
expect(calculateSettlement({ creditorId: "u1", debtorId: "u2", opening: 8, settled: 6, reviewIds: ["r1", "r1", "r2"] })).toMatchObject({ status: "SETTLED", reviewRounds: 2, credits: 4 });
```

- [ ] **Step 2: Verify domain RED**

Run `pnpm test --run tests/domain`. Expected: missing-module failures caused by the absent domain files.

- [ ] **Step 3: Implement minimal domain behavior**

Build exact label lookup maps, validate every configured mapping, and keep display text out of scoring. Return `UNSETTLED` for missing/ambiguous actual difficulty or creditor. `foldLedger` emits one positive creditor and one equal negative debtor row per positive settlement, skips self-work/unsettled/zero-credit rows, and never accepts arbitrary adjustments.

- [ ] **Step 4: Verify domain GREEN**

Run `pnpm test --run tests/domain`. Expected: all domain tests pass without warnings.

- [ ] **Step 5: Write the failing PostgreSQL behavior test**

Use Testcontainers `postgres:17-alpine`; execute the migration through `scripts/migrate.ts`; query real tables/views; then assert difficulty bounds, unique GitHub IDs, original opening-rating immutability, settlement proof uniqueness, ledger zero-sum, balance sums, and rejection of direct writes to derived views.

```ts
const rows = await sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public'`;
for (const table of ["users", "registered_repositories", "issues", "pull_requests", "review_rounds", "settlements", "self_work_calibrations", "unwritable_closures", "webhook_deliveries", "reconciliation_runs", "reconciliation_changes", "calibration_audits", "moderation_events"]) {
  expect(rows.some((row) => row.table_name === table)).toBe(true);
}
expect(await sumLedgerEntries(sql)).toBe(0);
await expect(updateOriginalOpeningDifficulty(sql)).rejects.toThrow();
```

- [ ] **Step 6: Verify schema RED, implement migration/adapters, then verify GREEN**

First run `pnpm test --run tests/db/schema.test.ts` and capture the expected missing-migration failure. Create UUID-backed tables, enums, constraints, immutable-opening trigger, and SQL views `ledger_entries`, `balances`, `calibration_statistics`. Implement a migration runner that applies numbered SQL files once. Rerun the schema test and then `pnpm typecheck` and `pnpm lint`; all must pass.

- [ ] **Step 7: Commit the foundation**

Stage only Task 1 files and commit `feat: establish overflow fold and schema` with the implementing agent's verified trailer.

---

### Task 2: GitHub OAuth, GraphQL source adapter, and explicit repository registration

**Files:**
- Create: `.env.example`
- Create: `src/auth.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Create: `src/lib/security/token-cipher.ts`
- Create: `src/lib/github/client.ts`
- Create: `src/lib/github/graphql.ts`
- Create: `src/lib/github/types.ts`
- Create: `src/lib/repositories/register.ts`
- Create: `src/lib/repositories/postgres-store.ts`
- Create: `src/app/api/repositories/route.ts`
- Test: `tests/security/token-cipher.test.ts`
- Test: `tests/github/client.test.ts`
- Test: `tests/github/graphql.test.ts`
- Test: `tests/repositories/register.test.ts`
- Test: `tests/api/repositories.test.ts`

**Interfaces:**
- Consumes: Task 1 DB adapter and `DifficultyScheme`.
- Produces: `encryptToken` / `decryptToken`, `parseGitHubRepository`, and `GitHubGateway`.
- `GitHubGateway` methods: `getRepository`, `createWebhook`, `deleteWebhook`, `ensureDifficultyLabels`, `listIssues`, `getIssueClosingPullRequests`, `getPullRequestReviews`, and `getPullRequestDiff`.
- Produces: `registerRepository(deps, input)` where input includes repository string plus both explicit label catalogs and display names.

- [ ] **Step 1: Write and verify failing encryption/parser/GraphQL tests**

Test AES-256-GCM round-trip/non-determinism/tamper rejection, repository URL normalization, and GraphQL pagination. The GraphQL closing query must include `closedByPullRequestsReferences(first: 100)` and reject REST timeline/cross-reference fixtures as a source of truth. Run focused tests and capture missing-module RED.

```ts
expect(parseGitHubRepository("https://github.com/octo/overflow.git")).toEqual({ owner: "octo", name: "overflow" });
expect(closingQuery).toContain("closedByPullRequestsReferences");
expect(closingQuery).not.toContain("timelineItems");
```

- [ ] **Step 2: Implement and verify primitives**

Use random 12-byte IVs, AES-256-GCM tags, a versioned base64url envelope, strict 32-byte decoded keys, GitHub API version headers, abort timeouts, cursor pagination, and sanitized errors. Never include access tokens or upstream response bodies in errors. Rerun focused tests.

- [ ] **Step 3: Write and verify failing registration tests**

Test success for one submitted repository, non-admin denial, duplicate registration, S/M/L opening labels, incomplete/duplicate actual point mappings, overlapping catalogs, creation of exactly the configured labels, webhook failure, DB failure with best-effort webhook deletion, and proof that no accessible-repository enumeration endpoint is called.

- [ ] **Step 4: Implement Auth.js, registration, and the route**

GitHub OAuth scopes are `read:user user:email repo admin:repo_hook`. The sign-in callback upserts GitHub identity and encrypted access token. Moderator role is assigned only from normalized `MODERATOR_GITHUB_LOGINS`. The repository route requires a session and returns structured `400`, `401`, `403`, `409`, or `502` JSON.

- [ ] **Step 5: Verify task gates and commit**

Run Task 2 focused tests, `pnpm test --run`, `pnpm typecheck`, and `pnpm lint`. Stage only Task 2 files and commit `feat: add github source and repository registration` with the implementing agent's verified trailer.

---

### Task 3: GitHub fold, signed webhooks, and deterministic reconciliation

**Files:**
- Modify: `src/auth.ts`
- Create: `src/lib/github/webhook-signature.ts`
- Create: `src/lib/github/webhook-schema.ts`
- Create: `src/lib/fold/repository-fold.ts`
- Create: `src/lib/fold/reconcile.ts`
- Create: `src/lib/fold/postgres-store.ts`
- Create: `src/lib/webhooks/processor.ts`
- Create: `src/app/api/github/webhooks/route.ts`
- Create: `scripts/reconcile.ts`
- Test: `tests/github/webhook-signature.test.ts`
- Test: `tests/fold/repository-fold.test.ts`
- Test: `tests/fold/reconcile.test.ts`
- Test: `tests/webhooks/processor.test.ts`
- Test: `tests/api/webhook.test.ts`

**Interfaces:**
- Consumes: Task 1 domain/DB and Task 2 GitHub gateway.
- Produces: `foldRepository(snapshot): FoldResult`, `reconcileRepository(deps, repositoryId): ReconciliationSummary`, and `processWebhook(deps, delivery)`.
- Produces: CLI `pnpm reconcile --repository owner/name` and all-repository mode.

- [ ] **Step 1: Write and verify signature/route RED**

Test constant-time-compatible HMAC validation, malformed/missing signatures, raw-body verification before JSON parsing, required headers, delivery dedupe, and retryable `503` on processing failure. Run focused tests before implementation.

- [ ] **Step 2: Implement webhook authentication shell and verify GREEN**

Use `createHmac("sha256")`, fixed-length lowercase hex validation, and `timingSafeEqual` only for equal-length buffers. Store sanitized delivery status; dispatch only supported event/action pairs.

- [ ] **Step 3: Write and verify failing fold/reconciliation tests**

Fixtures must cover arbitrary label catalogs including S/M/L, preserved original opening value after later label mutation, formal review-ID dedupe, comments excluded from review rounds, outsider merge settlement, self-work calibration only, zero-credit settlement, unclaimed creditor, several issues closed by one PR, hand/commit close as unwritable debt, banned/inactive accounts, missed/reordered webhooks, and reconciliation add/change/remove summaries.

```ts
expect(foldRepository(selfWorkFixture()).settlements).toHaveLength(0);
expect(foldRepository(selfWorkFixture()).selfWorkCalibrations).toHaveLength(1);
expect(foldRepository(restTimelineTrapFixture()).unwritableClosures).toHaveLength(1);
expect(foldRepository(twoReviewRoundsFixture()).settlements[0].credits).toBe(4);
```

- [ ] **Step 4: Implement the fold, materialization, reconciliation, and auth reconciliation hook**

Hash the raw diff but persist no patch/churn fields. Upsert a complete repository materialization transactionally, write reconciliation provenance/deltas, and delete derived rows absent from the authoritative snapshot. Webhooks run a scoped reconciliation rather than a second scoring path. When a matching GitHub user signs in, reconcile unclaimed rows.

- [ ] **Step 5: Verify full gates and commit**

Run Task 3 tests, `pnpm test --run`, `pnpm typecheck`, and `pnpm lint`. Stage only Task 3 files and commit `feat: materialize github settlements deterministically` with the implementing agent's verified trailer.

---

### Task 4: Calibration statistics and account-level enforcement ladder

**Files:**
- Create: `src/lib/calibration/statistics.ts`
- Create: `src/lib/moderation/transitions.ts`
- Create: `src/lib/moderation/service.ts`
- Create: `src/lib/moderation/postgres-store.ts`
- Create: `src/app/api/moderation/route.ts`
- Create: `src/app/api/moderation/[id]/route.ts`
- Test: `tests/calibration/statistics.test.ts`
- Test: `tests/moderation/transitions.test.ts`
- Test: `tests/moderation/service.test.ts`
- Test: `tests/api/moderation.test.ts`

**Interfaces:**
- Consumes: Task 1 calibration view and Task 3 materialized GitHub proof.
- Produces: `summarizeCalibration(pairs): { count; meanDelta; medianDelta }` and `compareCalibration(selfWork, outsider)`.
- Produces: `openAccountAudit`, `dismissAccountAudit`, `substantiateAccountAudit`, and `closeRecalibration`.

- [ ] **Step 1: Write and verify failing statistics/transition tests**

Use hand-derived pairs and assert count, mean and median; never reuse production calculations for expected values. `openAccountAudit` eligibility requires at least 10 self-work and 10 outsider settled pairs. Enforcement maps first substantiated pattern to `WARNED`, second to `RECALIBRATING`, and third-or-later to `BANNED`.

- [ ] **Step 2: Implement pure statistics/transitions and verify GREEN**

Reject non-integer/out-of-range pairs and non-positive confirmed counts. Preserve the exact cohort GitHub identifiers used for any audit snapshot.

- [ ] **Step 3: Write and verify failing account-level service/API tests**

Cover insufficient samples, duplicate open account audit, moderator authorization, reproducible cohort snapshot, dismissal to prior state, first warning, second-case repository deactivation, moderator-recorded recalibration plan/reactivation, third-case ban, and proof that no moderation path inserts/updates/deletes settlements or ledger rows.

- [ ] **Step 4: Implement service/store/routes without transaction arbitration**

Lock the audit and target user during transitions. Every moderation event records actor, reason, cohort definition/statistics, and prior/new state. Return `401`, `403`, `404`, `409`, and `422` precisely. Recalibration changes participation state only; it never rerates history.

- [ ] **Step 5: Verify full gates and commit**

Run Task 4 tests, `pnpm test --run`, `pnpm typecheck`, and `pnpm lint`. Stage only Task 4 files and commit `feat: add statistical calibration enforcement` with the implementing agent's verified trailer.

---

### Task 5: Member experience, operations, and clean-checkout verification

**Files:**
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.tsx`
- Create: `src/app/dashboard/page.tsx`
- Create: `src/app/issues/page.tsx`
- Create: `src/app/repositories/new/page.tsx`
- Create: `src/app/settlements/[id]/page.tsx`
- Create: `src/app/calibration/page.tsx`
- Create: `src/app/moderation/page.tsx`
- Create: `src/components/app-shell.tsx`
- Create: `src/components/balance-card.tsx`
- Create: `src/components/issue-card.tsx`
- Create: `src/components/repository-form.tsx`
- Create: `src/components/calibration-panel.tsx`
- Create: `src/lib/dashboard/queries.ts`
- Create: `public/mark.svg`
- Create: `docker-compose.yml`
- Create: `README.md`
- Test: `tests/components/landing.test.tsx`
- Test: `tests/components/dashboard.test.tsx`
- Test: `tests/components/issue-card.test.tsx`
- Test: `tests/components/repository-form.test.tsx`
- Test: `tests/components/calibration-panel.test.tsx`
- Test: `tests/dashboard/queries.test.ts`

**Interfaces:**
- Consumes: session, registration, materialized ledger/headroom, settlement proof, calibration, and moderation services.
- Produces: `getDashboard`, `listEligibleIssues`, `getSettlementProof`, `getCalibrationComparison`, and `listOpenAudits` projections with no credential fields.

- [ ] **Step 1: Write and verify component/query RED**

Use semantic Testing Library queries. Cover GitHub sign-in, positive/negative/zero balances, reserved headroom, configured opening categories and actual 1–10 mappings, issue/PR proof, review deduction, no churn display, one-repository form with editable label catalogs, calibration sample comparison, moderator-only controls, credential exclusion, and issue sort by configured reserve points then age.

- [ ] **Step 2: Implement the visual system, components, queries, and pages**

Use warm paper, ink, acid-lime credit, coral debit, serif display, mono metadata, visible focus, and responsive layouts from 360px. Server Components are the default; mutation forms alone are client components. Render GitHub strings as text and respect reduced motion. Signed-out protected pages redirect to `/`; empty/error states state the next action.

- [ ] **Step 3: Verify UI GREEN**

Run `pnpm test --run tests/components tests/dashboard`. Expected: all pass without accessibility warnings.

- [ ] **Step 4: Add local operations and documentation**

Ship PostgreSQL 17 Compose with volume/healthcheck. `.env.example` names `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GITHUB_WEBHOOK_SECRET`, `APP_URL`, `MODERATOR_GITHUB_LOGINS`, and optional `CREDIT_FLOOR`. README covers OAuth callback, public HTTPS webhook, configurable S/M/L-or-other opening catalogs, required actual 1–10 mappings, GraphQL requirement, migration, reconciliation, scoring/self-work, statistical ladder, local commands, and PostgreSQL already installed as an alternative to Compose.

- [ ] **Step 5: Run the complete verification matrix**

Run `pnpm test --run`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`. Every command must exit zero without application warnings.

- [ ] **Step 6: Prove deny-by-default ignore behavior**

Seed non-allow-listed junk under every kept directory, prove it ignored with `git check-ignore -v`, prove representative `.ts`, `.tsx`, `.sql`, `.md`, `.html`, `.svg`, and `.yml` files are tracked candidates, then remove only the seeded junk. `git status --porcelain` must show only intentional files.

- [ ] **Step 7: Commit the product surface**

Stage only Task 5 files and any deliberate ignore correction. Commit `feat: deliver overflow member experience` with the implementing agent's verified trailer.
