# Overflow MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production-shaped MVP that turns eligible merged GitHub pull requests into auditable, balanced mutual-credit transactions.

**Architecture:** A Next.js 16 App Router service owns the UI, authenticated mutations, GitHub webhook receiver, and PostgreSQL access. Pure domain modules decide difficulty, awards, ledger postings, and moderation transitions; adapters handle GitHub and SQL so behavior can be tested without live services.

**Tech Stack:** Node.js 24, pnpm 10, Next.js 16.3.4, React/React DOM 19.2.8, TypeScript 5.9.3, Auth.js 5.0.0-beta.32, postgres 3.4.9, Zod 4.5.4, Tailwind CSS and `@tailwindcss/postcss` 4.3.3, Vitest 5.0.0, `@vitejs/plugin-react` 6.1.1, Testing Library 16.3.3, `@testing-library/jest-dom` 7.0.1, jsdom 30.0.1, ESLint 10.9.1, `eslint-config-next` 16.3.4, `@types/node` 26.4.1, `@types/react` 19.2.18, `@types/react-dom` 19.2.7, PostgreSQL 17.

**Spec:** `docs/superpowers/specs/2026-09-04-overflow-mvp-design.md`

## Global Constraints

- A repository participates only after a signed-in member explicitly registers that repository; never enumerate or register every accessible repository.
- Eligible difficulty labels are exactly `overflow:1` through `overflow:10`.
- Final difficulty is the single valid PR difficulty label when present, otherwise the issue difficulty; ambiguity yields `NEEDS_AUDIT`.
- Awarded credits equal `max(0, rated difficulty - unique changes-requested review IDs before merge)`.
- Additions, deletions, file count, commit count, elapsed time, and every other churn metric must never enter scoring.
- Self-work is recorded as `SELF_WORK`, receives zero credits, and creates no ledger transaction or entries.
- Every nonzero award or correction uses immutable, balanced, double-entry ledger rows; never edit or delete posted rows.
- Webhooks require a valid raw-body `X-Hub-Signature-256` HMAC and idempotency by `X-GitHub-Delivery`.
- Miscalibration follows audit → warn → recalibrate → ban, with actor, reason, time, and compensating ledger entries recorded at every transition.
- OAuth tokens are encrypted with AES-256-GCM before persistence and are never logged.
- All new behavior follows red-green-refactor; every test must fail for the expected missing behavior before production code is written.
- Each commit must stage explicit paths and include the implementing agent's verified `Co-Authored-By` trailer.

---

### Task 1: Project foundation, domain rules, and relational contract

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
- Create: `src/lib/domain/difficulty.ts`
- Create: `src/lib/domain/award.ts`
- Create: `src/lib/domain/ledger.ts`
- Test: `tests/domain/difficulty.test.ts`
- Test: `tests/domain/award.test.ts`
- Test: `tests/domain/ledger.test.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `parseDifficultyLabels(labels: string[]): { kind: "ok"; difficulty: number } | { kind: "none" | "ambiguous" }`
- Produces: `calculateAward(input: AwardInput): AwardDecision`, where `AwardDecision.status` is `AWARDED`, `SELF_WORK`, or `NEEDS_AUDIT`.
- Produces: `createBalancedPostings(input: PostingInput): readonly [LedgerPosting, LedgerPosting] | readonly []`.
- Produces: `sql` tagged-template client and `transaction(fn)` from `src/lib/db/client.ts`.

- [ ] **Step 1: Create the test harness and failing domain tests**

Create package/config files with exact scripts `dev`, `build`, `start`, `lint`, `typecheck`, `test`, `test:watch`, `db:migrate`, and these representative tests:

```ts
import { describe, expect, it } from "vitest";
import { parseDifficultyLabels } from "@/lib/domain/difficulty";

describe("parseDifficultyLabels", () => {
  it("accepts exactly one overflow difficulty from 1 through 10", () => {
    expect(parseDifficultyLabels(["bug", "overflow:7"])).toEqual({ kind: "ok", difficulty: 7 });
  });

  it("rejects ambiguous difficulty labels", () => {
    expect(parseDifficultyLabels(["overflow:2", "overflow:8"])).toEqual({ kind: "ambiguous" });
  });
});
```

```ts
import { calculateAward } from "@/lib/domain/award";

it("suppresses self-work before ledger posting", () => {
  expect(calculateAward({ contributorId: "u1", sponsorId: "u1", issueLabels: ["overflow:8"], prLabels: [], reviewRoundIds: [] })).toMatchObject({ status: "SELF_WORK", credits: 0 });
});

it("uses PR recalibration and subtracts unique review rounds", () => {
  expect(calculateAward({ contributorId: "u1", sponsorId: "u2", issueLabels: ["overflow:8"], prLabels: ["overflow:6"], reviewRoundIds: ["r1", "r1", "r2"] })).toMatchObject({ status: "AWARDED", ratedDifficulty: 6, reviewRounds: 2, credits: 4 });
});
```

- [ ] **Step 2: Install dependencies and verify RED**

Use every exact dependency version from the Tech Stack header. Run:

```bash
pnpm install
pnpm test --run tests/domain/difficulty.test.ts tests/domain/award.test.ts tests/domain/ledger.test.ts
```

Expected: failure because the domain modules do not exist.

- [ ] **Step 3: Implement the minimal pure domain modules**

Implement exhaustive discriminated unions and integer guards. `calculateAward` must select a single PR difficulty over the issue difficulty, deduplicate review IDs, floor credits at zero, and return before scoring when contributor and sponsor match. `createBalancedPostings` returns no rows for zero and otherwise returns equal/opposite contributor and sponsor postings.

```ts
export type AwardInput = {
  contributorId: string;
  sponsorId: string;
  issueLabels: string[];
  prLabels: string[];
  reviewRoundIds: string[];
};

export type AwardDecision =
  | { status: "SELF_WORK"; ratedDifficulty: null; reviewRounds: 0; credits: 0 }
  | { status: "NEEDS_AUDIT"; reason: "MISSING_DIFFICULTY" | "AMBIGUOUS_DIFFICULTY"; ratedDifficulty: null; reviewRounds: number; credits: 0 }
  | { status: "AWARDED"; ratedDifficulty: number; reviewRounds: number; credits: number };
```

- [ ] **Step 4: Verify GREEN for the domain layer**

Run `pnpm test --run tests/domain`. Expected: all domain tests pass with no warnings.

- [ ] **Step 5: Write the failing schema-contract test**

Read `db/migrations/001_initial.sql` in the test and assert it declares every table from the spec, check constraints for difficulty/awards, unique external IDs, immutable ledger tables, and a deferred balanced-transaction constraint trigger.

```ts
const requiredTables = ["users", "registered_repositories", "issues", "review_rounds", "contributions", "ledger_transactions", "ledger_entries", "webhook_deliveries", "calibration_audits", "moderation_events"];
for (const table of requiredTables) expect(sqlText).toContain(`create table ${table}`);
```

- [ ] **Step 6: Verify schema RED**

Run `pnpm test --run tests/db/schema.test.ts`. Expected: failure because the migration and DB adapter are absent.

- [ ] **Step 7: Implement the SQL migration and typed DB adapter**

Create UUID-backed tables and enums matching the spec. Add an append-only trigger that rejects update/delete on ledger transactions and entries, plus a deferred constraint trigger requiring each transaction's entries to sum to zero. Implement one shared `postgres` client with `max: 10` and a transaction wrapper; do not connect at module import time in tests.

- [ ] **Step 8: Verify task gates**

Run `pnpm test --run tests/domain tests/db/schema.test.ts`, `pnpm typecheck`, and `pnpm lint`. Expected: all pass without warnings.

- [ ] **Step 9: Commit the foundation**

Stage only Task 1 files and commit with message `feat: establish overflow domain and ledger schema` plus the implementing agent's verified co-author trailer.

---

### Task 2: GitHub authentication and explicit repository registration

**Files:**
- Create: `.env.example`
- Create: `src/auth.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`
- Create: `src/lib/security/token-cipher.ts`
- Create: `src/lib/github/client.ts`
- Create: `src/lib/github/types.ts`
- Create: `src/lib/repositories/register.ts`
- Create: `src/lib/repositories/postgres-store.ts`
- Create: `src/app/api/repositories/route.ts`
- Test: `tests/security/token-cipher.test.ts`
- Test: `tests/github/client.test.ts`
- Test: `tests/repositories/register.test.ts`
- Test: `tests/api/repositories.test.ts`

**Interfaces:**
- Consumes: shared SQL client from Task 1.
- Produces: `encryptToken(plaintext: string, key: string): string` and `decryptToken(payload: string, key: string): string`.
- Produces: `parseGitHubRepository(input: string): { owner: string; name: string }`.
- Produces: `GitHubGateway` with `getRepository`, `createWebhook`, `deleteWebhook`, `ensureDifficultyLabels`, `listEligibleOpenIssues`, `getClosingIssues`, and `getPullRequestDiff` methods.
- Produces: `registerRepository(deps, input): Promise<RegisteredRepository>`.

- [ ] **Step 1: Write failing encryption and repository-parser tests**

```ts
it("round-trips without exposing plaintext", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const sealed = encryptToken("gho_secret", key);
  expect(sealed).not.toContain("gho_secret");
  expect(decryptToken(sealed, key)).toBe("gho_secret");
});

it.each(["octo/repo", "https://github.com/octo/repo", "https://github.com/octo/repo.git"])("parses %s", (input) => {
  expect(parseGitHubRepository(input)).toEqual({ owner: "octo", name: "repo" });
});
```

- [ ] **Step 2: Verify primitive RED**

Run `pnpm test --run tests/security/token-cipher.test.ts tests/github/client.test.ts`. Expected: missing-module failures.

- [ ] **Step 3: Implement token encryption and GitHub gateway**

Use random 12-byte IVs, AES-256-GCM, auth tags, versioned base64url segments, strict 32-byte decoded keys, `https://api.github.com`, `application/vnd.github+json`, and a finite request timeout. Never include tokens in thrown errors. Normalize repository input and reject non-GitHub URLs, extra path segments, control characters, and invalid owner/name syntax.

- [ ] **Step 4: Verify primitive GREEN**

Run the two focused test files. Expected: pass.

- [ ] **Step 5: Write failing registration service tests**

Cover one successful repository, permission denial, duplicate registration, webhook failure, local-save failure with best-effort webhook deletion, creation of exactly ten labels, and import limited to the submitted repository.

```ts
it("registers only the submitted admin repository", async () => {
  const result = await registerRepository(deps, { actorUserId: "u1", repository: "octo/one", webhookUrl: "https://overflow.example/api/github/webhooks" });
  expect(github.getRepository).toHaveBeenCalledWith("octo", "one");
  expect(github.ensureDifficultyLabels).toHaveBeenCalledWith("octo", "one", Array.from({ length: 10 }, (_, i) => `overflow:${i + 1}`));
  expect(store.insert).toHaveBeenCalledOnce();
});
```

- [ ] **Step 6: Verify registration RED**

Run `pnpm test --run tests/repositories/register.test.ts`. Expected: missing service failure.

- [ ] **Step 7: Implement registration, Auth.js, and authenticated API route**

Use Auth.js GitHub provider with scopes `read:user user:email repo admin:repo_hook`. On sign-in, upsert the GitHub user and encrypted access token. The route requires a session and returns structured `400`, `401`, `403`, `409`, or `502` JSON without leaking upstream bodies. Set moderator role only when the normalized login appears in `MODERATOR_GITHUB_LOGINS`.

- [ ] **Step 8: Verify registration and auth gates**

Run `pnpm test --run tests/security tests/github tests/repositories tests/api/repositories.test.ts`, `pnpm typecheck`, and `pnpm lint`. Expected: pass.

- [ ] **Step 9: Commit GitHub registration**

Stage only Task 2 files and commit with message `feat: add github login and explicit repository registration` plus the implementing agent's verified co-author trailer.

---

### Task 3: Signed webhook ingestion and merged-PR credit posting

**Files:**
- Modify: `src/auth.ts`
- Create: `src/lib/github/webhook-signature.ts`
- Create: `src/lib/github/webhook-schema.ts`
- Create: `src/lib/webhooks/processor.ts`
- Create: `src/lib/webhooks/postgres-store.ts`
- Create: `src/lib/contributions/service.ts`
- Create: `src/lib/contributions/postgres-store.ts`
- Create: `src/app/api/github/webhooks/route.ts`
- Test: `tests/github/webhook-signature.test.ts`
- Test: `tests/webhooks/processor.test.ts`
- Test: `tests/contributions/service.test.ts`
- Test: `tests/api/webhook.test.ts`

**Interfaces:**
- Consumes: domain award/ledger functions, GitHub gateway, and SQL transaction wrapper.
- Produces: `verifyGitHubSignature(rawBody: Uint8Array, signature: string | null, secret: string): boolean`.
- Produces: `processWebhook(deps, delivery): Promise<{ status: "processed" | "duplicate" | "ignored" }>`.
- Produces: `evaluateMergedPullRequest(deps, input): Promise<ContributionResult>`.

- [ ] **Step 1: Write failing signature and route tests**

```ts
it("accepts the matching sha256 signature and rejects malformed input", () => {
  const body = new TextEncoder().encode('{"zen":"keep it logically awesome"}');
  expect(verifyGitHubSignature(body, sign(body, "secret"), "secret")).toBe(true);
  expect(verifyGitHubSignature(body, "sha256=xyz", "secret")).toBe(false);
  expect(verifyGitHubSignature(body, null, "secret")).toBe(false);
});
```

Assert the route rejects invalid signatures before parsing invalid JSON, requires delivery/event headers, and maps a processor failure to retryable `503`.

- [ ] **Step 2: Verify signature RED**

Run `pnpm test --run tests/github/webhook-signature.test.ts tests/api/webhook.test.ts`. Expected: missing implementation failures.

- [ ] **Step 3: Implement raw-body authentication and delivery shell**

Use `createHmac("sha256")`, validate fixed-length hex, and call `timingSafeEqual` only on equal-length buffers. Insert a delivery record before dispatch; a unique-violation returns `duplicate`. Record processing success, ignored events, or sanitized errors.

- [ ] **Step 4: Write failing event and contribution tests**

Cover issue upsert/removal as labels change, unique review ID deduplication, merged PR with exactly one closing eligible issue, PR-label recalibration, self-work suppression, zero-credit awards, unclaimed contributor, ambiguous labels, multiple closing issues, banned participant, balanced postings, duplicate merge delivery, and a late review that appends a reversal plus replacement rather than mutating entries.

```ts
it("posts equal and opposite entries only for another member's merged work", async () => {
  const result = await evaluateMergedPullRequest(deps, mergedPr({ authorGithubId: "200", sponsorGithubId: "100", issueLabels: ["overflow:7"], prLabels: [], reviewIds: ["r1", "r2"] }));
  expect(result).toMatchObject({ status: "AWARDED", credits: 5 });
  expect(store.appendTransaction).toHaveBeenCalledWith(expect.objectContaining({ postings: [{ userId: "contributor", amount: 5 }, { userId: "sponsor", amount: -5 }] }));
});
```

- [ ] **Step 5: Verify event RED**

Run `pnpm test --run tests/webhooks/processor.test.ts tests/contributions/service.test.ts`. Expected: missing service failures.

- [ ] **Step 6: Implement processor, contribution service, and PostgreSQL stores**

Validate only the required webhook fields with Zod and ignore unknown fields. Fetch closing issues and the PR diff through the gateway, hash the raw diff with SHA-256, and persist no additions/deletions/files-changed values. Keep delivery processing, contribution upsert, review dedupe, and ledger append inside appropriate DB transactions. When a registered GitHub identity later signs in, reconcile their `UNCLAIMED` contributions through the same award service.

- [ ] **Step 7: Verify webhook GREEN and regression gates**

Run `pnpm test --run tests/github tests/webhooks tests/contributions tests/api/webhook.test.ts`, then `pnpm test --run`, `pnpm typecheck`, and `pnpm lint`. Expected: pass with no unhandled promise warnings.

- [ ] **Step 8: Commit event ingestion**

Stage only Task 3 files and commit with message `feat: award merged pull requests from signed webhooks` plus the implementing agent's verified co-author trailer.

---

### Task 4: Calibration audits and graduated enforcement

**Files:**
- Create: `src/lib/moderation/transitions.ts`
- Create: `src/lib/moderation/service.ts`
- Create: `src/lib/moderation/postgres-store.ts`
- Create: `src/app/api/audits/route.ts`
- Create: `src/app/api/audits/[id]/route.ts`
- Test: `tests/moderation/transitions.test.ts`
- Test: `tests/moderation/service.test.ts`
- Test: `tests/api/audits.test.ts`

**Interfaces:**
- Consumes: immutable ledger posting and SQL transaction interfaces.
- Produces: `nextEnforcementState(confirmedCases: number): "WARNED" | "RECALIBRATING" | "BANNED"`.
- Produces: `openCalibrationAudit`, `dismissCalibrationAudit`, `substantiateCalibrationAudit`, and `closeRecalibration` services.

- [ ] **Step 1: Write failing transition tests**

```ts
it.each([[1, "WARNED"], [2, "RECALIBRATING"], [3, "BANNED"], [8, "BANNED"]] as const)("maps %i confirmed cases to %s", (count, state) => {
  expect(nextEnforcementState(count)).toBe(state);
});
```

Reject counts below one and non-integers.

- [ ] **Step 2: Verify transition RED, then implement and verify GREEN**

Run the focused transition test, implement the exhaustive function, and rerun it. Expected RED: missing module. Expected GREEN: pass.

- [ ] **Step 3: Write failing moderation service tests**

Cover reporter authentication, duplicate open audit, self-audit rejection, opening hold reversal, dismissal reinstatement, substantiation with corrected difficulty 1–10, first warning, second-case repository deactivation and recalibration state, third-case ban, moderator authorization, immutable correction transactions, closing recalibration, and no credit when a recalibrated result reaches zero.

```ts
it("moves a second confirmed miscalibration into recalibration", async () => {
  const result = await substantiateCalibrationAudit(deps, { auditId: "a2", moderatorId: "mod", correctedDifficulty: 4, reason: "Diff supports four points" });
  expect(result.enforcementState).toBe("RECALIBRATING");
  expect(store.deactivateSponsoredRepositories).toHaveBeenCalledWith("sponsor");
  expect(store.appendModerationEvent).toHaveBeenCalledWith(expect.objectContaining({ toState: "RECALIBRATING" }));
});
```

- [ ] **Step 4: Verify moderation RED**

Run `pnpm test --run tests/moderation/service.test.ts tests/api/audits.test.ts`. Expected: missing service/route failures.

- [ ] **Step 5: Implement audit transactions, enforcement, and routes**

Every service runs in one SQL transaction and locks the audit, contribution, and target user rows before transition. Audit open appends a full reversal of the current effective award. Dismiss appends a reinstatement. Substantiate appends the corrected award and the exact enforcement transition. Routes return `401` for no session, `403` for non-moderators, `404` for unknown resources, `409` for invalid transitions, and `422` for invalid corrected difficulty.

- [ ] **Step 6: Verify moderation and full regression gates**

Run `pnpm test --run tests/moderation tests/api/audits.test.ts`, `pnpm test --run`, `pnpm typecheck`, and `pnpm lint`. Expected: pass.

- [ ] **Step 7: Commit moderation**

Stage only Task 4 files and commit with message `feat: enforce graduated calibration audits` plus the implementing agent's verified co-author trailer.

---

### Task 5: Product UI, operational setup, and clean-checkout verification

**Files:**
- Create: `src/app/layout.tsx`
- Create: `src/app/globals.css`
- Create: `src/app/page.tsx`
- Create: `src/app/dashboard/page.tsx`
- Create: `src/app/issues/page.tsx`
- Create: `src/app/repositories/new/page.tsx`
- Create: `src/app/contributions/[id]/page.tsx`
- Create: `src/app/moderation/page.tsx`
- Create: `src/components/app-shell.tsx`
- Create: `src/components/balance-card.tsx`
- Create: `src/components/issue-card.tsx`
- Create: `src/components/repository-form.tsx`
- Create: `src/components/audit-panel.tsx`
- Create: `src/lib/dashboard/queries.ts`
- Create: `public/mark.svg`
- Create: `docker-compose.yml`
- Create: `README.md`
- Test: `tests/components/landing.test.tsx`
- Test: `tests/components/dashboard.test.tsx`
- Test: `tests/components/issue-card.test.tsx`
- Test: `tests/components/repository-form.test.tsx`
- Test: `tests/components/audit-panel.test.tsx`
- Test: `tests/dashboard/queries.test.ts`

**Interfaces:**
- Consumes: Auth.js session, repository/contribution/moderation services, and DB queries from prior tasks.
- Produces: authenticated dashboard, issue board, repository registration, contribution evidence, and moderator queue pages.
- Produces: `getDashboard(userId)`, `listEligibleIssues(filters)`, `getContributionEvidence(id)`, and `listOpenAudits()` query functions.

- [ ] **Step 1: Write failing component tests**

Use Testing Library with semantic queries. Assert the landing page exposes one GitHub sign-in action; positive/negative/zero balances have readable labels; issue cards show difficulty and sponsor but no churn; repository form submits one repository string and renders structured errors; audit controls appear only to moderators.

```tsx
render(<IssueCard issue={{ title: "Harden webhook verification", repository: "octo/overflow", sponsor: "@octo", difficulty: 6, url: "https://github.com/octo/overflow/issues/12" }} />);
expect(screen.getByRole("link", { name: /harden webhook verification/i })).toBeVisible();
expect(screen.getByText("Difficulty 6")).toBeVisible();
expect(screen.queryByText(/lines changed/i)).not.toBeInTheDocument();
```

- [ ] **Step 2: Verify UI RED**

Run `pnpm test --run tests/components`. Expected: missing component failures.

- [ ] **Step 3: Implement the visual system and reusable components**

Use a warm paper base, dark ink, acid-lime credit, coral debit, serif display type, mono metadata, visible focus rings, and responsive layouts from 360px upward. Use Server Components by default; only the repository and audit forms are client components. Respect `prefers-reduced-motion`. Render all GitHub content as React text.

- [ ] **Step 4: Verify component GREEN**

Run `pnpm test --run tests/components`. Expected: all component tests pass.

- [ ] **Step 5: Write query tests and wire authenticated pages**

Add query tests that calculate balances from ledger entries, expose no token fields, sort eligible issues by difficulty descending then age, and reject the moderation query for non-moderators. Pages redirect signed-out visitors to `/`, show precise empty states, and link evidence back to GitHub.

- [ ] **Step 6: Add local operations and setup documentation**

Ship PostgreSQL 17 in Compose with a named volume and health check. `.env.example` must name `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GITHUB_WEBHOOK_SECRET`, `APP_URL`, and `MODERATOR_GITHUB_LOGINS` with non-secret example values such as `replace-me`. README must include GitHub OAuth callback, local webhook requirements, setup, migration, test/build commands, scoring, self-work, and moderation ladder.

- [ ] **Step 7: Run the complete verification matrix**

Run:

```bash
pnpm test --run
pnpm lint
pnpm typecheck
pnpm build
```

Expected: every command exits zero with no warnings attributable to the application.

- [ ] **Step 8: Prove deny-by-default ignore behavior**

Seed untracked junk under `src/`, `tests/`, `db/`, and `docs/` using filenames not allow-listed, then run `git check-ignore -v` for each. Confirm representative `.ts`, `.tsx`, `.sql`, `.md`, and `.html` project files are not ignored and `git status --porcelain` shows only intentional project files. Remove only the seeded junk files after proving the rules.

- [ ] **Step 9: Commit the product surface**

Stage only Task 5 files and any deliberate ignore correction. Commit with message `feat: deliver overflow member and moderation experience` plus the implementing agent's verified co-author trailer.
