import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresSweepPassStore } from "@/lib/fold/sweep-pass-store";
import type { SweepPass } from "@/lib/fold/sweep-pass";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "generation", user: "generation", password: randomBytes(16).toString("hex") });
  container = started.container; process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql(); await runMigrations();
});
afterAll(async () => { await closeSql(); await container?.stop(); });

// An earlier release stored a held pass's generations as JSON numbers; such a pass resumes and acknowledges exactly.
it.each([["the maximum bigint", "9223372036854775806", false], ["2 ** 53 - 1, stored as a number", "9007199254740990", true]])(
  "sweeps a repository whose dirty subject's generation is %s", async (_label, last, numeric) => {
  const f = await materializeRepositoryFixture(sql);
  const repository = (await f.store.getRepository(f.repositoryId))!;
  const subject = f.fold.issues[0]!;
  // Advance the generation sequence so the next enqueue receives the generation under test.
  await sql`select setval('repository_reconciliation_dirty_generation', ${last}, true)`;
  await f.store.enqueueWebhookReconciliation(f.repositoryId, { deliveryId: "maximum", executionId: "maximum", event: "issues", action: "edited",
    repositoryGitHubId: repository.githubRepositoryId, repositoryFullName: repository.ownerName, subject: { kind: "ISSUE", id: subject.githubIssueId, number: subject.number } });
  const [dirty] = await sql<{ generation: string }[]>`select generation::text from repository_reconciliation_dirty_subjects where repository_id = ${f.repositoryId}`;
  expect(dirty!.generation).toBe(String(BigInt(last) + 1n));
  f.store.getGitHubAccessToken = async () => randomBytes(24).toString("hex");
  const passes = new PostgresSweepPassStore(sql);
  const state = { pass: null as SweepPass | null };
  const github: ReconciliationGateway = {
    // First run: hold for the sweep request budget, which keeps the pass.
    walkReconciliation: async () => { await state.pass!.write("first", { text: "paused page" }); throw new SweepBudgetSpent(new Date("2030-01-01T06:00:00Z")); },
    getRepositoryById: verifiedRepositoryAt(repository.ownerName),
    listIssues: async () => [], getIssue: async () => null, getPullRequestClosingIssues: async () => [],
    getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
  };
  const dependencies = { store: f.store, github, now: () => new Date("2030-01-01T00:00:00Z"), onBudgetChange: () => {}, sweep: {
    spend: async () => null, openPass: async (input: Parameters<PostgresSweepPassStore["open"]>[0]) => (state.pass = await passes.open(input)),
    discardPass: (id: string) => passes.discardByRepository(id), discardIfInactive: (id: string) => passes.discardIfInactive(id) } };
  await reconcileRepository(dependencies, f.repositoryId, { reason: "SWEEP" });
  const passId = state.pass!.id;
  if (numeric) await sql`update reconciliation_sweep_passes set dirty_subjects = jsonb_set(dirty_subjects, '{0,generation}',
    to_jsonb((dirty_subjects->0->>'generation')::bigint)) where pass_id = ${passId}`;

  // Later runs: an empty, completed walk.
  github.walkReconciliation = async () => ({ status: "completed", issues: [], pullRequests: [], missingDisputePrIds: new Set<number>() });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const runs: string[] = [], resumed: boolean[] = [];
  for (let run = 0; run < 3; run++) {
    const outcome = await reconcileRepository(dependencies, f.repositoryId, { reason: "SWEEP" })
      .then(() => "completed", (error: Error) => `failed: ${((error.cause as Error | undefined) ?? error).message}`);
    const [row] = await sql<{ pass_id: string }[]>`select pass_id from reconciliation_sweep_passes where repository_id = ${f.repositoryId}`;
    runs.push(`${outcome}; pass ${row === undefined ? "none" : row.pass_id === passId ? "same" : "new"}`);
    resumed.push(state.pass!.id === passId);
  }
  log.mockRestore();
  const remaining = await sql<{ generation: string }[]>`select generation::text from repository_reconciliation_dirty_subjects where repository_id = ${f.repositoryId}`;
  expect({ runs, resumed, remaining: remaining.map((row) => row.generation) }).toEqual({
    runs: ["completed; pass none", "completed; pass none", "completed; pass none"], resumed: [true, false, false],
    remaining: [],
  });
});
