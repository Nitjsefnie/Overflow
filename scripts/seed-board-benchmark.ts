#!/usr/bin/env node
// The issue 691 benchmark seed: fills a disposable PostgreSQL with a board-sized
// world — repositories, open issues, sponsor settlement history, one bench
// member with an API token — so the /issues, /api/issues and /members surfaces
// can be measured before and after the pagination fix on the same data.
//
// Run against the benchmark container (NOT production):
//
//   DATABASE_URL=postgresql://... node --experimental-transform-types \
//     scripts/seed-board-benchmark.ts
//
// Flags: --repositories --open-issues --sponsors --settlements-per-sponsor
// --underwater-repos --database-url, plus --mint-session (prints the session
// cookie without touching the database; needs AUTH_SECRET in the environment)
// and --help. Numeric flags fall back to their default when absent or
// malformed. Every run truncates and reseeds: the same options always produce
// the same world, ids included.
//
// The world is fully deterministic — a fixed PRNG seed, fixed uuids, fixed
// credential material — so Task 5's after-measurement replays on byte-identical
// data. Only one credential ever leaves stdout: the throwaway bench API token,
// which authenticates nothing but this benchmark database.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { encode } from "next-auth/jwt";
import postgres from "postgres";

/** The benchmark world's scale. Defaults match the issue 691 baseline brief. */
export interface SeedOptions {
  /** Registered repositories; the first `repositories` sponsors own one each. */
  repositories: number;
  /** OPEN, unclaimed issues, distributed round-robin over the repositories. */
  openIssues: number;
  /**
   * Sponsor accounts with settlement history. The last `underwaterRepos` repo
   * owners are pushed under their credit limit; the rest stay solvent.
   */
  sponsors: number;
  /** Settlements each sponsor takes part in, as earner or as spender. */
  settlementsPerSponsor: number;
  /** Repo-owning sponsors whose balance sits below their credit limit. */
  underwaterRepos: number;
  /** Falls back to the DATABASE_URL environment variable. */
  databaseUrl?: string;
}

export const DEFAULT_SEED_OPTIONS: SeedOptions = {
  repositories: 20,
  openIssues: 50_000,
  sponsors: 200,
  settlementsPerSponsor: 60,
  underwaterRepos: 2,
};

export interface SeedUser {
  id: string;
  githubUserId: number;
  login: string;
  /** True when this account is one of the underwater repository owners. */
  underwater: boolean;
}

export interface SeedRepository {
  id: string;
  githubRepositoryId: number;
  ownerName: string;
  sponsorId: string;
  githubWebhookId: number;
  difficultyScheme: SeedDifficultyScheme;
}

export interface SeedIssue {
  id: string;
  repositoryId: string;
  githubIssueId: number;
  issueNumber: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  openingLabel: string;
  openingComparisonPoints: number;
  openingReservePoints: number;
  createdAt: string;
}

export interface SeedPullRequest {
  id: string;
  repositoryId: string;
  issueId: string;
  githubPullRequestId: number;
  pullRequestNumber: number;
  url: string;
  title: string;
  body: string;
  authorId: string;
  mergedAt: string;
  createdAt: string;
}

export interface SeedSettlement {
  id: string;
  pullRequestId: string;
  issueId: string;
  creditorId: string;
  debtorId: string;
  openingComparisonPoints: number;
  settledPoints: number;
  reviewRounds: number;
  credits: number;
  proofSha256: string;
  createdAt: string;
}

export interface SeedWorld {
  users: SeedUser[];
  repositories: SeedRepository[];
  issues: SeedIssue[];
  pullRequests: SeedPullRequest[];
  settlements: SeedSettlement[];
  memberUserId: string;
}

export interface SeedResult {
  counts: {
    users: number;
    repositories: number;
    openIssues: number;
    settledIssues: number;
    settlements: number;
  };
  memberUserId: string;
  apiToken: string;
}

/** The scheme shape the seed writes; only openingName is read by the board. */
export interface SeedDifficultyScheme {
  openingName: string;
  actualName: string;
  openingLabels: { label: string; comparisonPoints: number; reservePoints: number }[];
  actualLabels: { label: string; points: number }[];
}

const SEED_NAMESPACE = "overflow-691-bench";

// Deterministic timeline, in the past so the seeded board matches the sorted
// history a live board would serve. Issue creation timestamps step forward
// strictly (one distinct millisecond per row), which makes the board's
// settled-balance/reserve/age ordering total, so both measurement runs see
// byte-identical responses.
const ISSUE_CREATED_BASE_MS = Date.parse("2025-09-01T00:00:00Z");
const ISSUE_CREATED_STEP_MS = 73;
const SETTLED_ISSUE_CREATED_BASE_MS = Date.parse("2025-06-01T00:00:00Z");
const SETTLED_ISSUE_CREATED_STEP_MS = 97;
const MERGE_BASE_MS = Date.parse("2025-10-01T00:00:00Z");
const MERGE_SPAN_MS = 360 * 24 * 60 * 60 * 1000;

/** Replays identically on every run: the whole world hangs off this one seed. */
const PRNG_SEED = 690_069;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fixed uuid per (kind, ordinal) — a reseed replays the same identifiers. */
function benchUuid(kind: number, ordinal: number): string {
  return `00000000-0000-0000-0000-${kind.toString(16)}${ordinal.toString(16).padStart(11, "0")}`;
}

export function benchMemberLogin(): string {
  return "bench-member";
}

/** Which repo-owning sponsors sit under their credit limit: the last ones. */
function isUnderwaterOwner(options: SeedOptions, sponsorIndex: number): boolean {
  return (
    sponsorIndex < options.repositories &&
    sponsorIndex >= options.repositories - options.underwaterRepos
  );
}

/**
 * The solvent sponsor whose settlements put the underwater owner in debt. The
 * guard in assertValidSeedOptions keeps this index clear of every underwater
 * owner, so the debt always flows from an account that can carry it.
 */
function solventCreditorIndex(options: SeedOptions, underwaterIndex: number): number {
  return (underwaterIndex + options.underwaterRepos + 1) % options.sponsors;
}

export function assertValidSeedOptions(options: SeedOptions): void {
  const fail = (detail: string): void => {
    throw new RangeError(`invalid seed options: ${detail}`);
  };
  if (!Number.isInteger(options.repositories) || options.repositories < 1) fail("repositories must be a positive integer");
  if (!Number.isInteger(options.openIssues) || options.openIssues < 1) fail("openIssues must be a positive integer");
  if (!Number.isInteger(options.sponsors) || options.sponsors < 1) fail("sponsors must be a positive integer");
  if (!Number.isInteger(options.settlementsPerSponsor) || options.settlementsPerSponsor < 1) {
    fail("settlementsPerSponsor must be a positive integer");
  }
  if (!Number.isInteger(options.underwaterRepos) || options.underwaterRepos < 0) {
    fail("underwaterRepos must be a non-negative integer");
  }
  if (options.underwaterRepos > options.repositories) {
    fail("underwaterRepos cannot exceed repositories");
  }
  if (options.sponsors < options.repositories + options.underwaterRepos + 1) {
    fail("sponsors must leave room for every repo owner plus one solvent creditor per underwater owner");
  }
}

/**
 * The board row count a default /issues request (claimState OPEN) serves from
 * this world: every open issue on a solvent sponsor's repository, plus exactly
 * one repayment opening per underwater sponsor.
 */
export function expectedOpenBoardRows(options: SeedOptions): number {
  const base = Math.floor(options.openIssues / options.repositories);
  const remainder = options.openIssues % options.repositories;
  let rows = options.underwaterRepos; // one repayment issue per underwater sponsor
  for (let repository = 0; repository < options.repositories; repository += 1) {
    if (isUnderwaterOwner(options, repository)) continue;
    rows += base + (repository < remainder ? 1 : 0);
  }
  return rows;
}

/** The deterministic bearer credential minted into api_tokens for the member. */
export function benchApiToken(): { token: string; tokenHash: Buffer } {
  const token = `ovf_${createHash("sha256").update(`${SEED_NAMESPACE}:api-token:v1`).digest("base64url")}`;
  return { token, tokenHash: createHash("sha256").update(token, "utf8").digest() };
}

/** The cookie name the production session strategy reads on plain HTTP. */
export function benchSessionCookieName(): string {
  return "authjs.session-token";
}

/**
 * Mints the session cookie the app decrypts with its own AUTH_SECRET. The
 * payload mirrors what the GitHub sign-in writes: the account id under both
 * `sub` and `userId`, the login as the name, the MEMBER role hint. The page
 * gate re-reads the role from the database, so the cookie only has to carry a
 * live account.
 */
export async function mintBenchSessionCookie(secret: string, userId: string): Promise<string> {
  const value = await encode({
    token: {
      sub: userId,
      userId,
      name: benchMemberLogin(),
      role: "MEMBER",
      canAdministerWebhooks: false,
      authenticatedAt: Math.floor(ISSUE_CREATED_BASE_MS / 1000),
    },
    secret,
    salt: benchSessionCookieName(),
    maxAge: 30 * 24 * 60 * 60,
  });
  return `${benchSessionCookieName()}=${value}`;
}

/**
 * Plans the whole world before anything is written: the pure core the tests
 * exercise, and the only place row shapes are decided.
 */
export function planSeedWorld(options: SeedOptions): SeedWorld {
  assertValidSeedOptions(options);
  const { repositories, openIssues, sponsors, settlementsPerSponsor } = options;
  const random = mulberry32(PRNG_SEED);

  const users: SeedUser[] = [];
  for (let index = 0; index < sponsors; index += 1) {
    users.push({
      id: benchUuid(1, index + 1),
      githubUserId: 91_000_000 + index,
      login: `bench-sponsor-${String(index).padStart(4, "0")}`,
      underwater: isUnderwaterOwner(options, index),
    });
  }
  const memberUserId = benchUuid(1, sponsors + 1);
  users.push({
    id: memberUserId,
    githubUserId: 91_000_000 + sponsors,
    login: benchMemberLogin(),
    underwater: false,
  });

  const scheme: SeedDifficultyScheme = {
    openingName: "Bench scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };

  const repositorySpecs: SeedRepository[] = [];
  for (let index = 0; index < repositories; index += 1) {
    repositorySpecs.push({
      id: benchUuid(2, index + 1),
      githubRepositoryId: 810_000 + index,
      ownerName: `bench-repo-${String(index).padStart(3, "0")}`,
      sponsorId: users[index].id,
      githubWebhookId: 910_000 + index,
      difficultyScheme: scheme,
    });
  }

  // Open, unclaimed issues, round-robin over the repositories. Issue numbers
  // are per-repository and contiguous from 1; settled issues continue the
  // sequence, so the two never collide.
  const openIssuesPerRepository = new Map<number, number>();
  const issues: SeedIssue[] = [];
  for (let index = 0; index < openIssues; index += 1) {
    const repositoryId = index % repositories;
    const issueNumber = Math.floor(index / repositories) + 1;
    openIssuesPerRepository.set(repositoryId, issueNumber);
    const label = scheme.openingLabels[index % scheme.openingLabels.length];
    issues.push({
      id: benchUuid(3, index + 1),
      repositoryId: repositorySpecs[repositoryId].id,
      githubIssueId: 71_000_000 + index,
      issueNumber,
      title: `Bench issue ${index + 1}: fix the deterministic harness`,
      body: `Seeded issue ${index + 1} for the issue 691 board benchmark.`,
      url: `https://example.invalid/${repositorySpecs[repositoryId].ownerName}/issues/${issueNumber}`,
      state: "OPEN",
      openingLabel: label.label,
      openingComparisonPoints: label.comparisonPoints,
      openingReservePoints: label.reservePoints,
      createdAt: new Date(ISSUE_CREATED_BASE_MS + index * ISSUE_CREATED_STEP_MS).toISOString(),
    });
  }

  // Settlement history. Every sponsor takes `settlementsPerSponsor` turns:
  // a solvent sponsor earns from the next sponsor round the cycle, and an
  // underwater owner only spends, drawing from a solvent creditor the option
  // guard keeps clear of the underwater set. Balances land near zero for
  // solvent sponsors and far below the floor limit of 10 for underwater ones.
  const settledPerRepository = new Map<number, number>();
  const pullRequests: SeedPullRequest[] = [];
  const settlements: SeedSettlement[] = [];
  let settlementIndex = 0;
  for (let sponsor = 0; sponsor < sponsors; sponsor += 1) {
    const underwater = isUnderwaterOwner(options, sponsor);
    const creditorIndex = underwater ? solventCreditorIndex(options, sponsor) : sponsor;
    const debtorIndex = underwater ? sponsor : (sponsor + 1) % sponsors;
    const creditor = users[creditorIndex];
    const debtor = users[debtorIndex];
    for (let turn = 0; turn < settlementsPerSponsor; turn += 1) {
      const repositoryId = settlementIndex % repositories;
      const issueNumber = (openIssuesPerRepository.get(repositoryId) ?? 0) + 1 + (settledPerRepository.get(repositoryId) ?? 0);
      settledPerRepository.set(repositoryId, (settledPerRepository.get(repositoryId) ?? 0) + 1);
      const issue: SeedIssue = {
        id: benchUuid(3, openIssues + settlementIndex + 1),
        repositoryId: repositorySpecs[repositoryId].id,
        githubIssueId: 71_000_000 + openIssues + settlementIndex,
        issueNumber,
        title: `Bench settled issue ${settlementIndex + 1}: the work that closed`,
        body: `Seeded settlement ${settlementIndex + 1} for the issue 691 board benchmark.`,
        url: `https://example.invalid/${repositorySpecs[repositoryId].ownerName}/issues/${issueNumber}`,
        state: "CLOSED",
        openingLabel: scheme.openingLabels[settlementIndex % scheme.openingLabels.length].label,
        openingComparisonPoints: scheme.openingLabels[settlementIndex % scheme.openingLabels.length].comparisonPoints,
        openingReservePoints: scheme.openingLabels[settlementIndex % scheme.openingLabels.length].reservePoints,
        createdAt: new Date(SETTLED_ISSUE_CREATED_BASE_MS + settlementIndex * SETTLED_ISSUE_CREATED_STEP_MS).toISOString(),
      };
      issues.push(issue);
      const mergedAt = MERGE_BASE_MS + Math.floor(random() * MERGE_SPAN_MS);
      const settledPoints = 1 + Math.floor(random() * 10);
      const reviewRounds = Math.floor(random() * 3);
      const pullRequestNumber = settledPerRepository.get(repositoryId)!;
      const pullRequest: SeedPullRequest = {
        id: benchUuid(4, settlementIndex + 1),
        repositoryId: issue.repositoryId,
        issueId: issue.id,
        githubPullRequestId: 81_000_000 + settlementIndex,
        pullRequestNumber,
        url: `https://example.invalid/${repositorySpecs[repositoryId].ownerName}/pull/${pullRequestNumber}`,
        title: `Bench pull request ${settlementIndex + 1}`,
        body: `Seeded pull request ${settlementIndex + 1} for the issue 691 board benchmark.`,
        authorId: debtor.id,
        mergedAt: new Date(mergedAt).toISOString(),
        createdAt: new Date(mergedAt - 24 * 60 * 60 * 1000).toISOString(),
      };
      pullRequests.push(pullRequest);
      settlements.push({
        id: benchUuid(5, settlementIndex + 1),
        pullRequestId: pullRequest.id,
        issueId: issue.id,
        creditorId: creditor.id,
        debtorId: debtor.id,
        openingComparisonPoints: issue.openingComparisonPoints,
        settledPoints,
        reviewRounds,
        credits: Math.max(0, settledPoints - reviewRounds),
        proofSha256: createHash("sha256").update(`${SEED_NAMESPACE}:settlement:${settlementIndex + 1}`).digest("hex"),
        createdAt: new Date(mergedAt + 60 * 60 * 1000).toISOString(),
      });
      settlementIndex += 1;
    }
  }

  return { users, repositories: repositorySpecs, issues, pullRequests, settlements, memberUserId };
}

/**
 * Truncates everything the migrations created (the ledger table itself is how
 * a rerun stays idempotent) and inserts the planned world in one transaction.
 */
export async function seedBoardBenchmark(options: SeedOptions): Promise<SeedResult> {
  const databaseUrl = options.databaseUrl ?? requireDatabaseUrl();
  const world = planSeedWorld(options);
  // The truncate-cascade NOTICEs are expected on every reseed; dropping them
  // keeps the stdout contract (seed line, member id, credentials) parseable.
  const sql = postgres(databaseUrl, { max: 4, onnotice: () => {} });

  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(`
        do $$
        declare table_name text;
        begin
          for table_name in
            select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'
          loop
            execute format('truncate table %I restart identity cascade', table_name);
          end loop;
        end $$;
      `);

      await tx`insert into users ${tx(
        world.users.map((user) => ({
          id: user.id,
          github_user_id: user.githubUserId,
          github_login: user.login,
          role: "MEMBER",
          enforcement_state: "ACTIVE",
        })),
        "id", "github_user_id", "github_login", "role", "enforcement_state",
      )}`;

      // Row objects are typed as plain records because postgres.js' insert
      // helper demands an index signature; the jsonb column receives the
      // object itself (the driver serializes it as JSON, which the column
      // parses), never a pre-stringified scalar.
      const repositoryRows: Record<string, unknown>[] = world.repositories.map((repository) => ({
        id: repository.id,
        github_repository_id: repository.githubRepositoryId,
        owner_name: repository.ownerName,
        sponsor_id: repository.sponsorId,
        visibility: "PUBLIC",
        github_webhook_id: repository.githubWebhookId,
        active: true,
        difficulty_scheme: repository.difficultyScheme,
      }));
      await tx`insert into registered_repositories ${tx(
        repositoryRows,
        "id", "github_repository_id", "owner_name", "sponsor_id", "visibility",
        "github_webhook_id", "active", "difficulty_scheme",
      )}`;

      for (const chunk of chunks(world.issues, 1_000)) {
        await tx`insert into issues ${tx(
          chunk.map((issue) => ({
            id: issue.id,
            github_issue_id: issue.githubIssueId,
            repository_id: issue.repositoryId,
            issue_number: issue.issueNumber,
            title: issue.title,
            body: issue.body,
            url: issue.url,
            state: issue.state,
            opening_label: issue.openingLabel,
            opening_comparison_points: issue.openingComparisonPoints,
            opening_reserve_points: issue.openingReservePoints,
            created_at: issue.createdAt,
            updated_at: issue.createdAt,
          })),
          "id", "github_issue_id", "repository_id", "issue_number", "title", "body", "url", "state",
          "opening_label", "opening_comparison_points", "opening_reserve_points", "created_at", "updated_at",
        )}`;
      }

      for (const chunk of chunks(world.pullRequests, 1_000)) {
        await tx`insert into pull_requests ${tx(
          chunk.map((pullRequest) => ({
            id: pullRequest.id,
            github_pull_request_id: pullRequest.githubPullRequestId,
            repository_id: pullRequest.repositoryId,
            issue_id: pullRequest.issueId,
            pull_request_number: pullRequest.pullRequestNumber,
            url: pullRequest.url,
            title: pullRequest.title,
            body: pullRequest.body,
            author_id: pullRequest.authorId,
            state: "MERGED",
            merged_at: pullRequest.mergedAt,
            created_at: pullRequest.createdAt,
            updated_at: pullRequest.createdAt,
          })),
          "id", "github_pull_request_id", "repository_id", "issue_id", "pull_request_number", "url",
          "title", "body", "author_id", "state", "merged_at", "created_at", "updated_at",
        )}`;
      }

      // Migration 003 moved the settlement's composite FK onto this link
      // table; the seed fills it beside every pull request, exactly as the
      // materializer does.
      await tx`insert into pull_request_issues ${tx(
        world.pullRequests.map((pullRequest) => ({
          pull_request_id: pullRequest.id,
          issue_id: pullRequest.issueId,
          repository_id: pullRequest.repositoryId,
        })),
        "pull_request_id", "issue_id", "repository_id",
      )}`;

      for (const chunk of chunks(world.settlements, 1_000)) {
        await tx`insert into settlements ${tx(
          chunk.map((settlement) => ({
            id: settlement.id,
            pull_request_id: settlement.pullRequestId,
            issue_id: settlement.issueId,
            creditor_id: settlement.creditorId,
            debtor_id: settlement.debtorId,
            opening_comparison_points: settlement.openingComparisonPoints,
            settled_points: settlement.settledPoints,
            review_rounds: settlement.reviewRounds,
            credits: settlement.credits,
            proof_sha256: settlement.proofSha256,
            status: "SETTLED",
            created_at: settlement.createdAt,
          })),
          "id", "pull_request_id", "issue_id", "creditor_id", "debtor_id", "opening_comparison_points",
          "settled_points", "review_rounds", "credits", "proof_sha256", "status", "created_at",
        )}`;
      }

      const apiToken = benchApiToken();
      await tx`
        insert into api_tokens (user_id, token_hash)
        values (${world.memberUserId}, ${apiToken.tokenHash})
      `;
    });
  } finally {
    await sql.end();
  }

  return {
    counts: {
      users: world.users.length,
      repositories: world.repositories.length,
      openIssues: world.issues.filter((issue) => issue.state === "OPEN").length,
      settledIssues: world.issues.filter((issue) => issue.state === "CLOSED").length,
      settlements: world.settlements.length,
    },
    memberUserId: world.memberUserId,
    apiToken: benchApiToken().token,
  };
}

function requireDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL must be set (or pass --database-url) before seeding the benchmark world.");
  }
  return databaseUrl;
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    out.push(rows.slice(index, index + size) as T[]);
  }
  return out;
}

/**
 * Numeric flags fall back to their default when absent or malformed, matching
 * the route layer's parse style: a bad value never fails a benchmark run, it
 * just loses the override. `--underwater-repos` admits 0.
 */
export function parseSeedArgs(argv: readonly string[]): SeedOptions {
  const parsed: SeedOptions = { ...DEFAULT_SEED_OPTIONS };
  const positive = (value: string | undefined): number | undefined => {
    const number_ = value === undefined ? Number.NaN : Number(value);
    return Number.isInteger(number_) && number_ >= 1 ? number_ : undefined;
  };
  const nonNegative = (value: string | undefined): number | undefined => {
    const number_ = value === undefined ? Number.NaN : Number(value);
    return Number.isInteger(number_) && number_ >= 0 ? number_ : undefined;
  };
  const read = (name: string): string | undefined => {
    const position = argv.indexOf(`--${name}`);
    return position >= 0 ? argv[position + 1] : undefined;
  };
  parsed.repositories = positive(read("repositories")) ?? parsed.repositories;
  parsed.openIssues = positive(read("open-issues")) ?? parsed.openIssues;
  parsed.sponsors = positive(read("sponsors")) ?? parsed.sponsors;
  parsed.settlementsPerSponsor = positive(read("settlements-per-sponsor")) ?? parsed.settlementsPerSponsor;
  parsed.underwaterRepos = nonNegative(read("underwater-repos")) ?? parsed.underwaterRepos;
  const databaseUrl = read("database-url");
  if (databaseUrl !== undefined) parsed.databaseUrl = databaseUrl;
  return parsed;
}

const USAGE = `usage: node --experimental-transform-types scripts/seed-board-benchmark.ts [flags]

Seeds the issue 691 benchmark world into DATABASE_URL (or --database-url).
Flags:
  --repositories N              default ${DEFAULT_SEED_OPTIONS.repositories}
  --open-issues N               default ${DEFAULT_SEED_OPTIONS.openIssues}
  --sponsors N                  default ${DEFAULT_SEED_OPTIONS.sponsors}
  --settlements-per-sponsor N   default ${DEFAULT_SEED_OPTIONS.settlementsPerSponsor}
  --underwater-repos N          default ${DEFAULT_SEED_OPTIONS.underwaterRepos}
  --database-url URL            overrides the DATABASE_URL environment variable
  --mint-session                print the bench session cookie (needs AUTH_SECRET)
  --help`;

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  if (process.argv.includes("--help")) {
    console.log(USAGE);
  } else if (process.argv.includes("--mint-session")) {
    const secret = process.env.AUTH_SECRET;
    if (secret === undefined || secret.length === 0) {
      console.error("--mint-session needs AUTH_SECRET in the environment.");
      process.exit(2);
    }
    const world = planSeedWorld(parseSeedArgs(process.argv.slice(2)));
    console.log(await mintBenchSessionCookie(secret, world.memberUserId));
  } else {
    const result = await seedBoardBenchmark(parseSeedArgs(process.argv.slice(2)));
    console.log(
      `seed: users=${result.counts.users} repositories=${result.counts.repositories} ` +
        `openIssues=${result.counts.openIssues} settledIssues=${result.counts.settledIssues} ` +
        `settlements=${result.counts.settlements}`,
    );
    console.log(`bench member user id: ${result.memberUserId}`);
    console.log(`api bearer token: ${result.apiToken}`);
    const secret = process.env.AUTH_SECRET;
    if (secret !== undefined && secret.length > 0) {
      console.log(`session cookie: ${await mintBenchSessionCookie(secret, result.memberUserId)}`);
    } else {
      console.log("session cookie: (set AUTH_SECRET to mint one; see --mint-session)");
    }
  }
}
