import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { PostgresReconciliationJobStore } from "@/lib/fold/reconciliation-job-store";
import { PostgresRepositorySizeStore } from "@/lib/fold/repository-size";
import { PostgresSponsorSweepRoundStore } from "@/lib/fold/sponsor-sweep-round-store";
import { PostgresSweepPassStore } from "@/lib/fold/sweep-pass-store";
import type { ReconciliationSweepControl } from "@/lib/fold/sweep-pass";
import { drainReconciliationJobs } from "@/lib/fold/reconciliation-worker";
import { reconcileRepository } from "@/lib/fold/reconcile";
import { GitHubGateway } from "@/lib/github/client";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { verifiedRepositoryPayload } from "../support/verified-repository";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const originalThreshold = process.env.RECONCILIATION_DIFF_ONLY_BACKLOG;
const originalPrefixedThreshold = process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG;
const windowMs = 6 * 60 * 60_000;
// After DB now(): a held job's deferral (the round's reset) is never due
// inside the drain that held it, so each window drains to IDLE.
const at = new Date("2030-01-01T00:00:00Z");
let externalId = 11_000_000;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "share", user: "share", password: randomUUID() });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  // The fold's diff-only read resolves the prefixed name first.
  delete process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG;
  process.env.RECONCILIATION_DIFF_ONLY_BACKLOG = "10";
  sql = getSql();
  await runMigrations();
});
beforeEach(async () => {
  await sql`delete from repository_reconciliation_jobs`;
  await sql`delete from reconciliation_sweep_rounds`;
  await sql`delete from registered_repositories`;
  await sql`delete from users`;
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
  if (originalThreshold === undefined) delete process.env.RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.RECONCILIATION_DIFF_ONLY_BACKLOG = originalThreshold;
  if (originalPrefixedThreshold === undefined) delete process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG = originalPrefixedThreshold;
});

async function insertSponsor(): Promise<string> {
  const githubUserId = (externalId += 1);
  const [row] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`sponsor-${githubUserId}`}) returning id`;
  return row!.id;
}

async function insertRepository(sponsorId: string): Promise<{ id: string; githubRepositoryId: number; ownerName: string }> {
  const key = (externalId += 1);
  const [row] = await sql<{ id: string }[]>`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${key}, ${`owner/repo-${key}`}, ${sponsorId}, 'PUBLIC', ${key}, ${sql.json(validDifficultyScheme())}) returning id`;
  return { id: row!.id, githubRepositoryId: key, ownerName: `owner/repo-${key}` };
}

/** A forge answering one repository's verify, issue listing and per-issue reads. */
function forge(repository: { githubRepositoryId: number; ownerName: string }, issueCount: number, token: string): GitHubGateway {
  const updated = new Date("2029-12-01T00:00:00Z").toISOString();
  const subjects = Array.from({ length: issueCount }, (_, index) =>
    ({ id: repository.githubRepositoryId * 1000 + index, number: index + 1, updated_at: updated }));
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return new GitHubGateway({ accessToken: token, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/repositories/")) return Response.json(verifiedRepositoryPayload(repository.githubRepositoryId, repository.ownerName));
    if (url.pathname.endsWith("/issues")) return Response.json(subjects);
    if (/\/issues\/\d+\/(events|comments)$/.test(url.pathname)) return Response.json([]);
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("query RepositoryIssue(")) {
      const subject = subjects.find(({ number }) => number === variables.issueNumber)!;
      return Response.json({ data: { repository: { issue: {
        databaseId: subject.id, number: subject.number, title: "Walked", body: "", url: "https://example.test/issue",
        state: "OPEN", stateReason: null, createdAt: updated, updatedAt: updated, closedAt: null,
        author: null, labels: page([]), assignees: { nodes: [] }, timelineItems: page([]), closedByPullRequestsReferences: page([]),
      } } } });
    }
    if (query.includes("query IssueTimelineCounts(")) return Response.json({ data: { repository: Object.fromEntries(
      subjects.filter(({ number }) => variables[`number${number}`] !== undefined)
        .map(({ id, number }) => [`i${number}`, { databaseId: id, timelineItems: { totalCount: 0 } }]),
    ) } });
    throw new Error("Unexpected forge request");
  } });
}

describe("per-repository share of a sponsor's sweep request budget", () => {
  it("charges a repository's share and the sponsor's budget together, per window, under concurrent stores", async () => {
    const next = new Date(at.getTime() + windowMs);
    const sponsorId = await insertSponsor();
    const [a, b, late] = [await insertRepository(sponsorId), await insertRepository(sponsorId), await insertRepository(sponsorId)];
    await sql`update registered_repositories set active = false where id = ${late.id}`;
    const stores = Array.from({ length: 8 }, () => new PostgresSponsorSweepRoundStore(sql, windowMs));
    const spend = (id: string, index: number, now = at) => stores[index % 8]!.spend(sponsorId, id, now, 11);
    const spent = async () => Object.fromEntries((await sql<{ repository_id: string; window_start: Date; spent: number }[]>`
      select repository_id, window_start, spent from reconciliation_sweep_repository_spend`)
      .map((row) => [row.repository_id, { window_start: row.window_start, spent: row.spent }]));
    const round = async () => (await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`)[0];

    // Two active repositories (the inactive one is not counted): floor(11 / 2) = 5 each.
    const holds = await Promise.all([...Array.from({ length: 12 }, (_, i) => spend(a.id, i)), ...Array.from({ length: 12 }, (_, i) => spend(b.id, i))]);
    expect(holds.slice(0, 12).filter((hold) => hold === null)).toHaveLength(5);
    expect(holds.slice(12).filter((hold) => hold === null)).toHaveLength(5);
    expect(holds.filter((hold) => hold !== null).every((hold) => hold!.getTime() === next.getTime())).toBe(true);
    // A refused request moves neither counter.
    expect(await round()).toEqual({ spent: 10 });
    expect(await spent()).toEqual({ [a.id]: { window_start: at, spent: 5 }, [b.id]: { window_start: at, spent: 5 } });

    // Mid-window activation lowers every share to floor(11 / 3) = 3; the
    // sponsor's own cap still bounds the window at 11, and a repository the
    // sponsor cap refuses is not charged.
    await sql`update registered_repositories set active = true where id = ${late.id}`;
    expect(await spend(late.id, 0)).toBeNull();
    expect(await spend(late.id, 1)).toEqual(next);
    expect(await round()).toEqual({ spent: 11 });
    expect((await spent())[late.id]).toEqual({ window_start: at, spent: 1 });

    // A budget below the active repository count leaves every share at zero,
    // even with the sponsor's rolled-over window unspent.
    expect(await stores[0]!.spend(sponsorId, b.id, next, 2)).toEqual(new Date(next.getTime() + windowMs));
    expect(await round()).toEqual({ spent: 0 });
    expect((await spent())[b.id]).toEqual({ window_start: at, spent: 5 });

    // The next window starts every repository's count from zero.
    for (let i = 0; i < 3; i++) expect(await spend(a.id, i, next)).toBeNull();
    expect(await spend(a.id, 3, next)).toEqual(new Date(next.getTime() + windowMs));
    expect((await spent())[a.id]).toEqual({ window_start: next, spent: 3 });
    expect(await round()).toEqual({ spent: 3 });

    // The row goes with its repository.
    await sql`delete from registered_repositories where id = ${a.id}`;
    expect((await spent())[a.id]).toBeUndefined();
  });

  it("lets every repository of a diff-only sponsor walk within N windows while four older large jobs are due", async () => {
    const budget = 100;
    const sponsorId = await insertSponsor();
    const large = [await insertRepository(sponsorId), await insertRepository(sponsorId),
      await insertRepository(sponsorId), await insertRepository(sponsorId)];
    const small = await insertRepository(sponsorId);
    const repositories = [...large, small];
    const n = repositories.length;
    // Sized well above the per-run overhead (a verify and a listing page).
    const share = Math.floor(budget / n);
    const issueCounts = new Map([...large.map((r) => [r.id, 60] as const), [small.id, 2]]);

    // The sponsor is diff-only, so its REDERIVATION folds are budget-bound too.
    const sizes = new PostgresRepositorySizeStore(sql);
    for (const r of repositories) await sizes.store(r.id, issueCounts.get(r.id)!, at);
    const jobs = new PostgresReconciliationJobStore(sql);
    for (const [index, r] of large.entries()) {
      if (index % 2 === 0) await jobs.enqueueReconciliationJob(r.id, "SWEEP");
      else await jobs.requestRepositoryRederivation(r.id, at);
    }
    await jobs.enqueueReconciliationJob(small.id, "SWEEP");
    for (const [index, r] of repositories.entries()) {
      await sql`update repository_reconciliation_jobs set created_at = ${new Date(Date.parse("2029-12-01T00:00:00Z") + index * 60_000)}
        where repository_id = ${r.id}`;
    }

    const token = randomBytes(24).toString("hex");
    const store = new PostgresFoldStore(sql);
    store.getGitHubAccessToken = async () => token;
    const gateways = new Map(repositories.map((r) => [r.id, forge(r, issueCounts.get(r.id)!, token)]));
    const rounds = new PostgresSponsorSweepRoundStore(sql, windowMs);
    const passes = new PostgresSweepPassStore(sql);
    let window = 0;
    let clock = at;
    const spends: Array<{ window: number; repositoryId: string; charged: string | undefined; admitted: boolean }> = [];
    const stages: Array<{ window: number; repositoryId: string }> = [];
    const completions: Array<{ window: number; repositoryId: string }> = [];
    const sweepFor = (folding: string): ReconciliationSweepControl => ({
      spend: async (sponsor, charged) => {
        const hold = await rounds.spend(sponsor, charged!, clock, budget);
        spends.push({ window, repositoryId: folding, charged, admitted: hold === null });
        return hold;
      },
      openPass: async (input) => {
        const pass = await passes.open(input);
        return { ...pass, stage: async (subject) => {
          await pass.stage(subject);
          stages.push({ window, repositoryId: input.repositoryId });
        } };
      },
      discardPass: (id) => passes.discardByRepository(id),
    });
    const worker = { store, now: () => clock, scheduleLeaseRenewal: () => () => {},
      reconcile: async (id: string, options: Parameters<typeof reconcileRepository>[2]) => {
        const result = await reconcileRepository({ store, github: gateways.get(id)!, sweep: sweepFor(id),
          now: () => clock, onBudgetChange: () => {} }, id, options);
        if (!result.skipped) completions.push({ window, repositoryId: id });
        return result;
      } };
    const runWindow = async (k: number, drains: number) => {
      window = k; clock = new Date(at.getTime() + k * windowMs);
      // One instant for every job; the claim reads the database's clock.
      await sql`update repository_reconciliation_jobs set run_after = now()`;
      await Promise.all(Array.from({ length: drains }, () => drainReconciliationJobs(worker, { maxJobs: 1000 })));
      const [round] = await sql<{ window_start: Date; spent: number }[]>`
        select window_start, spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`;
      return round!;
    };
    const assertCaps = (k: number, round: { window_start: Date; spent: number }) => {
      const admitted = spends.filter((s) => s.window === k && s.admitted);
      // (d) Requests admitted per window never exceed the budget, on the record and the round row.
      expect(admitted.length).toBeLessThanOrEqual(budget);
      expect(round).toEqual({ window_start: clock, spent: admitted.length });
      // (c) A large repository admitted in a window walks in that window.
      for (const r of large) {
        if (admitted.some((s) => s.repositoryId === r.id)) {
          expect(stages.some((s) => s.window === k && s.repositoryId === r.id), `large ${r.id} in window ${k}`).toBe(true);
        }
      }
    };

    for (let k = 0; k < n; k++) assertCaps(k, await runWindow(k, 1));
    // One more window with the four large jobs racing on four drain loops.
    assertCaps(n, await runWindow(n, 4));

    // The record is live: every repository asked for budget in the first window.
    expect(new Set(spends.filter((s) => s.window === 0).map((s) => s.repositoryId))).toEqual(new Set(repositories.map((r) => r.id)));
    expect(spends.every((s) => s.charged === s.repositoryId)).toBe(true);
    // (a) Within N windows every repository records walk progress.
    const label = (id: string) => id === small.id ? "small" : `large-${large.findIndex((r) => r.id === id)}`;
    expect(repositories.filter((r) => !stages.some((s) => s.window < n && s.repositoryId === r.id)).map((r) => label(r.id))).toEqual([]);
    // (b) The small repository's job completes within N windows.
    expect(completions.filter((c) => c.repositoryId === small.id && c.window < n)).toHaveLength(1);
    expect(await sql`select 1 from repository_reconciliation_jobs where repository_id = ${small.id}`).toHaveLength(0);
    // The large passes need more than a window: they were still held, not done.
    expect(completions.filter((c) => c.repositoryId !== small.id)).toEqual([]);
    expect(spends.filter((s) => s.window === n && s.admitted).length).toBeGreaterThan(share);
  });
});
