import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresSweepPassStore } from "@/lib/fold/sweep-pass-store";
import { withSweepPass } from "@/lib/fold/sweep-pass";
import { withSweepRequestBudget, SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { PostgresSweepRoundStore } from "@/lib/fold/sweep-round-store";
import { GitHubGraphqlClient, collectCursorPages } from "@/lib/github/graphql";
import { GitHubGateway } from "@/lib/github/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { reconcileRepository } from "@/lib/fold/reconcile";
import { verifiedRepositoryPayload } from "../support/verified-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "passes", user: "passes", password: randomBytes(16).toString("hex") });
  container = started.container; process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql(); await runMigrations();
});
beforeEach(async () => { await sql`delete from reconciliation_sweep_round`; });
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = original;
});

describe("paused full-pass pages", () => {
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
      spend: () => new PostgresSweepRoundStore(sql).spend(clock, 2),
      openPass: new PostgresSweepPassStore(sql).open.bind(new PostgresSweepPassStore(sql)),
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
    const rounds = new PostgresSweepRoundStore(sql);
    const passes = new PostgresSweepPassStore(sql);
    const dependencies = { store: f.store, github, now: () => at, onBudgetChange: () => {},
      sweep: { spend: () => rounds.spend(at, 3), openPass: passes.open.bind(passes) } };
    await reconcileRepository(dependencies, f.repositoryId, { reason: "SWEEP" });
    expect(sent).toBe(2);
    await rounds.spend(at, 3);
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
    const rounds = new PostgresSweepRoundStore(sql);
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
    await expect(withSweepRequestBudget(() => rounds.spend(at, 2), () => withSweepPass(first, async () => {
      await rest.request("/repos/owner/repo/pulls/1");
      await walk();
    }))).rejects.toBeInstanceOf(SweepBudgetSpent);
    const restarted = await new PostgresSweepPassStore(sql).open({ ...input, scanStartedAt: new Date("2030-01-01T06:00:00Z") });
    expect(restarted.id).toBe(first.id);
    expect(restarted.scanStartedAt).toEqual(at);
    await withSweepRequestBudget(() => rounds.spend(new Date("2030-01-01T06:00:00Z"), 2), () => withSweepPass(restarted, async () => {
      const response = await rest.request("/repos/owner/repo/pulls/1");
      expect(response.body).toBe("diff");
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(await walk()).toEqual([1, 2]);
    }));
    expect(cursors).toEqual([null, "page-two"]);
    expect(restReads).toBe(1);
    await restarted.complete();
    expect(await sql`select * from reconciliation_sweep_pages`).toHaveLength(0);
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
