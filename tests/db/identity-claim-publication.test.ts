import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimGitHubIdentity, PostgresFoldStore } from "@/lib/fold/postgres-store";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

/**
 * The ordering this suite pins: a fold snapshot is published while a
 * contributor's Overflow account does not exist yet, the account is then
 * created and its identity claimed, and the SAME stale snapshot is published
 * again through a fresh run. Materialization must re-resolve the claim inside
 * the publication transaction instead of replaying the snapshot's UNCLAIMED
 * state over the claimed rows.
 */
describe("identity claims survive republication of a stale fold", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "identity_claim_publication_test",
      user: "identity_claim_publication_test",
      password: "identity_claim_publication_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("keeps a claimed settlement SETTLED when a stale snapshot is republished", async () => {
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);

    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
    `;
    await claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "SETTLED", creditor_id: contributor.id }),
    ]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    const settlementChanges = (await changesFor(second.runId)).filter(
      (change) => change.entity_kind === "SETTLEMENT",
    );
    expect(settlementChanges).toEqual([]);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "SETTLED",
        creditor_id: contributor.id,
        fold_revision: FOLD_REVISION,
      }),
    ]);
    // Callers retain and reuse folds across runs, so the resolution must have
    // produced a fresh object instead of rewriting the snapshot in place.
    expect(scenario.fold.settlements[0]?.status).toBe("UNCLAIMED");
    expect(scenario.fold.settlements[0]?.creditorId).toBeNull();
    expect(scenario.fold.pullRequests[0]?.authorId).toBeNull();
  });

  it("keeps a claimed self-work calibration when a stale snapshot is republished", async () => {
    // Self-work means the claimed identity is the settlement's debtor, so the
    // debtor's users row already carries the github id: a fixed publication
    // resolves the snapshot's self-work shape immediately, an unfixed one
    // leaves the UNCLAIMED settlement for the claim to move. Either way the
    // claim converges the tables to the same claimed state.
    const scenario = await createUnclaimedScenario(sql, { creditorGitHubUserId: "sponsor" });
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    await claimGitHubIdentity(sql, scenario.sponsor.id, scenario.creditorGitHubId);
    const claimedCalibration = expect.objectContaining({
      user_id: scenario.sponsor.id,
      opening_comparison_points: 5,
      actual_points: 6,
    });
    expect(await settlementRows(scenario.repositoryId)).toEqual([]);
    expect(await calibrationRows(scenario.repositoryId)).toEqual([claimedCalibration]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    // The stale snapshot names a settlement this issue no longer has and no
    // calibration: replaying it verbatim would re-insert the settlement and
    // delete the calibration the claim produced.
    expect(await settlementRows(scenario.repositoryId)).toEqual([]);
    expect(await calibrationRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        user_id: scenario.sponsor.id,
        opening_comparison_points: 5,
        actual_points: 6,
        fold_revision: FOLD_REVISION,
      }),
    ]);
    // Callers retain and reuse folds across runs, so the resolution must have
    // produced a fresh object instead of appending to or rewriting the
    // snapshot's own arrays in place.
    expect(scenario.fold.selfWorkCalibrations).toEqual([]);
    expect(scenario.fold.settlements.map((settlement) => settlement.status)).toEqual(["UNCLAIMED"]);
  });

  it("preserves a claimed pull request author when a stale snapshot is republished", async () => {
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
    `;
    await claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: contributor.id }),
    ]);

    await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: contributor.id }),
    ]);
  });

  it("leaves a settlement UNCLAIMED when only the debtor is not participation-eligible at merge time", async () => {
    // The mirror of the banned-creditor case: the creditor's own eligibility
    // is not sufficient, the claim requires the debtor eligible at merge time
    // too, so publication must not promote the settlement on the creditor
    // alone.
    const scenario = await createUnclaimedScenario(sql, { sponsorEnforcementState: "BANNED" });
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
    `;
    await claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "UNCLAIMED",
        creditor_id: null,
        fold_revision: FOLD_REVISION,
      }),
    ]);
  });

  it("leaves a settlement UNCLAIMED when the mapped user is not participation-eligible at merge time", async () => {
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    // No moderation events exist, so enforcement_state_at falls back to the
    // users row itself: a banned creditor is not eligible at mergedAt, and the
    // claim's own guards leave the settlement untouched.
    const [banned] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login, enforcement_state)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}, 'BANNED'::enforcement_state)
      returning id
    `;
    await claimGitHubIdentity(sql, banned.id, scenario.creditorGitHubId);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);

    const second = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "UNCLAIMED",
        creditor_id: null,
        fold_revision: FOLD_REVISION,
      }),
    ]);
  });

  it("publishes an UNCLAIMED settlement unchanged when the github id maps to no user", async () => {
    const scenario = await createUnclaimedScenario(sql);
    const { deltas } = await publish(scenario.store, scenario.repositoryId, scenario.fold);
    expect(deltas).toEqual({ adds: 1, changes: 0, removals: 0 });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "UNCLAIMED",
        creditor_id: null,
        credits: 6,
        fold_revision: FOLD_REVISION,
      }),
    ]);
  });

  it("keeps a claim committing between the publication's identity read and its writes SETTLED", async () => {
    // The mid-transaction window issue 446 could not pin: the users read in
    // reResolveIdentityClaims has already executed, and cannot see the
    // creditor, by the time the hook runs — the hook inserts the users row and
    // launches the claim into the gap between that read and the
    // materialization writes. The fold therefore resolves stale and every
    // write it produces carries the pre-claim state; an unfenced claim commits
    // first and is overwritten — the run then records a CHANGE reverting the
    // creditor to null. Fenced, the claim waits for the publication to commit
    // and applies the claimed state last.
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    let claim: Promise<void> | undefined;
    let contributorId: string | undefined;
    const { client, intercepted } = interceptingSql(sql, async () => {
      const [contributor] = await sql<{ id: string }[]>`
        insert into users (github_user_id, github_login)
        values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
      `;
      contributorId = contributor.id;
      claim = claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
      // Hold the publication here — between its identity read and its writes —
      // until the claim is either committed or provably blocked on the fence.
      // Committed means the publication's loads below will read the claimed
      // state its stale fold is about to overwrite, which is the clobber this
      // test must observe on an unfenced claim. Fence-blocked means the
      // publication may safely proceed: its writes carry the stale fold, and
      // the claim applies only after the publication commits. Awaiting the
      // claim outright would deadlock against the fence, and returning
      // immediately would leave the commit-versus-write ordering to the
      // scheduler.
      await Promise.race([
        claim,
        waitForFenceWaiter().catch(() => undefined),
      ]);
    });
    const second = await publish(new PostgresFoldStore(client), scenario.repositoryId, scenario.fold);

    expect(intercepted()).toBe(1);
    if (claim === undefined || contributorId === undefined) {
      throw new Error("The users read of the publication was never intercepted.");
    }
    await claim;
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "SETTLED", creditor_id: contributorId }),
    ]);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: contributorId }),
    ]);
    // Either no CHANGE at all or none whose after-state un-claims: the stale
    // publication must not have written anything over the claim.
    expect(
      (await changesFor(second.runId)).filter(
        (change) => change.entity_kind === "SETTLEMENT" && change.change_kind === "CHANGE",
      ),
    ).toEqual([]);
  });

  it("keeps a self-work claim committing between the publication's identity read and its writes", async () => {
    // The sponsor's users row exists from the start, so reResolveIdentityClaims
    // maps the self-work shape itself and the publication writes the claimed
    // state directly; the concurrently launched claim converges on the same
    // rows. Nothing may resurrect the settlement, lose the calibration, or
    // revert the claimed author.
    const scenario = await createUnclaimedScenario(sql, { creditorGitHubUserId: "sponsor" });
    await publish(scenario.store, scenario.repositoryId, scenario.fold);

    let claim: Promise<void> | undefined;
    const { client, intercepted } = interceptingSql(sql, async () => {
      claim = claimGitHubIdentity(sql, scenario.sponsor.id, scenario.creditorGitHubId);
    });
    const second = await publish(new PostgresFoldStore(client), scenario.repositoryId, scenario.fold);

    expect(intercepted()).toBe(1);
    if (claim === undefined) throw new Error("The users read of the publication was never intercepted.");
    await claim;
    expect(second.deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
    expect(await settlementRows(scenario.repositoryId)).toEqual([]);
    expect(await calibrationRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        user_id: scenario.sponsor.id,
        opening_comparison_points: 5,
        actual_points: 6,
      }),
    ]);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: scenario.sponsor.id }),
    ]);
  });

  it("blocks a claim on a held registered_repositories row lock before applying it", async () => {
    // Red-first rationale: on a claim that takes no fence, nothing blocks — the
    // claim completes while this transaction still holds the scenario's
    // repository row, so the waiting-backend probe below finds no waiter and
    // this test fails there. With the fence the claim's first statement waits
    // until the lock is released.
    const scenario = await createUnclaimedScenario(sql);
    await publish(scenario.store, scenario.repositoryId, scenario.fold);
    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${scenario.creditorGitHubId}, ${`contributor-${scenario.creditorGitHubId}`}) returning id
    `;

    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holder = sql.begin(async (transaction) => {
      await transaction`select id from registered_repositories where id = ${scenario.repositoryId} for update`;
      await held;
    });
    // The executor above assigns releaseHolder synchronously, so its being
    // set proves nothing; the lock is observably held only when a NOWAIT
    // attempt on the same row fails. Waiting on that, not on the closure, is
    // what makes the launch ordering deterministic.
    await waitForRowLockHeld(scenario.repositoryId);

    const claim = claimGitHubIdentity(sql, contributor.id, scenario.creditorGitHubId);
    try {
      // A waiter for the repository row proves the claim's first statement
      // reached the fence and is blocked. On an unfenced claim nothing waits —
      // the claim completes while this transaction still holds the lock — and
      // this wait times out, which is this test's red-first rationale.
      await waitForFenceWaiter();
    } finally {
      // Release the held row even when the probe times out, so the holder's
      // open transaction cannot hang the suite's connection teardown.
      releaseHolder();
      await holder;
      await claim;
    }
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "SETTLED", creditor_id: contributor.id }),
    ]);
    expect(await pullRequestRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ author_id: contributor.id }),
    ]);
  });
});

let externalId = 5_000_000;

/**
 * One registered repository whose fold records one merged pull request
 * closing one issue with a settled label, and one UNCLAIMED settlement: the
 * creditor has no users row yet, so the snapshot carries only their GitHub
 * identity. Modeled on the materializeRepositoryFixture shape, which this
 * suite cannot use because its settlements are already SETTLED.
 */
async function createUnclaimedScenario(
  sql: Sql,
  options?: { creditorGitHubUserId?: "sponsor"; sponsorEnforcementState?: "BANNED" },
) {
  const sponsorGitHubId = externalId++;
  const creditorGitHubId = options?.creditorGitHubUserId === "sponsor"
    ? sponsorGitHubId
    : externalId++;
  // No moderation events exist, so enforcement_state_at falls back to the
  // users row itself: a banned sponsor is not participation-eligible at any
  // merge time.
  const sponsorState = options?.sponsorEnforcementState ?? "ACTIVE";
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, enforcement_state)
    values (${sponsorGitHubId}, ${`sponsor-${sponsorGitHubId}`}, ${sponsorState}::enforcement_state) returning id
  `;
  const repositoryGitHubId = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${repositoryGitHubId}, ${`owner/repo-${repositoryGitHubId}`}, ${sponsor.id}, 'PUBLIC',
      ${externalId++}, ${sql.json(validDifficultyScheme())}
    ) returning id
  `;
  const githubIssueId = externalId++;
  const githubPullRequestId = externalId++;
  const mergedAt = "2026-09-01T12:00:00.000Z";
  const mergeCommitOid = "b".repeat(40);
  const proofSha256 = repositoryGitHubId.toString(16).padStart(64, "0");
  const creditorLogin = `unclaimed-${creditorGitHubId}`;
  // An UNCLAIMED settlement carries the claim formula itself:
  // max(0, settled points - review rounds) with no creditor to credit.
  const settledEvidence = {
    settledLabel: "delivered/6", settledPoints: 6,
    settledLabelEventId: "actual", settledLabelActorLogin: `sponsor-${sponsorGitHubId}`,
    settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
    settledRationaleCommentId: "rationale", settledRationaleActorLogin: `sponsor-${sponsorGitHubId}`,
    settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
  };
  const fold: FoldResult = {
    issues: [{
      githubIssueId, number: 1, title: "Identity claim fixture", body: "", url: "https://example.test/issue",
      state: "CLOSED", updatedAt: "2026-09-01T12:05:00.000Z", openingLabel: "M", openingComparisonPoints: 5,
      openingReservePoints: 5, ownerGitHubLogin: `sponsor-${sponsorGitHubId}`,
      openingSourceEventId: `opening-${githubIssueId}`, openingSourceActorLogin: `sponsor-${sponsorGitHubId}`,
      openingSourceAt: "2026-09-01T08:00:00.000Z",
      claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null, ...settledEvidence,
    }],
    pullRequests: [{
      githubPullRequestId, number: 11, title: "Identity claim fixture", body: "", url: "https://example.test/pr",
      state: "MERGED", mergedAt, mergeCommitOid, finalCommitAt: "2026-09-01T10:00:00.000Z",
      authorId: null, authorGitHubLogin: creditorLogin, authorGitHubUserId: creditorGitHubId,
      proofSha256, githubIssueIds: [githubIssueId], reviewRounds: [],
    }],
    settlements: [{
      githubIssueId, githubPullRequestId, creditorId: null,
      creditorGitHubLogin: creditorLogin, creditorGitHubUserId: creditorGitHubId,
      debtorId: sponsor.id, openingComparisonPoints: 5, ...settledEvidence,
      mergeCommitOid, mergedAt, reviewRounds: 0, credits: 6, proofSha256, status: "UNCLAIMED",
    }],
    selfWorkCalibrations: [], unwritableClosures: [], policyViolations: [], ledgerEntries: [],
  };
  const store = new PostgresFoldStore(sql);
  const repositoryId = repository.id;
  return {
    repositoryId, store, fold, sponsor, sponsorGitHubId, creditorGitHubId,
    githubIssueId, githubPullRequestId,
  };
}

async function publish(store: PostgresFoldStore, repositoryId: string, fold: FoldResult) {
  const runId = await store.beginRun(repositoryId);
  const deltas = await store.withRepositoryReconciliation(
    repositoryId,
    async () => store.materialize({ repositoryId, runId, fold }),
  );
  return { runId, deltas };
}

function changesFor(runId: string) {
  return sql<{ entity_kind: string; change_kind: string; before_state: unknown; after_state: unknown }[]>`
    select entity_kind, change_kind, before_state, after_state
    from reconciliation_changes where reconciliation_run_id = ${runId}
  `;
}

function settlementRows(repositoryId: string) {
  return sql`
    select settlements.* from settlements
    join issues on issues.id = settlements.issue_id
    where issues.repository_id = ${repositoryId}
  `;
}

function calibrationRows(repositoryId: string) {
  return sql`
    select self_work_calibrations.* from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.repository_id = ${repositoryId}
  `;
}

function pullRequestRows(repositoryId: string) {
  return sql`
    select pull_requests.* from pull_requests
    where pull_requests.repository_id = ${repositoryId}
  `;
}

const usersReadStatement = /select\s+github_user_id\s*,\s*id\s+from\s+users\b/;

/**
 * A transparent proxy over the store's client whose tagged-template calls are
 * passed straight to the underlying pool — except one statement, the users
 * read of reResolveIdentityClaims, whose RESOLVED result is held back until
 * the hook has run. The read has already executed when the hook starts, so the
 * fold resolves against the pre-hook snapshot and stays stale; the hook then
 * runs on the raw pool, on a different connection than the publication
 * transaction, which is what lets it commit work and launch a claim into the
 * gap between the publication's identity read and its writes.
 */
function interceptingSql(
  raw: Sql,
  hook: () => Promise<void>,
): { client: Sql; intercepted: () => number } {
  let count = 0;
  // The driver joins the static fragments with $1, $2, … placeholders, so
  // joining them back here reproduces the statement text closely enough for a
  // fragment match.
  const statementText = (fragments: readonly string[]) =>
    fragments.reduce((text, fragment, index) => (index === 0 ? fragment : `${text}$${index}${fragment}`), "");
  const wrap = <C extends Sql | TransactionSql>(target: C): C => new Proxy(target, {
    apply(callTarget, _thisArg, args) {
      const pending = Reflect.apply(callTarget, callTarget, args) as Promise<unknown>;
      const [fragments] = args as [TemplateStringsArray];
      if (!usersReadStatement.test(statementText(fragments.raw ?? fragments))) {
        return pending as never;
      }
      count += 1;
      return pending.then(
        (result) => hook().then(() => result),
        (error: unknown) => {
          void hook().catch(() => undefined);
          throw error;
        },
      ) as never;
    },
    get(getTarget, property) {
      if (property === "begin") {
        return (callback: (transaction: TransactionSql) => unknown) =>
          (getTarget as Sql).begin((transaction) => callback(wrap(transaction)));
      }
      const value = Reflect.get(getTarget, property, getTarget);
      return typeof value === "function" ? (value as (...callArgs: unknown[]) => unknown).bind(getTarget) : value;
    },
  });
  return { client: wrap(raw), intercepted: () => count };
}

/**
 * Backends currently blocked on a `registered_repositories` row lock: the
 * claim's fence is the only statement that can wait there during these tests.
 */
async function countFenceWaiters(): Promise<number> {
  const [row] = await sql<{ waiting: number }[]>`
    select count(*)::int as waiting
    from pg_locks locks join pg_stat_activity backend on backend.pid = locks.pid
    where not locks.granted and backend.wait_event_type = 'Lock'
      and backend.query ilike ${"%registered_repositories%"}
  `;
  return row?.waiting ?? 0;
}

/**
 * Waits until a claim backend is blocked on the fence, bounded at two seconds.
 * Resolving proves the claim cannot proceed while a registered_repositories
 * row lock is held; timing out is the unfenced failure mode.
 */
async function waitForFenceWaiter(): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await countFenceWaiters()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    "no backend was ever seen waiting on a registered_repositories row lock",
  );
}

/**
 * Waits until a `FOR UPDATE NOWAIT` attempt on the repository row fails, which
 * is the only server-observable proof that the holder transaction holds the
 * row lock; a nowait failure outside that lock is rethrown.
 */
async function waitForRowLockHeld(repositoryId: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      await sql`select id from registered_repositories where id = ${repositoryId} for update nowait`;
    } catch (error) {
      if ((error as { code?: string }).code === "55P03") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the row lock holder never acquired its lock");
}
