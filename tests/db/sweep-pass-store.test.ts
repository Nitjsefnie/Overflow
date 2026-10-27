import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
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
    const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
    const subjects = f.fold.issues.slice(0, 2).map(({ githubIssueId: id, number }) => ({ id, number, updated_at: at.toISOString() }));
    const github = new GitHubGateway({ accessToken: token, fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/repositories/")) {
        requests.push("verify");
        return Response.json(verifiedRepositoryPayload(repository.githubRepositoryId, repository.ownerName));
      }
      if (url.pathname.endsWith("/issues")) { requests.push("listing"); return Response.json(subjects); }
      if (/\/issues\/\d+\/(events|comments)$/.test(url.pathname)) return Response.json([]);
      const { query, variables } = JSON.parse(String(init?.body));
      if (query.includes("query RepositoryIssue(")) {
        requests.push(`issue-${variables.issueNumber}`);
        const subject = subjects.find(({ number }) => number === variables.issueNumber)!;
        return Response.json({ data: { repository: { issue: {
          databaseId: subject.id, number: subject.number, title: "Walked", body: "", url: "https://example.test/issue",
          state: "OPEN", stateReason: null, createdAt: at.toISOString(), updatedAt: at.toISOString(), closedAt: null,
          author: null, labels: page([]), assignees: { nodes: [] }, timelineItems: page([]), closedByPullRequestsReferences: page([]),
        } } } });
      }
      if (query.includes("query IssueTimelineCounts(")) return Response.json({ data: { repository: Object.fromEntries(
        subjects.filter(({ number }) => variables[`number${number}`] !== undefined)
          .map(({ id, number }) => [`i${number}`, { databaseId: id, timelineItems: { totalCount: 0 } }]),
      ) } });
      throw new Error("Unexpected forge request");
    } });
    let clock = at;
    const sweep = {
      spend: (sponsorId: string, repositoryId: string) => new PostgresSponsorSweepRoundStore(sql).spend(sponsorId, repositoryId, clock, 9),
      openPass: new PostgresSweepPassStore(sql).open.bind(new PostgresSweepPassStore(sql)),
      discardPass: (id: string) => new PostgresSweepPassStore(sql).discardByRepository(id),
    };
    const first = await reconcileRepository({ store: f.store, github, sweep, now: () => clock, onBudgetChange: () => {} }, f.repositoryId, { reason: "SWEEP" });
    expect(first).toMatchObject({ skipped: true, sweepHeldUntil: new Date("2030-01-01T06:00:00Z") });
    expect(await f.store.getReconciliationEvidence(f.repositoryId)).toBeNull();
    expect(await sql`select subject_key from reconciliation_sweep_walk_subjects where pass_id =
      (select pass_id from reconciliation_sweep_passes where repository_id = ${f.repositoryId})`)
      .toEqual([{ subject_key: String(subjects[0]!.id) }]);
    const subject = f.fold.issues[0]!;
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'ISSUE', ${subject.githubIssueId}, ${subject.number})`;
    clock = new Date("2030-01-01T06:00:00Z");
    const resumed = await reconcileRepository({ store: f.store, github, sweep, now: () => clock, onBudgetChange: () => {} }, f.repositoryId, { reason: "SWEEP" });
    expect(resumed.skipped).toBe(false);
    expect(requests).toEqual(["verify", "listing", "issue-1", "issue-2", "verify", "listing", "issue-2", "listing"]);
    expect((await f.store.getReconciliationEvidence(f.repositoryId))?.checkpoint).toEqual(at);
    expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toHaveLength(1);
    expect(await sql`select * from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`).toHaveLength(0);
  });

  it("completes a webhook's dirty work without spending the spent shared round, which still holds a sweep fold", async () => {
    const f = await materializeRepositoryFixture(sql);
    const repository = (await f.store.getRepository(f.repositoryId))!;
    const token = randomBytes(24).toString("hex");
    f.store.getGitHubAccessToken = async () => token;
    let sent = 0;
    const github = new GitHubGateway({ accessToken: token, fetch: async (url) => {
      sent++;
      return Response.json(String(url).endsWith("/graphql")
        ? { data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }
        : new URL(String(url)).pathname.endsWith("/issues") ? []
        : verifiedRepositoryPayload(repository.githubRepositoryId, repository.ownerName));
    } });
    const rounds = new PostgresSponsorSweepRoundStore(sql);
    const passes = new PostgresSweepPassStore(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const dependencies = { store: f.store, github, now: () => at, onBudgetChange: () => {},
      sweep: { spend: () => rounds.spend(sponsorId, f.repositoryId, at, 3), openPass: passes.open.bind(passes), discardPass: passes.discardByRepository.bind(passes) } };
    await reconcileRepository(dependencies, f.repositoryId, { reason: "SWEEP" });
    expect(sent).toBe(3);
    await rounds.spend(sponsorId, f.repositoryId, at, 3);
    await f.store.enqueueReconciliationJob(f.repositoryId, "WEBHOOK");
    // The webhook fold never runs under the sweep request budget, so the
    // spent round neither charges nor holds it: it reads the forge and
    // completes, and the round's spent stays where the sweep fold left it.
    expect(await runNextReconciliationJob({ store: f.store, now: () => at, scheduleLeaseRenewal: () => () => {},
      reconcile: (id, options) => reconcileRepository(dependencies, id, options) })).toBe("RECONCILED");
    expect(sent).toBe(5);
    expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`)
      .toEqual([{ spent: 3 }]);
    // The same spent round still holds a fold that runs under it.
    await f.store.enqueueReconciliationJob(f.repositoryId, "SWEEP");
    expect(await runNextReconciliationJob({ store: f.store, now: () => at, scheduleLeaseRenewal: () => () => {},
      reconcile: (id, options) => reconcileRepository(dependencies, id, options) })).toBe("BUDGET_HELD");
    expect(await sql`select spent from reconciliation_sweep_rounds where sponsor_id = ${sponsorId}`)
      .toEqual([{ spent: 3 }]);
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
    const walk = () => collectCursorPages<number>("issues.nodes", (cursor) => graphql.query("query { issues { nodes } }", { cursor }));
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    await expect(withSweepRequestBudget(() => rounds.spend(sponsorId, f.repositoryId, at, 2), () => withSweepPass(first, async () => {
      await rest.request("/repos/owner/repo/pulls/1");
      await walk();
    }))).rejects.toBeInstanceOf(SweepBudgetSpent);
    const restarted = await new PostgresSweepPassStore(sql).open({ ...input, scanStartedAt: new Date("2030-01-01T06:00:00Z") });
    expect(restarted.id).toBe(first.id);
    expect(restarted.scanStartedAt).toEqual(at);
    await withSweepRequestBudget(() => rounds.spend(sponsorId, f.repositoryId, new Date("2030-01-01T06:00:00Z"), 2), () => withSweepPass(restarted, async () => {
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

describe("durable sweep walk subjects", () => {
  async function openWalk() {
    const f = await materializeRepositoryFixture(sql);
    const input = { repositoryId: f.repositoryId, evidenceVersion: "walk-v1", scanStartedAt: at, dirtySubjects: [] };
    const store = new PostgresSweepPassStore(sql);
    return { ...f, input, store, pass: await store.open(input) };
  }
  const later = new Date("2030-01-02T00:00:00Z");
  const subject = { anchor: "all", kind: "issue" as const, subjectKey: 4_000_000_001, updatedAt: at,
    payload: { title: "staged", nested: { labels: ["M", null], active: true } } };

  it("advances named anchors by timestamp then numeric key without rewinding either stream", async () => {
    const { pass } = await openWalk();
    expect(pass.walkAnchors()).toEqual({});
    await pass.stage({ ...subject, anchor: "issue", subjectKey: 9 });
    await pass.stage({ ...subject, anchor: "pull_request", kind: "pull_request", subjectKey: 30, updatedAt: later });
    await pass.stage({ ...subject, anchor: "issue", subjectKey: 10 });
    await pass.stage({ ...subject, anchor: "issue", subjectKey: 8 });
    await pass.stage({ ...subject, anchor: "issue", subjectKey: 100, updatedAt: new Date("2029-12-31T00:00:00Z") });
    expect(pass.walkAnchors()).toEqual({ issue: { updatedAt: at, key: 10 }, pull_request: { updatedAt: later, key: 30 } });
    await pass.stage({ ...subject, anchor: "issue", subjectKey: 1, updatedAt: later });
    expect(pass.walkAnchors()).toEqual({ issue: { updatedAt: later, key: 1 }, pull_request: { updatedAt: later, key: 30 } });
    expect(await sql`select walk_anchors from reconciliation_sweep_passes where pass_id = ${pass.id}`)
      .toEqual([{ walk_anchors: { issue: { updated_at: later.toISOString(), key: 1 },
        pull_request: { updated_at: later.toISOString(), key: 30 } } }]);
  });

  it.each(["constructor", "__proto__"])("treats %s as an ordinary anchor name", async (anchor) => {
    const { pass, store, input } = await openWalk();
    await pass.stage({ ...subject, anchor });
    expect(pass.walkAnchors()).toEqual({ [anchor]: { updatedAt: at, key: subject.subjectKey } });
    expect((await store.open(input)).walkAnchors()).toEqual(pass.walkAnchors());
  });

  it("round-trips jsonb payloads and bigint keys and replaces a re-staged subject", async () => {
    const { pass } = await openWalk();
    await pass.stage(subject);
    expect(await pass.readStaged()).toEqual([{ kind: "issue", subjectKey: 4_000_000_001, updatedAt: at, payload: subject.payload }]);
    await pass.stage({ ...subject, updatedAt: later, payload: ["replacement", { count: 2 }] });
    await pass.stage({ ...subject, kind: "pull_request", payload: null });
    expect(await pass.readStaged()).toEqual(expect.arrayContaining([
      { kind: "issue", subjectKey: 4_000_000_001, updatedAt: later, payload: ["replacement", { count: 2 }] },
      { kind: "pull_request", subjectKey: 4_000_000_001, updatedAt: at, payload: null },
    ]));
    expect(await pass.readStaged()).toHaveLength(2);
    await pass.stage({ ...subject, payload: { regathered: true } });
    expect(pass.walkAnchors()).toEqual({ all: { updatedAt: later, key: 4_000_000_001 } });
    expect(await pass.readStaged()).toContainEqual({ kind: "issue", subjectKey: 4_000_000_001, updatedAt: at, payload: { regathered: true } });
  });

  it("reopens a held pass with anchors and staged evidence at the same evidence version", async () => {
    const { pass, input } = await openWalk();
    await pass.stage(subject);
    const resumed = await new PostgresSweepPassStore(sql).open({ ...input, scanStartedAt: later });
    expect(resumed.id).toBe(pass.id);
    expect(resumed.scanStartedAt).toEqual(at);
    expect(resumed.walkAnchors()).toEqual({ all: { updatedAt: at, key: 4_000_000_001 } });
    expect(await resumed.readStaged()).toEqual(await pass.readStaged());
  });

  it("loads persisted anchors defensively, including null and independently encoded ISO dates", async () => {
    const { pass, input, store } = await openWalk();
    expect(pass.walkAnchors()).toEqual({});
    await sql`update reconciliation_sweep_passes set walk_anchors = ${sql.json({
      all: { updated_at: "2030-01-01T01:00:00+01:00", key: 42 }, invalid: null,
      badDate: { updated_at: "invalid", key: 1 }, badKey: { updated_at: at.toISOString(), key: "3" },
    })} where pass_id = ${pass.id}`;
    expect((await store.open(input)).walkAnchors()).toEqual({ all: { updatedAt: at, key: 42 } });
  });

  it("uses the locked persisted anchors when a second handle stages from stale state", async () => {
    const { pass, input, store } = await openWalk();
    const second = await store.open(input);
    await pass.stage({ ...subject, anchor: "issue", updatedAt: later });
    await second.stage({ ...subject, anchor: "pull_request", kind: "pull_request" });
    await second.stage({ ...subject, anchor: "issue" });
    expect(second.walkAnchors()).toEqual({ issue: { updatedAt: later, key: subject.subjectKey },
      pull_request: { updatedAt: at, key: subject.subjectKey } });
    expect((await store.open(input)).walkAnchors()).toEqual(second.walkAnchors());
  });

  it("serializes concurrent anchor read-modify-writes without losing either stream", async () => {
    const f = await materializeRepositoryFixture(sql);
    const input = { repositoryId: f.repositoryId, evidenceVersion: "walk-v1", scanStartedAt: at, dirtySubjects: [] };
    const entered = signal(); const release = signal();
    const connection = new Proxy(sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (work: (transaction: TransactionSql) => Promise<unknown>) => target.begin((transaction) =>
        work(new Proxy(transaction, { apply(target, thisArg, args) {
          const query = Reflect.apply(target, thisArg, args);
          if (!String(args[0]).includes("select walk_anchors")) return query;
          return query.then(async (result: unknown) => { entered.resolve(); await release.promise; return result; });
        } })));
    } });
    const first = await new PostgresSweepPassStore(connection).open(input);
    const second = await new PostgresSweepPassStore(sql).open(input);
    const stagedFirst = first.stage({ ...subject, anchor: "issue" });
    await entered.promise;
    let finished = false;
    const stagedSecond = second.stage({ ...subject, anchor: "pull_request", kind: "pull_request" })
      .finally(() => { finished = true; });
    try {
      // Observe the second transaction waiting (or finishing on the unlocked mutant)
      // before releasing the first reader; no wall-clock ordering assumption.
      await vi.waitFor(async () => {
        const [waiting] = await sql<{ count: number }[]>`select count(*)::int as count
          from pg_stat_activity a join pg_locks l on l.pid = a.pid and not l.granted
          where a.datname = current_database() and a.wait_event_type = 'Lock'
            and a.pid <> pg_backend_pid()`;
        expect(finished || waiting.count > 0).toBe(true);
      });
    } finally { release.resolve(); await Promise.all([stagedFirst, stagedSecond]); }
    const resumed = await new PostgresSweepPassStore(sql).open(input);
    expect(resumed.walkAnchors()).toEqual({ issue: { updatedAt: at, key: subject.subjectKey },
      pull_request: { updatedAt: at, key: subject.subjectKey } });
    expect(await resumed.readStaged()).toHaveLength(2);
  });

  it("fulfills both concurrent stages when their FK inserts precede parent locking", async () => {
    const { input, store } = await openWalk();
    const bothInserted = signal();
    let inserted = 0;
    const connection = new Proxy(sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (work: (transaction: TransactionSql) => Promise<unknown>) => target.begin((transaction) =>
        work(new Proxy(transaction, { apply(target, thisArg, args) {
          const query = Reflect.apply(target, thisArg, args);
          if (!String(args[0]).includes("insert into reconciliation_sweep_walk_subjects")) return query;
          return query.then(async (result: unknown) => {
            // Both FK key-share locks exist before either parent-lock request.
            if (++inserted === 2) bothInserted.resolve();
            await bothInserted.promise;
            return result;
          });
        } })));
    } });
    const first = await new PostgresSweepPassStore(connection).open(input);
    const second = await new PostgresSweepPassStore(connection).open(input);
    const outcomes = await Promise.allSettled([
      first.stage({ ...subject, anchor: "issue" }),
      second.stage({ ...subject, anchor: "pull_request", kind: "pull_request", subjectKey: 2 }),
    ]);
    expect(inserted).toBe(2);
    expect(outcomes.map((outcome) => outcome.status === "fulfilled" ? { status: outcome.status }
      : { status: outcome.status, code: outcome.reason.code })).toEqual([{ status: "fulfilled" }, { status: "fulfilled" }]);
    const resumed = await store.open(input);
    expect(resumed.walkAnchors()).toEqual({ issue: { updatedAt: at, key: subject.subjectKey },
      pull_request: { updatedAt: at, key: 2 } });
    expect(await resumed.readStaged()).toHaveLength(2);
  });

  it("rolls back the staged row and anchor together when the anchor write fails", async () => {
    const { pass, store, input } = await openWalk();
    await pass.stage(subject);
    await expect(pass.stage({ ...subject, anchor: "invalid\u0000anchor", updatedAt: later, payload: "uncommitted" })).rejects.toThrow();
    expect(pass.walkAnchors()).toEqual({ all: { updatedAt: at, key: subject.subjectKey } });
    expect((await store.open(input)).walkAnchors()).toEqual(pass.walkAnchors());
    expect(await pass.readStaged()).toEqual([{ kind: "issue", subjectKey: subject.subjectKey, updatedAt: at, payload: subject.payload }]);
  });

  it("publishes in-memory anchors only after the staging transaction commits", async () => {
    const f = await materializeRepositoryFixture(sql);
    const entered = signal(); const release = signal();
    let hold = false;
    const connection = new Proxy(sql, { get(target, property, receiver) {
      if (property !== "begin") return Reflect.get(target, property, receiver);
      return (work: (transaction: TransactionSql) => Promise<unknown>) => target.begin(async (transaction) => {
        const result = await work(transaction);
        if (hold) { entered.resolve(); await release.promise; }
        return result;
      });
    } });
    const pass = await new PostgresSweepPassStore(connection).open({ repositoryId: f.repositoryId,
      evidenceVersion: "walk-v1", scanStartedAt: at, dirtySubjects: [] });
    hold = true;
    const staged = pass.stage(subject);
    try {
      await entered.promise;
      expect(pass.walkAnchors()).toEqual({});
      expect(await pass.readStaged()).toEqual([]);
    } finally { release.resolve(); await staged; }
    expect(pass.walkAnchors()).toEqual({ all: { updatedAt: at, key: subject.subjectKey } });
    expect(await pass.readStaged()).toHaveLength(1);
  });

  it("deletes exactly the named kind and key within the current pass", async () => {
    const { pass } = await openWalk();
    const other = (await openWalk()).pass;
    await pass.stage(subject);
    await pass.stage({ ...subject, kind: "pull_request" });
    await pass.stage({ ...subject, subjectKey: 2 });
    await other.stage(subject);
    await pass.deleteStaged([]);
    expect(await pass.readStaged()).toHaveLength(3);
    await pass.deleteStaged([{ kind: "issue", subjectKey: subject.subjectKey }, { kind: "pull_request", subjectKey: 2 }]);
    expect(await pass.readStaged()).toEqual(expect.arrayContaining([
      { kind: "issue", subjectKey: 2, updatedAt: at, payload: subject.payload },
      { kind: "pull_request", subjectKey: subject.subjectKey, updatedAt: at, payload: subject.payload },
    ]));
    expect(await pass.readStaged()).toHaveLength(2);
    expect(await other.readStaged()).toHaveLength(1);
    expect(pass.walkAnchors()).toEqual({ all: { updatedAt: at, key: subject.subjectKey } });
  });

  it.each(["complete", "discardByRepository", "new evidence version"])("cascades staged evidence on %s and preserves other passes", async (action) => {
    const { pass, input, store } = await openWalk();
    const other = (await openWalk()).pass;
    await pass.stage(subject); await other.stage(subject);
    expect(await pass.readStaged()).toHaveLength(1);
    if (action === "complete") await pass.complete();
    else if (action === "discardByRepository") await store.discardByRepository(input.repositoryId);
    else {
      const fresh = await store.open({ ...input, evidenceVersion: "walk-v2" });
      expect(fresh.id).not.toBe(pass.id);
      expect(fresh.walkAnchors()).toEqual({});
      expect(await fresh.readStaged()).toEqual([]);
    }
    expect(await sql`select * from reconciliation_sweep_walk_subjects where pass_id = ${pass.id}`).toEqual([]);
    expect(await other.readStaged()).toHaveLength(1);
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
    walkReconciliation: async (reference) => {
      await github.listIssues(reference);
      throw new Error("The paused fixture must hold or reject");
    },
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
