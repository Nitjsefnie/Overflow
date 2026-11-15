import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const windowMs = 6 * 60 * 60_000;
// After DB now(): a held job's deferral (the round's reset) is never due
// inside the drain that held it, so each window drains to IDLE.
const at = new Date("2030-01-01T00:00:00Z");
let externalId = 11_000_000;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "share", user: "share", password: randomUUID() });
  container = started.container;
  vi.stubEnv("OVERFLOW_DATABASE_URL", started.databaseUrl);
  // The fold's diff-only read resolves the prefixed name first.
  vi.stubEnv("OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG", undefined);
  vi.stubEnv("RECONCILIATION_DIFF_ONLY_BACKLOG", "10");
  sql = getSql();
  await runMigrations();
});
beforeEach(async () => {
  // Cascades to every run, change and pass a fold left behind.
  await sql`truncate repository_reconciliation_jobs, reconciliation_sweep_rounds, registered_repositories, users cascade`;
});
afterAll(async () => { await closeSql(); await container?.stop(); vi.unstubAllEnvs(); });

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

/** A forge answering one repository's verify, its issue listing `perPage` a page from `since`, and per-issue reads; `gone` issues are deleted. */
function forge(repository: { githubRepositoryId: number; ownerName: string }, issueCount: number, token: string, perPage = 100, gone = new Set<number>()): GitHubGateway {
  const updated = new Date("2029-12-01T00:00:00Z").toISOString();
  const subjects = Array.from({ length: issueCount }, (_, index) => ({ id: repository.githubRepositoryId * 1000 + index,
    number: index + 1, updated_at: new Date(Date.parse(updated) + index * 1000).toISOString() }));
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return new GitHubGateway({ accessToken: token, fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/repositories/")) return Response.json(verifiedRepositoryPayload(repository.githubRepositoryId, repository.ownerName));
    if (url.pathname.endsWith("/issues")) {
      const [since, at] = [url.searchParams.get("since") ?? "", Number(url.searchParams.get("page") ?? 1)];
      const listed = subjects.filter(({ number, updated_at }) => !gone.has(number) && updated_at >= since);
      const next = new URL(url); next.searchParams.set("page", String(at + 1));
      return Response.json(listed.slice((at - 1) * perPage, at * perPage), { headers: at * perPage < listed.length ? { link: `<${next}>; rel="next"` } : {} });
    }
    if (/\/issues\/\d+\/(events|comments)$/.test(url.pathname)) return Response.json([]);
    const { query, variables } = JSON.parse(String(init?.body));
    if (query.includes("query RepositoryIssue(")) {
      const subject = subjects.find(({ number }) => number === variables.issueNumber)!;
      return Response.json({ data: { repository: { issue: gone.has(subject.number) ? null : {
        databaseId: subject.id, number: subject.number, title: "Walked", body: "", url: "https://example.test/issue",
        state: "OPEN", stateReason: null, createdAt: updated, updatedAt: subject.updated_at, closedAt: null,
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

    for (const r of [a, b, late]) await new PostgresReconciliationJobStore(sql).enqueueReconciliationJob(r.id, "SWEEP");
    // Two due repositories (the inactive one is not counted): floor(11 / 2) = 5 each,
    // and the request left once both have their floors goes to whichever borrows first.
    const holds = await Promise.all([...Array.from({ length: 12 }, (_, i) => spend(a.id, i)), ...Array.from({ length: 12 }, (_, i) => spend(b.id, i))]);
    const admitted = [holds.slice(0, 12), holds.slice(12)].map((side) => side.filter((hold) => hold === null).length);
    expect([...admitted].sort()).toEqual([5, 6]);
    expect(holds.filter((hold) => hold !== null).every((hold) => hold!.getTime() === next.getTime())).toBe(true);
    // A refused request moves neither counter.
    expect(await round()).toEqual({ spent: 11 });
    expect(await spent()).toEqual({ [a.id]: { window_start: at, spent: admitted[0] }, [b.id]: { window_start: at, spent: admitted[1] } });

    // Activation makes three repositories: a budget of 2 leaves every share at zero,
    // even with the sponsor's rolled-over window unspent.
    await sql`update registered_repositories set active = true where id = ${late.id}`;
    expect(await stores[0]!.spend(sponsorId, b.id, next, 2)).toEqual(new Date(next.getTime() + windowMs));
    expect(await round()).toEqual({ spent: 0 });
    expect((await spent())[b.id]).toEqual({ window_start: at, spent: admitted[1] });

    // The next window starts every count from zero: a's share is floor(11 / 3) = 3,
    // and its due siblings, still under theirs, keep it from borrowing.
    for (let i = 0; i < 3; i++) expect(await spend(a.id, i, next)).toBeNull();
    expect(await spend(a.id, 3, next)).toEqual(new Date(next.getTime() + windowMs));
    expect((await spent())[a.id]).toEqual({ window_start: next, spent: 3 });
    expect(await round()).toEqual({ spent: 3 });

    // The row goes with its repository.
    await sql`delete from repository_reconciliation_jobs where repository_id = ${a.id}`;
    await sql`delete from registered_repositories where id = ${a.id}`;
    expect((await spent())[a.id]).toBeUndefined();
  });

  it("lends idle repositories' shares to capped siblings until the round's budget is spent", async () => {
    const sponsorId = await insertSponsor();
    const repositories = await Promise.all(Array.from({ length: 10 }, () => insertRepository(sponsorId)));
    const [jobs, rounds, admitted] = [new PostgresReconciliationJobStore(sql), new PostgresSponsorSweepRoundStore(sql, windowMs), new Map<string, number>()];
    // Three idle repositories and seven due jobs, each needing more than its share of floor(100 / 10) = 10.
    for (const r of repositories.slice(3)) await jobs.enqueueReconciliationJob(r.id, "SWEEP");
    // The worker's loop: claim the oldest due job, spend until held, defer the job to the hold.
    for (let job, hold; (job = await jobs.claimNextReconciliationJob()) !== null;) {
      while ((hold = await rounds.spend(sponsorId, job.repositoryId, at, 100)) === null) admitted.set(job.repositoryId, (admitted.get(job.repositoryId) ?? 0) + 1);
      await jobs.deferReconciliationJob(job.id, job.leaseToken, hold);
    }
    // Only the last to cap, with every other due floor spent, borrows the idle 30.
    expect([...admitted.values()]).toEqual([10, 10, 10, 10, 10, 10, 40]);
    expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`).toEqual([{ spent: 100 }]);
  });

  it("keeps a due sibling's floor when an idle repository's job becomes due after a capped one asked to borrow", async () => {
    const sponsorId = await insertSponsor();
    const [a, b, c] = await Promise.all(Array.from({ length: 4 }, () => insertRepository(sponsorId)));
    const jobs = new PostgresReconciliationJobStore(sql);
    for (const r of [a!, b!]) await jobs.enqueueReconciliationJob(r.id, "SWEEP");
    const store = new PostgresSponsorSweepRoundStore(sql, windowMs);
    const spend = async (id: string, most: number) => { let n = 0; while (n < most && await store.spend(sponsorId, id, at, 40) === null) n++; return n; };
    // floor(40 / 4) = 10 each. a may not borrow while b is due and under its share; c's
    // job becomes due late, and c takes its own share without eating b's floor.
    const first = await spend(a!.id, 100);
    await jobs.enqueueReconciliationJob(c!.id, "SWEEP");
    expect({ a: first, c: await spend(c!.id, 100), b: await spend(b!.id, 9) }).toEqual({ a: 10, c: 10, b: 9 });
    // One short of its floor, b still holds a back; at its floor, a borrows the idle share left.
    expect([await spend(a!.id, 100), await spend(b!.id, 1), await spend(a!.id, 100)]).toEqual([0, 1, 10]);
    expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`).toEqual([{ spent: 40 }]);
  });

  const due = (id: string) => new PostgresReconciliationJobStore(sql).enqueueReconciliationJob(id, "SWEEP");
  const runAfter = (id: string, when: Date) => sql`update repository_reconciliation_jobs set run_after = ${when} where repository_id = ${id}`;
  it.each<[string, (sibling: string, spend: (id: string) => Promise<unknown>) => Promise<unknown>, number]>([
    ["a due re-derivation", (id) => new PostgresReconciliationJobStore(sql).requestRepositoryRederivation(id, at), 10],
    ["a job due at exactly the request's time", async (id) => { await due(id); await runAfter(id, at); }, 10],
    ["a due sibling one request short of its share", async (id, spend) => { await due(id); for (let i = 0; i < 9; i++) await spend(id); }, 10],
    ["a due sibling at its share", async (id, spend) => { await due(id); for (let i = 0; i < 10; i++) await spend(id); }, 20],
    ["a due sibling whose spend is from an earlier window", async (id) => { await due(id); await sql`insert into reconciliation_sweep_repository_spend values (${id}, ${new Date(0)}, 99)`; }, 10],
    ["a repository with no budget-bound job", (id) => new PostgresReconciliationJobStore(sql).enqueueReconciliationJob(id, "WEBHOOK"), 30],
    ["a job not yet due", async (id) => { await due(id); await runAfter(id, new Date(at.getTime() + 1)); }, 30],
    ["a failed job", async (id) => { await due(id); await sql`update repository_reconciliation_jobs set state = 'FAILED' where repository_id = ${id}`; }, 30],
    ["an inactive repository's due job", async (id) => { await due(id); await sql`update registered_repositories set active = false where id = ${id}`; }, 30],
    ["another sponsor's due job", async (id) => { await due(id); await sql`update registered_repositories set sponsor_id = ${await insertSponsor()} where id = ${id}`; }, 30],
  ])("lets a capped repository borrow beside %s only once that sibling holds no unspent due floor", async (_, setup, expected) => {
    // Three active repositories, a share of 10 each; the third stays idle.
    const sponsorId = await insertSponsor();
    const [a, sibling] = await Promise.all(Array.from({ length: 3 }, () => insertRepository(sponsorId)));
    const store = new PostgresSponsorSweepRoundStore(sql, windowMs);
    await setup(sibling!.id, (id) => store.spend(sponsorId, id, at, 30));
    let admitted = 0;
    while (await store.spend(sponsorId, a!.id, at, 30) === null) admitted++;
    expect(admitted).toBe(expected);
  });

  it("counts a repository's share against the round's window, not each request's instant", async () => {
    const sponsorId = await insertSponsor();
    const a = await insertRepository(sponsorId);
    // A due sibling reserves its share of floor(10 / 2) = 5.
    await new PostgresReconciliationJobStore(sql).enqueueReconciliationJob((await insertRepository(sponsorId)).id, "SWEEP");
    const store = new PostgresSponsorSweepRoundStore(sql, windowMs);
    // Production passes a fresh `new Date()` per request: eight distinct instants inside one window.
    const holds = [];
    for (let i = 1; i <= 8; i++) holds.push(await store.spend(sponsorId, a.id, new Date(at.getTime() + i * 1000), 10));
    expect(holds.filter((hold) => hold === null)).toHaveLength(5);
    expect(await sql`select window_start, spent from reconciliation_sweep_repository_spend where repository_id = ${a.id}`).toEqual([{ window_start: new Date(at.getTime() + 1000), spent: 5 }]);
  });

  it("never admits past the sponsor's budget when concurrent repositories race for its last request", async () => {
    const sponsorId = await insertSponsor();
    const [a, b, c] = [await insertRepository(sponsorId), await insertRepository(sponsorId), await insertRepository(sponsorId)];
    await sql`update registered_repositories set active = false where id in ${sql([b.id, c.id])}`;
    const stores = Array.from({ length: 8 }, () => new PostgresSponsorSweepRoundStore(sql, windowMs));
    // Alone, a's share is the whole budget of 10; it spends 9.
    for (let i = 0; i < 9; i++) expect(await stores[0]!.spend(sponsorId, a.id, at, 10)).toBeNull();
    // Two activations drop every share to 3, so only the sponsor's last request binds b and c.
    await sql`update registered_repositories set active = true where id in ${sql([b.id, c.id])}`;
    for (let race = 0; race < 20; race++) {
      await sql`update reconciliation_sweep_rounds set spent = 9 where sponsor_id = ${sponsorId}`;
      await sql`delete from reconciliation_sweep_repository_spend where repository_id in ${sql([b.id, c.id])}`;
      const holds = await Promise.all(Array.from({ length: 8 }, (_, i) => stores[i]!.spend(sponsorId, i % 2 ? b.id : c.id, at, 10)));
      expect(holds.filter((hold) => hold === null)).toHaveLength(1);
      expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`).toEqual([{ spent: 10 }]);
    }
  });

  it("lets every repository of a diff-only sponsor walk within N windows while four older large jobs are due", async () => {
    const budget = 100;
    const sponsorId = await insertSponsor();
    const large = await Promise.all(Array.from({ length: 4 }, () => insertRepository(sponsorId)));
    const small = await insertRepository(sponsorId);
    const repositories = [...large, small];
    const n = repositories.length;
    // Sized well above the per-run overhead: every run spends a verify and a
    // listing page before it can stage a subject, so a share at or below that
    // overhead makes no walk progress under any per-window split.
    const share = Math.floor(budget / n);
    const issueCounts = new Map([...large.map((r) => [r.id, 60] as const), [small.id, 2]]);

    // The sponsor is diff-only, so its REDERIVATION folds are budget-bound too.
    const sizes = new PostgresRepositorySizeStore(sql);
    for (const r of repositories) await sizes.store(r.id, issueCounts.get(r.id)!, at);
    const jobs = new PostgresReconciliationJobStore(sql);
    for (const [index, r] of large.entries()) await (index % 2 === 0 ? jobs.enqueueReconciliationJob(r.id, "SWEEP") : jobs.requestRepositoryRederivation(r.id, at));
    await jobs.enqueueReconciliationJob(small.id, "SWEEP");
    for (const [index, r] of repositories.entries()) await sql`update repository_reconciliation_jobs
      set created_at = ${new Date(Date.parse("2029-12-01T00:00:00Z") + index * 60_000)} where repository_id = ${r.id}`;

    const token = randomBytes(24).toString("hex");
    const store = new PostgresFoldStore(sql);
    store.getGitHubAccessToken = async () => token;
    const gateways = new Map(repositories.map((r) => [r.id, forge(r, issueCounts.get(r.id)!, token)]));
    const rounds = new PostgresSponsorSweepRoundStore(sql, windowMs);
    const passes = new PostgresSweepPassStore(sql);
    let window = 0;
    let clock = at;
    const spends: Array<{ window: number; repositoryId: string; charged: string; admitted: boolean }> = [];
    const stages: Array<{ window: number; repositoryId: string }> = [];
    const completions: Array<{ window: number; repositoryId: string }> = [];
    const sweepFor = (folding: string): ReconciliationSweepControl => ({
      spend: async (sponsor, charged) => {
        const hold = await rounds.spend(sponsor, charged, clock, budget);
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

  it("completes a pass whose listing exceeds the repository's share, and decides absence across the holds", async () => {
    // Four siblings whose due jobs never run keep their floors, so the repository never borrows past floor(50 / 5) = 10.
    const sponsorId = await insertSponsor();
    const [r, ...siblings] = await Promise.all(Array.from({ length: 5 }, () => insertRepository(sponsorId)));
    for (const sibling of siblings) await due(sibling.id);
    const [token, gone, admitted, outcomes] = [randomBytes(24).toString("hex"), new Set<number>(), new Map<number, number>(), [] as string[]];
    const [store, rounds, passes, github] = [new PostgresFoldStore(sql), new PostgresSponsorSweepRoundStore(sql, windowMs), new PostgresSweepPassStore(sql), forge(r!, 60, token, 5, gone)];
    store.getGitHubAccessToken = async () => token;
    let window = 0;
    const now = () => new Date(at.getTime() + window * windowMs);
    const sweep: ReconciliationSweepControl = { discardPass: (id) => passes.discardByRepository(id),
      spend: async (sponsor, charged) => { const hold = await rounds.spend(sponsor, charged, now(), 50); if (hold === null) admitted.set(window, (admitted.get(window) ?? 0) + 1); return hold; },
      openPass: (input) => passes.open(input) };
    // 60 issues at 5 a page: 12 listing pages, more than a held run can list after its verify and walk page.
    for (; window < 40 && !outcomes.includes("done"); window++) {
      // Once a held run has kept absence-listing progress, the last issue, not yet listed again, is deleted.
      if (gone.size === 0 && (await sql`select from reconciliation_sweep_pages where request_key like 'absence-listing:%'`).length > 0) gone.add(60);
      outcomes.push((await reconcileRepository({ store, github, sweep, now, onBudgetChange: () => {} }, r!.id, { reason: "SWEEP" })).skipped ? "held" : "done");
    }
    expect(outcomes.join(" ")).toMatch(/^(held )+done$/);
    expect(outcomes.slice(0, -1).map((_, k) => admitted.get(k))).toEqual(outcomes.slice(0, -1).map(() => 10));
    expect(await sql`select from reconciliation_sweep_repository_spend where repository_id in ${sql(siblings.map(({ id }) => id))}`).toEqual([]);
    // The folded evidence drops only the deleted issue: those listed before a hold stay present.
    expect([gone.size, (await store.getReconciliationEvidence(r!.id))?.issues.map(({ number }) => number)]).toEqual([1, Array.from({ length: 59 }, (_, i) => i + 1)]);
  });
});
