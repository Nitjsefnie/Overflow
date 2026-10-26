import { disappearingGitLabFixture } from "../support/reconciliation-walk-gitlab";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { GitHubApiError } from "@/lib/github/errors";
import { sponsorGateway } from "@/lib/fold/reconcile-as-sponsor";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { getSql, closeSql } from "@/lib/db/client";
import { PostgresSweepPassStore } from "@/lib/fold/sweep-pass-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { walkReconciliation } from "@/lib/fold/reconciliation-walk";
import { checkSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { RECONCILIATION_EVIDENCE_FORMAT } from "@/lib/fold/reconciliation-evidence";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { startPostgresContainer } from "../support/postgres-container";
import { issue, pullRequest } from "./reconciliation-walk-fixture";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "walk_integration", user: "walk_integration" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  execFileSync("pnpm", ["db:migrate"], { env: { ...process.env, OVERFLOW_DATABASE_URL: started.databaseUrl, OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD: "skip" }, stdio: "pipe" });
  sql = getSql();
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

async function fixture(factByteLimit?: number) {
  const f = await materializeRepositoryFixture(sql);
  if (factByteLimit !== undefined) f.store = new PostgresFoldStore(sql, undefined, undefined, undefined, { reconciliationFactByteLimit: factByteLimit });
  const repository = (await f.store.getRepository(f.repositoryId))!;
  f.store.getGitHubAccessToken = async () => randomBytes(16).toString("hex");
  const facts = [issue(f.fold.issues[0]!.githubIssueId), issue(f.fold.issues[1]!.githubIssueId)];
  for (const fact of facts) fact.updatedAt = at.toISOString();
  const passes = new PostgresSweepPassStore(sql, 1);
  const state = { limit: Infinity, spent: 0, clock: at, bumpVersion: false, prFailure: null as Error | null, rawDiff: "" };
  const reads: number[] = [];
  const gateway: ReconciliationGateway = {
    getRepositoryById: async (id) => { await checkSweepRequestBudget(); return verifiedRepositoryAt(repository.ownerName)(id); },
    listIssues: vi.fn(async () => structuredClone(facts)),
    getIssue: async (subject) => { void subject; throw new Error("Incremental issue read was unexpected"); },
    getPullRequestClosingIssues: async () => [], getPullRequestReviews: async () => [], getPullRequestDiff: async () => state.rawDiff,
    walkReconciliation: vi.fn(async (_reference, input) => walkReconciliation({ ...input,
      listing: { kind: "cursor", listPage: async () => {
        await checkSweepRequestBudget();
        return { subjects: facts.map(({ id, number, updatedAt }) => ({ kind: "issue" as const, id, number, updatedAt: new Date(updatedAt) })), nextCursor: null };
      } },
      gateway: {
        gatherIssue: async ({ id }) => {
          await checkSweepRequestBudget(); reads.push(id);
          if (state.bumpVersion) {
            state.bumpVersion = false;
            await sql`update repository_reconciliation_evidence set version = version + 1 where repository_id = ${f.repositoryId}`;
          }
          return structuredClone(facts.find((fact) => fact.id === id)!);
        },
        getPullRequest: async () => null, getPullRequestClosingIssues: async () => [],
        getPullRequestReviews: async () => { if (state.prFailure !== null) throw state.prFailure; return []; },
        getPullRequestDiff: async () => state.rawDiff,
      },
    })),
  };
  const materialize = vi.spyOn(f.store, "materialize");
  const sweep = { spend: vi.fn(async () => state.spent++ < state.limit ? null : new Date(+at + 60_000)),
    openPass: passes.open.bind(passes), discardPass: passes.discardByRepository.bind(passes) };
  const run = (reason?: "SWEEP" | "WEBHOOK") => {
    state.spent = 0;
    return reconcileRepository({ store: f.store, github: gateway, sweep, now: () => state.clock, onBudgetChange: () => {} },
      f.repositoryId, reason === undefined ? undefined : { reason });
  };
  return { ...f, repository, facts, passes, state, gateway, materialize, sweep, reads, run };
}

describe("a budget-bound reconciliation walk", () => {
  it("publishes the legacy fact shape when separate PR facts fit but their sum exceeds the limit", async () => {
    const limit = 5000;
    const f = await fixture(limit);
    f.state.rawDiff = "d".repeat(3000);
    const prs = [pullRequest(901, f.repository.githubRepositoryId), pullRequest(902, f.repository.githubRepositoryId)];
    f.facts[0]!.body = "Fresh issue body reaches the publisher before narrowing";
    f.facts[0]!.closingPullRequests = prs;
    f.facts[1]!.closingPullRequests = [prs[0]!];
    const storedFacts = () => sql<{ kind: string; subject_key: string; payload: Record<string, unknown> }[]>`
      select kind, subject_key, payload from repository_reconciliation_evidence_facts
      where repository_id = ${f.repositoryId} order by kind, subject_key`;
    await reconcileRepository({ store: f.store, github: f.gateway, now: () => at, onBudgetChange: () => {} }, f.repositoryId);
    const legacy = await storedFacts();
    const prBytes = legacy.filter(({ kind }) => kind === "pull_request").map(({ payload }) => Buffer.byteLength(JSON.stringify(payload)));
    expect(prBytes).toHaveLength(2);
    expect(prBytes.every((bytes) => bytes < limit)).toBe(true);
    expect(prBytes.reduce((sum, bytes) => sum + bytes, 0)).toBeGreaterThan(limit);
    expect((await f.store.getReconciliationEvidence(f.repositoryId))?.omittedOversizedFacts).toBe(0);

    await f.run("SWEEP");
    const walked = await storedFacts();
    const cache = await f.store.getReconciliationEvidence(f.repositoryId);
    const published = f.materialize.mock.calls[1]![0].synchronization!;
    const next = await f.run("WEBHOOK");
    expect(cache?.omittedOversizedFacts).toBe(0);
    expect(walked).toEqual(legacy);
    expect(published.issues).toEqual(f.facts);
    expect(published.issues[0]).toMatchObject({ body: "Fresh issue body reaches the publisher before narrowing" });
    expect(published.pullRequests).toEqual(prs.map(({ id }) => ({ id, reviews: [], rawDiff: f.state.rawDiff })));
    expect(next).toMatchObject({ skipped: false });
    expect(f.materialize.mock.calls[2]?.[0].synchronization?.full).toBe(false);
  });

  it.each(["closing", "diff"] as const)("retains a held pass's staged issue when an ordinary GitLab MR disappears during %s", async (phase) => {
    const f = await fixture();
    const name = `project-${f.repository.githubRepositoryId}`;
    const gl = disappearingGitLabFixture(phase, { repositoryId: f.repository.githubRepositoryId, name });
    f.store.getRepository = async () => ({ ...f.repository, provider: "gitlab", instanceUrl: "https://gitlab.test" });
    f.gateway.walkReconciliation = (reference, input) => gl.gateway.walkReconciliation(reference, input);
    // The adapter transport fixture uses the freshly verified path below.
    f.gateway.getRepositoryById = async (id) => { await checkSweepRequestBudget(); return verifiedRepositoryAt(`group/${name}`)(id); };
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'PULL_REQUEST', 901, 7)`;
    const opened: string[] = [];
    f.sweep.openPass = async (input) => { const pass = await f.passes.open(input); opened.push(pass.id); return pass; };
    f.state.limit = 6;
    expect(await f.run("SWEEP")).toMatchObject({ skipped: true, sweepHeldUntil: new Date(+at + 60_000) });
    expect(await sql`select subject_key from reconciliation_sweep_walk_subjects where pass_id = ${opened[0]!}`).toEqual([{ subject_key: "101" }]);
    expect(f.materialize).not.toHaveBeenCalled();
    f.state.limit = Infinity;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { expect((await f.run("SWEEP")).skipped).toBe(false); } finally { log.mockRestore(); }
    expect(opened).toEqual([opened[0], opened[0]]);
    expect(gl.paths.filter((path) => path === "/issues/1")).toHaveLength(1);
    expect((await f.store.getReconciliationEvidence(f.repositoryId))?.issues.map(({ id }) => id)).toEqual([101]);
    expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toEqual([]);
    expect(f.materialize).toHaveBeenCalledOnce();
  });

  it("holds without materializing, then resumes to completion with the original checkpoint and dirty snapshot", async () => {
    const f = await fixture();
    const before = await sql`select id from issues where repository_id = ${f.repositoryId} order by id`;
    f.state.limit = 3;
    expect(await f.run("SWEEP")).toMatchObject({ skipped: true, sweepHeldUntil: new Date(+at + 60_000) });
    expect(f.materialize).not.toHaveBeenCalled();
    expect(f.gateway.listIssues).not.toHaveBeenCalled();
    expect(await sql`select id from issues where repository_id = ${f.repositoryId} order by id`).toEqual(before);
    const [pass] = await sql`select pass_id from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`;
    expect(await sql`select subject_key from reconciliation_sweep_walk_subjects where pass_id = ${pass!.pass_id}`).toHaveLength(1);
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'ISSUE', ${f.facts[0]!.id}, ${f.facts[0]!.number})`;
    f.state.clock = new Date(+at + 60_000); f.state.limit = Infinity;
    expect((await f.run("SWEEP")).skipped).toBe(false);
    expect(f.reads).toEqual(f.facts.map(({ id }) => id));
    expect((await f.store.getReconciliationEvidence(f.repositoryId))?.checkpoint).toEqual(at);
    expect(f.materialize.mock.calls[0]?.[0].synchronization).toMatchObject({ full: true, scanStartedAt: at, dirtySubjects: [] });
    expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toHaveLength(1);
    expect(await sql`select * from reconciliation_sweep_passes where pass_id = ${pass!.pass_id}`).toEqual([]);
    expect(await sql`select * from reconciliation_sweep_walk_subjects where pass_id = ${pass!.pass_id}`).toEqual([]);
  });

  it("runs the walk through the lazy sponsor gateway", async () => {
    const f = await fixture();
    const gateway = sponsorGateway(f.store, f.repositoryId, () => f.gateway);
    const result = await reconcileRepository({ store: f.store, github: gateway, sweep: f.sweep,
      now: () => at, onBudgetChange: () => {} }, f.repositoryId, { reason: "SWEEP" });
    expect(result.skipped).toBe(false);
    expect(f.gateway.walkReconciliation).toHaveBeenCalledOnce();
    expect(f.gateway.listIssues).not.toHaveBeenCalled();
    expect((await f.store.getReconciliationEvidence(f.repositoryId))?.issues.map(({ id }) => id)).toEqual(f.facts.map(({ id }) => id));
  });

  it("keeps explicit and webhook folds on listIssues without spending sweep budget", async () => {
    const f = await fixture();
    // A command's sweep control is absent in production; exercise that seam too.
    await reconcileRepository({ store: f.store, github: f.gateway, now: () => at, onBudgetChange: () => {} }, f.repositoryId);
    f.state.limit = 0;
    expect((await f.run("WEBHOOK")).skipped).toBe(false);
    expect(f.gateway.walkReconciliation).not.toHaveBeenCalled();
    expect(f.sweep.spend).not.toHaveBeenCalled();
    expect(f.gateway.listIssues).toHaveBeenCalledTimes(2);
    expect(f.materialize.mock.calls[1]?.[0].synchronization?.full).toBe(false);
  });

  it("discards old-format staging with its pass through the database cascade", async () => {
    const f = await fixture();
    await reconcileRepository({ store: f.store, github: f.gateway, now: () => at, onBudgetChange: () => {} }, f.repositoryId);
    f.state.limit = 3;
    await f.run("SWEEP");
    const [old] = await sql`select pass_id from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`;
    expect(await sql`select * from reconciliation_sweep_walk_subjects where pass_id = ${old!.pass_id}`).toHaveLength(1);
    await sql`update repository_reconciliation_evidence set format_version = ${RECONCILIATION_EVIDENCE_FORMAT - 1} where repository_id = ${f.repositoryId}`;
    await f.run("SWEEP");
    const [fresh] = await sql`select pass_id from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`;
    expect(fresh!.pass_id).not.toBe(old!.pass_id);
    expect(await sql`select * from reconciliation_sweep_walk_subjects where pass_id = ${old!.pass_id}`).toEqual([]);
  });

  it("reads the evidence version after the completed walk", async () => {
    const f = await fixture();
    await reconcileRepository({ store: f.store, github: f.gateway, now: () => at, onBudgetChange: () => {} }, f.repositoryId);
    const version = (await f.store.getReconciliationEvidence(f.repositoryId))!.version;
    f.state.bumpVersion = true;
    await f.run("SWEEP");
    expect(f.materialize.mock.calls[1]?.[0].synchronization?.expectedVersion).toBe(version + 1);
    expect((await f.store.getReconciliationEvidence(f.repositoryId))!.version).toBe(version + 2);
  });

  it("preserves a newer generation when a resumed issue is discarded", async () => {
    const f = await fixture();
    const subject = f.facts[1]!;
    subject.openingEvidenceUnreadable = true;
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'ISSUE', ${subject.id}, ${subject.number})`;
    const [old] = await f.store.getDirtyReconciliationSubjects(f.repositoryId);
    f.state.limit = 3;
    await f.run("SWEEP");
    await sql`update repository_reconciliation_dirty_subjects set generation = nextval('repository_reconciliation_dirty_generation')
      where repository_id = ${f.repositoryId}`;
    const [fresh] = await f.store.getDirtyReconciliationSubjects(f.repositoryId);
    expect(fresh!.generation).not.toBe(old!.generation);
    f.state.limit = Infinity;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try { await f.run("SWEEP"); } finally { log.mockRestore(); }
    expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toEqual([fresh]);
  });

  it("uses the PR discard journal kind and its true identity's dirty generation", async () => {
    const f = await fixture();
    f.store.getRepository = async () => ({ ...f.repository, disputePullRequests: [{ id: 901, number: 7 }] });
    f.state.prFailure = new GitHubApiError(406);
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'PULL_REQUEST', 901, 7)`;
    const [dirty] = await f.store.getDirtyReconciliationSubjects(f.repositoryId);
    const discard = vi.spyOn(f.store, "discardDirtyReconciliationSubject");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.run("SWEEP");
      expect(log).toHaveBeenCalledWith(`Reconciliation of repository ${f.repositoryId} discarded unresolvable subject kind=PULL_REQUEST number=7 reason=DIFF_TOO_LARGE`);
      expect(discard).toHaveBeenCalledWith({ repositoryId: f.repositoryId, kind: "PULL_REQUEST", githubSubjectId: 901, generation: dirty!.generation });
      expect(await f.store.getDirtyReconciliationSubjects(f.repositoryId)).toEqual([]);
    } finally { log.mockRestore(); }
  });

  it("preserves uppercase journal kinds and generation-checked dirty discards and unreadable retention", async () => {
    const f = await fixture();
    f.facts[0]!.openingEvidenceUnreadable = true;
    await sql`insert into repository_reconciliation_dirty_subjects (repository_id, kind, github_subject_id, subject_number)
      values (${f.repositoryId}, 'ISSUE', ${f.facts[0]!.id}, ${f.facts[0]!.number})`;
    const [dirty] = await f.store.getDirtyReconciliationSubjects(f.repositoryId);
    const discard = vi.spyOn(f.store, "discardDirtyReconciliationSubject");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await f.run("SWEEP");
      expect(discard).toHaveBeenCalledWith({ repositoryId: f.repositoryId, kind: "ISSUE", githubSubjectId: dirty!.id, generation: dirty!.generation });
      expect(log).toHaveBeenCalledWith(`Reconciliation of repository ${f.repositoryId} discarded unresolvable subject kind=ISSUE number=${dirty!.number} reason=UNREADABLE_FIELD`);
      expect(f.materialize.mock.calls[0]?.[0].synchronization?.keptIssueGitHubIds).toEqual([dirty!.id]);
      expect(await sql`select * from issues where repository_id = ${f.repositoryId} and github_issue_id = ${dirty!.id}`).toHaveLength(1);
    } finally { log.mockRestore(); }
  });
});
