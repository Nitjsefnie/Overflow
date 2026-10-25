import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresSweepPassStore } from "@/lib/fold/sweep-pass-store";
import { checkpointSweepRequest, withSweepPass, type SweepPass } from "@/lib/fold/sweep-pass";
import { withSweepRequestBudget, SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { PostgresSponsorSweepRoundStore } from "@/lib/fold/sponsor-sweep-round-store";
import { GitHubGraphqlClient, collectCursorPages } from "@/lib/github/graphql";
import { GitHubGateway } from "@/lib/github/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { verifiedRepositoryPayload } from "../support/verified-repository";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "passes", user: "passes", password: randomBytes(16).toString("hex") });
  container = started.container; process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql(); await runMigrations();
});
beforeEach(async () => {
  await sql`delete from reconciliation_sweep_round`;
  await sql`delete from reconciliation_sweep_rounds`;
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

describe("paused full-pass pages", () => {
  it.each(["RECONCILIATION_SWEEP_PAGE_CEILING", "OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING"])("reads the page ceiling from %s when no override is supplied", async (name) => {
    const previous = process.env.OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING;
    try {
      vi.stubEnv("OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING", undefined);
      vi.stubEnv("RECONCILIATION_SWEEP_PAGE_CEILING", "3");
      vi.stubEnv(name, "2");
      const f = await materializeRepositoryFixture(sql);
      const pass = await new PostgresSweepPassStore(sql).open({ repositoryId: f.repositoryId,
        evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] });
      await pass.write("first", { page: 1 });
      await pass.write("second", { page: 2 });
      await pass.write("third", { page: 3 });
      expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
      expect(await pass.read("third")).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      if (previous === undefined) delete process.env.OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING;
      else process.env.OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING = previous;
    }
  });

  it("keeps concurrent checkpoint writes within the ceiling and returns every fetched payload", async () => {
    const f = await materializeRepositoryFixture(sql);
    const pass = await new PostgresSweepPassStore(sql, 2).open({ repositoryId: f.repositoryId,
      evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] });
    const payloads = await withSweepPass(pass, () => Promise.all([1, 2, 3].map((page) =>
      checkpointSweepRequest({ page }, async () => ({ page })))));
    expect(payloads).toEqual([{ page: 1 }, { page: 2 }, { page: 3 }]);
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
  });

  it("rejects a failed write without blocking later writes or spending their capacity", async () => {
    const f = await materializeRepositoryFixture(sql);
    const pass = await new PostgresSweepPassStore(sql, 2).open({ repositoryId: f.repositoryId,
      evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] });
    const results = await Promise.allSettled([
      pass.write("failed", { page: 0 }, "invalid\u0000cursor"),
      pass.write("first", { page: 1 }, "cursor-one"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    await pass.write("second", { page: 2 }, "cursor-two");
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
    expect(await pass.read("failed")).toBeUndefined();
    expect(await pass.read("first")).toEqual({ page: 1 });
    expect(await pass.read("second")).toEqual({ page: 2 });
    expect(await sql`select walk_cursor from reconciliation_sweep_passes where pass_id = ${pass.id}`)
      .toEqual([{ walk_cursor: "cursor-two" }]);
  });

  it("stops storing at the ceiling and replays the stored pair on reopen", async () => {
    const f = await materializeRepositoryFixture(sql);
    const input = { repositoryId: f.repositoryId, evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] };
    const pass = await new PostgresSweepPassStore(sql, 2).open(input);
    await pass.write("first", { page: 1 }, "cursor-one");
    await pass.write("second", { page: 2 }, "cursor-two");
    await pass.write("third", { page: 3 }, "cursor-three");
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
    expect(await pass.read("first")).toEqual({ page: 1 });
    expect(await pass.read("second")).toEqual({ page: 2 });
    expect(await pass.read("third")).toBeUndefined();
    expect(await sql`select walk_cursor from reconciliation_sweep_passes where pass_id = ${pass.id}`)
      .toEqual([{ walk_cursor: "cursor-two" }]);
    const reopened = await new PostgresSweepPassStore(sql, 2).open(input);
    expect(reopened.id).toBe(pass.id);
    expect(await reopened.read("first")).toEqual({ page: 1 });
    expect(await reopened.read("second")).toEqual({ page: 2 });
    await reopened.write("fourth", { page: 4 });
    expect(await reopened.read("fourth")).toBeUndefined();
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
  });

  it("releases an over-ceiling pass on open and stores new pages", async () => {
    const f = await materializeRepositoryFixture(sql);
    const input = { repositoryId: f.repositoryId, evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] };
    const old = await new PostgresSweepPassStore(sql, 3).open(input);
    await old.write("first", { page: 1 });
    await old.write("second", { page: 2 });
    await old.write("third", { page: 3 });
    expect(await stagedCounts(f.repositoryId, old.id)).toEqual({ passes: 1, pages: 3 });
    const pass = await new PostgresSweepPassStore(sql, 2).open(input);
    expect(pass.id).toBe(old.id);
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 0 });
    expect(await pass.read("first")).toBeUndefined();
    await pass.write("new-first", { page: 4 });
    await pass.write("new-second", { page: 5 });
    await pass.write("new-third", { page: 6 });
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
    expect(await pass.read("new-first")).toEqual({ page: 4 });
    expect(await pass.read("new-second")).toEqual({ page: 5 });
    expect(await pass.read("new-third")).toBeUndefined();
  });

  it("keeps each repository pass's ceiling independent", async () => {
    const store = new PostgresSweepPassStore(sql, 2);
    for (const f of [await materializeRepositoryFixture(sql), await materializeRepositoryFixture(sql)]) {
      const pass = await store.open({ repositoryId: f.repositoryId, evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] });
      await pass.write("first", { page: 1 });
      await pass.write("second", { page: 2 });
      await pass.write("third", { page: 3 });
      expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
      expect(await pass.read("first")).toEqual({ page: 1 });
      expect(await pass.read("second")).toEqual({ page: 2 });
      expect(await pass.read("third")).toBeUndefined();
    }
  });

  it("does not spend ceiling capacity or advance the cursor on a duplicate write", async () => {
    const f = await materializeRepositoryFixture(sql);
    const pass = await new PostgresSweepPassStore(sql, 2).open({ repositoryId: f.repositoryId,
      evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] });
    await pass.write("first", { page: 1 }, "cursor-one");
    await pass.write("first", { page: 99 }, "duplicate-cursor");
    expect(await sql`select walk_cursor from reconciliation_sweep_passes where pass_id = ${pass.id}`)
      .toEqual([{ walk_cursor: "cursor-one" }]);
    await pass.write("second", { page: 2 }, "cursor-two");
    await pass.write("third", { page: 3 }, "cursor-three");
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
    expect(await pass.read("first")).toEqual({ page: 1 });
    expect(await pass.read("second")).toEqual({ page: 2 });
    expect(await pass.read("third")).toBeUndefined();
  });

  it("completes a capped pass by deleting the pass and its pages", async () => {
    const f = await materializeRepositoryFixture(sql);
    const pass = await new PostgresSweepPassStore(sql, 2).open({ repositoryId: f.repositoryId,
      evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] });
    await pass.write("first", { page: 1 });
    await pass.write("second", { page: 2 });
    await pass.write("third", { page: 3 });
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 1, pages: 2 });
    await pass.complete();
    expect(await stagedCounts(f.repositoryId, pass.id)).toEqual({ passes: 0, pages: 0 });
  });

  it("disposes paused pass pages on coordinated unregistration and inactive completion", async () => {
    const f = await pausedFixture();
    expect(await stagedCounts(f.repositoryId, f.state.pass!.id)).toEqual({ passes: 1, pages: 1 });
    expect((await new PostgresRepositoryStore(sql).unregisterRepository(f.registration)).kind).toBe("UNREGISTERED");
    const afterUnregister = await stagedCounts(f.repositoryId, f.state.pass!.id);
    expect((await reconcileRepository(f.dependencies, f.repositoryId, { reason: "SWEEP" })).skipped).toBe(false);
    expect(afterUnregister).toEqual({ passes: 0, pages: 0 });
    expect(await stagedCounts(f.repositoryId, f.state.pass!.id)).toEqual({ passes: 0, pages: 0 });
    expect(f.state.opens).toBe(1);
  });

  it("discards by repository on inactive completion without opening another pass", async () => {
    const f = await pausedFixture();
    await sql`update registered_repositories set active = false where id = ${f.repositoryId}`;
    expect((await reconcileRepository(f.dependencies, f.repositoryId, { reason: "SWEEP" })).skipped).toBe(false);
    expect(await stagedCounts(f.repositoryId, f.state.pass!.id)).toEqual({ passes: 0, pages: 0 });
    expect(f.state.opens).toBe(1);
  });

  it("leaves an in-flight fold's pages intact until its coordinated ordinary-failure cleanup", async () => {
    const f = await pausedFixture();
    const entered = signal(); const release = signal();
    f.github.listIssues = async () => {
      await f.state.pass!.write("second", { text: "in-flight page" });
      entered.resolve(); await release.promise;
      await f.state.pass!.write("after-unregister", { text: "still owned by the fold" });
      throw new Error("synthetic upstream failure");
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const settled = reconcileRepository(f.dependencies, f.repositoryId, { reason: "SWEEP" }).then(() => false, () => true);
    try {
      await entered.promise;
      expect((await new PostgresRepositoryStore(sql).unregisterRepository(f.registration)).kind).toBe("UNREGISTERED");
      expect(await stagedCounts(f.repositoryId, f.state.pass!.id)).toEqual({ passes: 1, pages: 2 });
      expect(await f.state.pass!.read("first")).toEqual({ text: "paused page" });
    } finally {
      release.resolve(); await settled; log.mockRestore();
    }
    expect(await settled).toBe(true);
    expect(await stagedCounts(f.repositoryId, f.state.pass!.id)).toEqual({ passes: 0, pages: 0 });
  });

  it("resumes a full fold without publishing a partial walk or consuming newer dirty work", async () => {
    const f = await materializeRepositoryFixture(sql);
    const repository = (await f.store.getRepository(f.repositoryId))!;
    const token = randomBytes(24).toString("hex");
    f.store.getGitHubAccessToken = async () => token;
    const requests: string[] = [];
    const github = new GitHubGateway({ accessToken: token, fetch: async (url, init) => {
      if (!String(url).endsWith("/graphql")) {
        requests.push("verify");
        return Response.json(verifiedRepositoryPayload(repository.githubRepositoryId, repository.ownerName));
      }
      const cursor = JSON.parse(String(init?.body)).variables.cursor;
      requests.push(cursor ?? "first-page");
      return Response.json({ data: { repository: { issues: { nodes: [],
        pageInfo: { hasNextPage: cursor === null, endCursor: cursor === null ? "next-page" : null } } } } });
    } });
    let clock = at;
    const sweep = {
      spend: () => new PostgresSponsorSweepRoundStore(sql).spend(repository.sponsor.id, clock, 2),
      openPass: new PostgresSweepPassStore(sql).open.bind(new PostgresSweepPassStore(sql)),
      discardPass: (id: string) => new PostgresSweepPassStore(sql).discardByRepository(id),
    };
    const first = await reconcileRepository({ store: f.store, github, sweep, now: () => clock, onBudgetChange: () => {} }, f.repositoryId, { reason: "SWEEP" });
    expect(first).toMatchObject({ skipped: true, sweepHeldUntil: new Date("2030-01-01T06:00:00Z") });
    expect(await f.store.getReconciliationEvidence(f.repositoryId)).toBeNull();
    expect(await sql`select walk_cursor from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`)
      .toEqual([{ walk_cursor: "next-page" }]);
    const subject = f.fold.issues[0]!;
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'ISSUE', ${subject.githubIssueId}, ${subject.number})`;
    clock = new Date("2030-01-01T06:00:00Z");
    const resumed = await reconcileRepository({ store: f.store, github, sweep, now: () => clock, onBudgetChange: () => {} }, f.repositoryId, { reason: "SWEEP" });
    expect(resumed.skipped).toBe(false);
    expect(requests).toEqual(["verify", "first-page", "verify", "next-page"]);
    expect((await f.store.getReconciliationEvidence(f.repositoryId))?.checkpoint).toEqual(at);
    expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toHaveLength(1);
    expect(await sql`select * from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`).toHaveLength(0);
  });

  it("holds a webhook's dirty work and refunds its job attempt when the shared round is spent", async () => {
    const f = await materializeRepositoryFixture(sql);
    const repository = (await f.store.getRepository(f.repositoryId))!;
    const token = randomBytes(24).toString("hex");
    f.store.getGitHubAccessToken = async () => token;
    let sent = 0;
    const github = new GitHubGateway({ accessToken: token, fetch: async (url) => {
      sent++;
      return Response.json(String(url).endsWith("/graphql")
        ? { data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }
        : verifiedRepositoryPayload(repository.githubRepositoryId, repository.ownerName));
    } });
    const rounds = new PostgresSponsorSweepRoundStore(sql);
    const passes = new PostgresSweepPassStore(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const dependencies = { store: f.store, github, now: () => at, onBudgetChange: () => {},
      sweep: { spend: () => rounds.spend(sponsorId, at, 3), openPass: passes.open.bind(passes), discardPass: passes.discardByRepository.bind(passes) } };
    await reconcileRepository(dependencies, f.repositoryId, { reason: "SWEEP" });
    expect(sent).toBe(2);
    await rounds.spend(sponsorId, at, 3);
    const issue = f.fold.issues[0]!;
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'ISSUE', ${issue.githubIssueId}, ${issue.number})`;
    await f.store.enqueueReconciliationJob(f.repositoryId, "WEBHOOK");
    expect(await runNextReconciliationJob({ store: f.store, now: () => at, scheduleLeaseRenewal: () => () => {},
      reconcile: (id, options) => reconcileRepository(dependencies, id, options) })).toBe("BUDGET_HELD");
    expect(sent).toBe(2);
    expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toHaveLength(1);
    expect(await sql`select state, attempt_count, run_after from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`)
      .toEqual([{ state: "PENDING", attempt_count: 0, run_after: new Date("2030-01-01T06:00:00Z") }]);
  });

  it("continues unread REST and GraphQL pages after budget exhaustion and a process restart", async () => {
    const f = await materializeRepositoryFixture(sql);
    const input = { repositoryId: f.repositoryId, evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: [] };
    const rounds = new PostgresSponsorSweepRoundStore(sql);
    const cursors: unknown[] = [];
    const graphql = new GitHubGraphqlClient({ accessToken: randomBytes(24).toString("hex"), fetch: async (_url, init) => {
      const cursor = JSON.parse(String(init?.body)).variables.cursor;
      cursors.push(cursor);
      return Response.json({ data: { nodes: [cursor === null ? 1 : 2], pageInfo: { hasNextPage: cursor === null, endCursor: cursor === null ? "page-two" : null } } });
    } });
    let restReads = 0;
    const rest = new GitHubGateway({ accessToken: randomBytes(24).toString("hex"), fetch: async () => {
      restReads++; return new Response("diff", { headers: { "content-type": "text/plain" } });
    } });
    const first = await new PostgresSweepPassStore(sql).open(input);
    const walk = () => collectCursorPages<number>((cursor) => graphql.query("query { issues { nodes } }", { cursor }));
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    await expect(withSweepRequestBudget(() => rounds.spend(sponsorId, at, 2), () => withSweepPass(first, async () => {
      await rest.request("/repos/owner/repo/pulls/1");
      await walk();
    }))).rejects.toBeInstanceOf(SweepBudgetSpent);
    const restarted = await new PostgresSweepPassStore(sql).open({ ...input, scanStartedAt: new Date("2030-01-01T06:00:00Z") });
    expect(restarted.id).toBe(first.id);
    expect(restarted.scanStartedAt).toEqual(at);
    await withSweepRequestBudget(() => rounds.spend(sponsorId, new Date("2030-01-01T06:00:00Z"), 2), () => withSweepPass(restarted, async () => {
      const response = await rest.request("/repos/owner/repo/pulls/1");
      expect(response.body).toBe("diff");
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(await walk()).toEqual([1, 2]);
    }));
    expect(cursors).toEqual([null, "page-two"]);
    expect(restReads).toBe(1);
    await restarted.complete();
    expect(await sql`select * from reconciliation_sweep_pages where pass_id = ${restarted.id}`).toHaveLength(0);
  });

  it("checkpoints PostgreSQL-safe forge strings before returning or replaying a page", async () => {
    const f = await materializeRepositoryFixture(sql);
    const pass = await new PostgresSweepPassStore(sql).open({ repositoryId: f.repositoryId,
      evidenceVersion: "text", scanStartedAt: at, dirtySubjects: [] });
    const client = new GitHubGraphqlClient({ accessToken: randomBytes(24).toString("hex"),
      fetch: async () => Response.json({ data: { value: "before\u0000after" } }) });
    await withSweepPass(pass, async () => {
      expect(await client.query("query { value }", {})).toEqual({ value: "before\uFFFDafter" });
      expect(await client.query("query { value }", {})).toEqual({ value: "before\uFFFDafter" });
    });
    await pass.complete();
  });

  it("invalidates pages after an intervening evidence publication and keeps newer dirty generations", async () => {
    const f = await materializeRepositoryFixture(sql);
    const store = new PostgresSweepPassStore(sql);
    const dirty = [{ kind: "ISSUE" as const, id: 1, number: 1, generation: 1 }];
    const first = await store.open({ repositoryId: f.repositoryId, evidenceVersion: "v1", scanStartedAt: at, dirtySubjects: dirty });
    const same = await store.open({ repositoryId: f.repositoryId, evidenceVersion: "v1", scanStartedAt: new Date("2030-01-01T06:00:00Z"), dirtySubjects: [{ ...dirty[0]!, generation: 2 }] });
    expect(same.dirtySubjects).toEqual(dirty);
    const fresh = await store.open({ repositoryId: f.repositoryId, evidenceVersion: "v2", scanStartedAt: at, dirtySubjects: [] });
    expect(fresh.id).not.toBe(first.id);
    await first.complete();
    expect((await sql`select pass_id from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`)[0]!.pass_id).toBe(fresh.id);
  });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function stagedCounts(repositoryId: string, passId: string) {
  const [counts] = await sql<{ passes: number; pages: number }[]>`select
    (select count(*)::int from reconciliation_sweep_passes where repository_id = ${repositoryId}) as passes,
    (select count(*)::int from reconciliation_sweep_pages where pass_id = ${passId}) as pages`;
  return counts;
}

async function pausedFixture() {
  const f = await materializeRepositoryFixture(sql);
  const repository = (await f.store.getRepository(f.repositoryId))!;
  f.store.getGitHubAccessToken = async () => randomBytes(24).toString("hex");
  const passes = new PostgresSweepPassStore(sql);
  const state = { pass: null as SweepPass | null, opens: 0 };
  const github: ReconciliationGateway = {
    getRepositoryById: verifiedRepositoryAt(repository.ownerName),
    listIssues: async () => {
      await state.pass!.write("first", { text: "paused page" }, "next-page");
      throw new SweepBudgetSpent(new Date("2030-01-01T06:00:00Z"));
    },
    getIssue: async () => null, getPullRequestClosingIssues: async () => [],
    getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
  };
  const dependencies = { store: f.store, github, now: () => at, onBudgetChange: () => {}, sweep: {
    spend: async () => null,
    openPass: async (input: Parameters<PostgresSweepPassStore["open"]>[0]) => {
      state.opens++; state.pass = await passes.open(input); return state.pass;
    },
    discardPass: (id: string) => passes.discardByRepository(id),
  } };
  expect((await reconcileRepository(dependencies, f.repositoryId, { reason: "SWEEP" })).skipped).toBe(true);
  return { ...f, github, state, dependencies,
    registration: { ownerName: repository.ownerName, sponsorId: repository.sponsor.id, provider: "github" as const } };
}
