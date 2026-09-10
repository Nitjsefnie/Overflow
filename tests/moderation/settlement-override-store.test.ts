import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 70_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("PostgreSQL settlement override requests", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_override_test",
      user: "overflow_override_test",
      password: "overflow_override_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("accepts a request from the creditor and from the debtor, and refuses everyone else", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const first = await insertSettlement();
    const second = await insertSettlement();
    const stranger = await insertUser("stranger");

    const byCreditor = await store.createRequest({
      requesterId: first.creditorId,
      target: { kind: "settlement", settlementId: first.settlementId },
      reason: "The rationale comment was posted after the evidence window closed.",
    });
    const byDebtor = await store.createRequest({
      requesterId: second.debtorId,
      target: { kind: "settlement", settlementId: second.settlementId },
      reason: "I applied the delivered label myself, from the wrong account.",
    });

    expect(byCreditor).toMatchObject({ kind: "ok" });
    expect(byDebtor).toMatchObject({ kind: "ok" });
    if (byCreditor.kind !== "ok") {
      throw new Error("Expected the creditor's request to be recorded.");
    }
    expect(byCreditor.value).toMatchObject({
      issueId: first.issueId,
      requesterId: first.creditorId,
      state: "OPEN",
      settledPoints: null,
      decidedById: null,
      decisionReason: null,
      decidedAt: null,
    });

    await expect(
      store.createRequest({
        requesterId: stranger,
        target: { kind: "settlement", settlementId: first.settlementId },
        reason: "This is not my settlement.",
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      store.createRequest({
        requesterId: stranger,
        target: { kind: "settlement", settlementId: "11111111-1111-4111-8111-111111111111" },
        reason: "No such settlement.",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("accepts a request from the account a self-work calibration belongs to, and refuses everyone else", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const calibration = await insertCalibration();
    // A calibration of its own, so dropping the ownership check would record
    // the stranger's request rather than colliding with an existing one.
    const someoneElses = await insertCalibration();
    const stranger = await insertUser("not-the-self-worker");

    const bySponsor = await store.createRequest({
      requesterId: calibration.sponsorId,
      target: { kind: "calibration", calibrationId: calibration.calibrationId },
      reason: "The delivered label undercounts the work I did on my own issue.",
    });

    expect(bySponsor).toMatchObject({ kind: "ok" });
    if (bySponsor.kind !== "ok") {
      throw new Error("Expected the sponsor's request to be recorded.");
    }
    expect(bySponsor.value).toMatchObject({
      issueId: calibration.issueId,
      requesterId: calibration.sponsorId,
      state: "OPEN",
      settledPoints: null,
      decidedById: null,
      decisionReason: null,
      decidedAt: null,
    });

    await expect(
      store.createRequest({
        requesterId: stranger,
        target: { kind: "calibration", calibrationId: someoneElses.calibrationId },
        reason: "This is not my calibration.",
      }),
    ).resolves.toEqual({ kind: "forbidden" });
    await expect(
      store.createRequest({
        requesterId: calibration.sponsorId,
        target: { kind: "calibration", calibrationId: "33333333-3333-4333-8333-333333333333" },
        reason: "No such calibration.",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("holds the one-open-request guard against a calibration too", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const calibration = await insertCalibration();

    await expect(
      store.createRequest({
        requesterId: calibration.sponsorId,
        target: { kind: "calibration", calibrationId: calibration.calibrationId },
        reason: "The actual points are two too low.",
      }),
    ).resolves.toMatchObject({ kind: "ok" });
    await expect(
      store.createRequest({
        requesterId: calibration.sponsorId,
        target: { kind: "calibration", calibrationId: calibration.calibrationId },
        reason: "A second thought about the same issue.",
      }),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("shows a calibration's requests to the account it belongs to and to nobody else", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const calibration = await insertCalibration();
    const stranger = await insertUser("uninvolved-in-the-calibration");
    await store.createRequest({
      requesterId: calibration.sponsorId,
      target: { kind: "calibration", calibrationId: calibration.calibrationId },
      reason: "The actual points are two too low.",
    });

    await expect(
      store.listRequestsForCalibration(calibration.calibrationId, calibration.sponsorId),
    ).resolves.toMatchObject([{ reason: "The actual points are two too low.", state: "OPEN" }]);
    await expect(
      store.listRequestsForCalibration(calibration.calibrationId, stranger),
    ).resolves.toEqual([]);
  });

  it("allows one open request per settlement and a fresh one once the last was decided", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement();

    const opened = await store.createRequest({
      requesterId: settlement.creditorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The settled label was never applied.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the first request to open.");
    }

    await expect(
      store.createRequest({
        requesterId: settlement.debtorId,
        target: { kind: "settlement", settlementId: settlement.settlementId },
        reason: "A second opinion on the same settlement.",
      }),
    ).resolves.toEqual({ kind: "conflict" });

    const moderator = await insertUser("moderator");
    await expect(
      store.decideRequest({
        actorId: moderator,
        requestId: opened.value.id,
        decision: "DECLINE",
        reason: "The label was applied outside the window on purpose.",
      }),
    ).resolves.toMatchObject({ kind: "ok" });

    await expect(
      store.createRequest({
        requesterId: settlement.debtorId,
        target: { kind: "settlement", settlementId: settlement.settlementId },
        reason: "New evidence has appeared since the decline.",
      }),
    ).resolves.toMatchObject({ kind: "ok" });
  });

  it("records who granted a correction, at what points, and why", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement();
    const moderator = await insertUser("granting-moderator");
    const opened = await store.createRequest({
      requesterId: settlement.creditorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The work was delivered at six points.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    const granted = await store.decideRequest({
      actorId: moderator,
      requestId: opened.value.id,
      decision: "GRANT",
      settledPoints: 6,
      reason: "The merged pull request matches the delivered/6 rationale.",
    });

    expect(granted).toMatchObject({ kind: "ok" });
    if (granted.kind !== "ok") {
      throw new Error("Expected the grant to be recorded.");
    }
    expect(granted.value).toMatchObject({
      state: "GRANTED",
      settledPoints: 6,
      decidedById: moderator,
      decisionReason: "The merged pull request matches the delivered/6 rationale.",
    });
    expect(granted.value.decidedAt).not.toBeNull();

    await expect(
      store.decideRequest({
        actorId: moderator,
        requestId: opened.value.id,
        decision: "DECLINE",
        reason: "Changed my mind after the fact.",
      }),
    ).resolves.toEqual({ kind: "conflict" });
    await expect(
      store.decideRequest({
        actorId: moderator,
        requestId: "22222222-2222-4222-8222-222222222222",
        decision: "DECLINE",
        reason: "No such request.",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  // The grant is the missing link between the decision and the ledger: the
  // materializer already applies granted overrides at fold time, so the only
  // thing a grant still owes is the job that makes the fold happen now.
  it("schedules ledger materialization exactly when a decision grants a correction", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const moderator = await insertUser("scheduling-moderator");

    const granted = await insertSettlement();
    const grantedRequest = await store.createRequest({
      requesterId: granted.creditorId,
      target: { kind: "settlement", settlementId: granted.settlementId },
      reason: "The settled points are too low.",
    });
    if (grantedRequest.kind !== "ok") {
      throw new Error("Expected the grant-path request to open.");
    }
    await store.decideRequest({
      actorId: moderator,
      requestId: grantedRequest.value.id,
      decision: "GRANT",
      settledPoints: 8,
      reason: "The delivered diff carries eight points of work.",
    });

    const grantedRepositoryId = await repositoryIdForIssue(granted.issueId);
    await expect(jobRows(grantedRepositoryId)).resolves.toEqual([
      {
        id: expect.any(String),
        reason: "OVERRIDE",
        state: "PENDING",
        follow_up_requested: false,
        attempt_count: 0,
        lease_token: null,
      },
    ]);

    // A grant landing while a job is RUNNING must not break its lease or queue
    // a second row: the fold in flight may predate the grant, so the row
    // records a follow-up instead — the same conflict semantics every enqueue uses.
    const followUpRequest = await store.createRequest({
      requesterId: granted.debtorId,
      target: { kind: "settlement", settlementId: granted.settlementId },
      reason: "A second correction for the same settlement.",
    });
    if (followUpRequest.kind !== "ok") {
      throw new Error("Expected the follow-up request to open after the first was decided.");
    }
    await sql`
      update repository_reconciliation_jobs
      set state = 'RUNNING',
          lease_token = gen_random_uuid(),
          lease_duration_ms = 20000,
          lease_expires_at = now() + interval '1 minute'
      where repository_id = ${grantedRepositoryId}
    `;
    // The grant itself must touch neither the lease columns nor the attempt
    // count: only the follow-up flag moves, because the fold in flight may
    // have read GitHub before the grant happened.
    const [runningJob] = await jobRows(grantedRepositoryId);
    await store.decideRequest({
      actorId: moderator,
      requestId: followUpRequest.value.id,
      decision: "GRANT",
      settledPoints: 5,
      reason: "The follow-up grant lands mid-fold.",
    });
    await expect(jobRows(grantedRepositoryId)).resolves.toEqual([
      {
        id: runningJob.id,
        reason: "OVERRIDE",
        state: "RUNNING",
        follow_up_requested: true,
        attempt_count: 0,
        lease_token: runningJob.lease_token,
      },
    ]);

    // DECLINE enqueues nothing: nothing was granted, so there is nothing to
    // materialize.
    const declined = await insertSettlement();
    const declinedRequest = await store.createRequest({
      requesterId: declined.creditorId,
      target: { kind: "settlement", settlementId: declined.settlementId },
      reason: "This correction will be refused.",
    });
    if (declinedRequest.kind !== "ok") {
      throw new Error("Expected the decline-path request to open.");
    }
    await store.decideRequest({
      actorId: moderator,
      requestId: declinedRequest.value.id,
      decision: "DECLINE",
      reason: "The recorded evidence stands.",
    });
    const declinedRepositoryId = await repositoryIdForIssue(declined.issueId);
    await expect(jobRows(declinedRepositoryId)).resolves.toEqual([]);

    // The conflict path — a decision against a request that is no longer OPEN —
    // moved no row, so it schedules nothing either.
    await store.decideRequest({
      actorId: moderator,
      requestId: declinedRequest.value.id,
      decision: "GRANT",
      settledPoints: 3,
      reason: "A late decision against an already-decided request.",
    });
    await expect(jobRows(declinedRepositoryId)).resolves.toEqual([]);
  });

  // The grant and its enqueue are one transaction on purpose: an enqueue that
  // fails after the state flip must take the flip back with it, or the row
  // reads GRANTED while the ledger never hears about the correction — this
  // issue's defect, one refactor deep. The failure is injected black-box, so
  // the pin survives either half of that refactor: moving the enqueue off the
  // transaction client, or swallowing its error.
  it("rolls the grant decision back when its enqueue fails", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement();
    const moderator = await insertUser("rollback-moderator");
    const opened = await store.createRequest({
      requesterId: settlement.creditorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The settled points are too low.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    const failingStore = new PostgresSettlementOverrideStore(sqlClientFailingOverrideEnqueue(sql));
    await expect(
      failingStore.decideRequest({
        actorId: moderator,
        requestId: opened.value.id,
        decision: "GRANT",
        settledPoints: 8,
        reason: "A grant whose enqueue is about to fail.",
      }),
    ).rejects.toThrow("injected: the override enqueue failed");

    // The flip rode in the same transaction as the failed enqueue, so nothing
    // of the decision survived: the request is still OPEN with no points, and
    // the repository's queue row was never written.
    await expect(sql`
      select state::text as state, settled_points
      from settlement_override_requests where id = ${opened.value.id}
    `).resolves.toEqual([{ state: "OPEN", settled_points: null }]);
    await expect(jobRows(await repositoryIdForIssue(settlement.issueId))).resolves.toEqual([]);
  });

  it("queues open requests with the settlement evidence a moderator needs, and drops them once decided", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement({ reviewRounds: 2 });
    const opened = await store.createRequest({
      requesterId: settlement.creditorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The rationale comment landed fourteen hours late.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    const queue = await store.listOpenRequests();
    const queued = queue.find((request) => request.id === opened.value.id);

    expect(queued).toMatchObject({
      reason: "The rationale comment landed fourteen hours late.",
      requesterLogin: settlement.creditorLogin,
      issueNumber: settlement.issueNumber,
      issueTitle: settlement.issueTitle,
      calibration: null,
      settlement: {
        settlementId: settlement.settlementId,
        status: "UNSETTLED",
        openingComparisonPoints: 6,
        settledPoints: null,
        reviewRounds: 2,
        credits: 0,
        pullRequestNumber: settlement.pullRequestNumber,
      },
    });

    const moderator = await insertUser("queue-moderator");
    await store.decideRequest({
      actorId: moderator,
      requestId: opened.value.id,
      decision: "GRANT",
      settledPoints: 4,
      reason: "The delivered label is right; only its comment was late.",
    });

    const afterDecision = await store.listOpenRequests();
    expect(afterDecision.some((request) => request.id === opened.value.id)).toBe(false);
  });

  it("queues a calibration-targeted request with the calibration's evidence instead of a settlement's", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const calibration = await insertCalibration({
      actualPoints: 4,
      settledEvidence: { label: "delivered/4", points: 4 },
    });
    const opened = await store.createRequest({
      requesterId: calibration.sponsorId,
      target: { kind: "calibration", calibrationId: calibration.calibrationId },
      reason: "The delivered label undercounts my own work.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    const queued = (await store.listOpenRequests()).find((request) => request.id === opened.value.id);

    expect(queued).toMatchObject({
      reason: "The delivered label undercounts my own work.",
      settlement: null,
      calibration: {
        calibrationId: calibration.calibrationId,
        ownerLogin: calibration.sponsorLogin,
        openingComparisonPoints: 7,
        actualLabel: "delivered/4",
        actualPoints: 4,
        pullRequestNumber: calibration.pullRequestNumber,
        pullRequestTitle: calibration.pullRequestTitle,
        pullRequestUrl: calibration.pullRequestUrl,
      },
    });
  });

  // The closure this correction loop exists for: the settled evidence was
  // rejected, so the calibration carries no actual points and the issue carries
  // no label. The moderator still gets the row, with both figures absent.
  it("queues a calibration whose actual points were never recorded", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const calibration = await insertCalibration({ actualPoints: null });
    const opened = await store.createRequest({
      requesterId: calibration.sponsorId,
      target: { kind: "calibration", calibrationId: calibration.calibrationId },
      reason: "My rationale comment was posted after the window closed.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    const queued = (await store.listOpenRequests()).find((request) => request.id === opened.value.id);

    expect(queued).toMatchObject({
      settlement: null,
      calibration: {
        calibrationId: calibration.calibrationId,
        openingComparisonPoints: 7,
        actualLabel: null,
        actualPoints: null,
        pullRequestNumber: calibration.pullRequestNumber,
      },
    });
  });

  it("keeps a request visible to the moderator when reconciliation removes the settlement row", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement();
    const opened = await store.createRequest({
      requesterId: settlement.creditorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The settlement is wrong.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    await sql`delete from settlements where id = ${settlement.settlementId}`;

    const queued = (await store.listOpenRequests()).find((request) => request.id === opened.value.id);
    expect(queued).toMatchObject({
      issueNumber: settlement.issueNumber,
      settlement: null,
      calibration: null,
    });
  });

  it("shows a settlement's requests to its parties and to nobody else", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement();
    const stranger = await insertUser("uninvolved");
    await store.createRequest({
      requesterId: settlement.debtorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The settled points are too low.",
    });

    await expect(
      store.listRequestsForSettlement(settlement.settlementId, settlement.creditorId),
    ).resolves.toMatchObject([{ reason: "The settled points are too low.", state: "OPEN" }]);
    await expect(
      store.listRequestsForSettlement(settlement.settlementId, settlement.debtorId),
    ).resolves.toHaveLength(1);
    await expect(store.listRequestsForSettlement(settlement.settlementId, stranger)).resolves.toEqual([]);
  });

  it("forgets a request when the issue it belongs to leaves the materialization", async () => {
    const store = new PostgresSettlementOverrideStore(sql);
    const settlement = await insertSettlement();
    const opened = await store.createRequest({
      requesterId: settlement.creditorId,
      target: { kind: "settlement", settlementId: settlement.settlementId },
      reason: "The settlement is wrong.",
    });
    if (opened.kind !== "ok") {
      throw new Error("Expected the request to open.");
    }

    await sql`delete from settlements where id = ${settlement.settlementId}`;
    await sql`delete from pull_request_issues where issue_id = ${settlement.issueId}`;
    await sql`delete from pull_requests where id = ${settlement.pullRequestId}`;
    await sql`delete from issues where id = ${settlement.issueId}`;

    await expect(sql`
      select id from settlement_override_requests where id = ${opened.value.id}
    `).resolves.toEqual([]);
  });
});

function difficultyScheme() {
  return {
    openingName: "Scope",
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
}

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

async function insertUser(prefix: string): Promise<string> {
  const githubUserId = nextExternalId();
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`${prefix}-${githubUserId}`})
    returning id
  `;
  return user.id;
}

type Scaffold = {
  issueId: string;
  issueNumber: number;
  issueTitle: string;
  pullRequestId: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
};

async function repositoryIdForIssue(issueId: string): Promise<string> {
  const [row] = await sql<{ repository_id: string }[]>`
    select repository_id from issues where id = ${issueId}
  `;
  return row.repository_id;
}

async function jobRows(repositoryId: string) {
  return sql<{ id: string; reason: string; state: string; follow_up_requested: boolean; attempt_count: number; lease_token: string | null }[]>`
    select
      id::text as id, reason, state::text as state, follow_up_requested, attempt_count,
      lease_token::text as lease_token
    from repository_reconciliation_jobs
    where repository_id = ${repositoryId}
  `;
}

/**
 * A client whose every statement runs for real except one: inside a
 * transaction, the statement hitting `repository_reconciliation_jobs` rejects.
 * Only the transaction client is faulted, so an enqueue that escapes the
 * transaction (moved onto the outer client) runs untouched and is caught —
 * that escape is precisely the refactor this pin exists to fail on.
 */
function sqlClientFailingOverrideEnqueue(real: Sql): SqlClient {
  const faultTransaction = (transaction: TransactionClient): TransactionClient => {
    // The forwarded call must reach the real client verbatim, so the forwarding
    // leg is cast once rather than re-declaring the driver's parameter types.
    const failingCall = (...callArgs: unknown[]): Promise<unknown> => {
      const query = callArgs[0] as TemplateStringsArray;
      if (query.some((text) => text.includes("repository_reconciliation_jobs"))) {
        return Promise.reject(new Error("injected: the override enqueue failed"));
      }
      return (transaction as (...forwardedArgs: unknown[]) => Promise<unknown>)(...callArgs);
    };
    return new Proxy(failingCall, {
      get: (_target, property) => (transaction as unknown as Record<PropertyKey, unknown>)[property],
    }) as TransactionClient;
  };

  const passthrough = ((...callArgs: unknown[]) =>
    (real as (...forwardedArgs: unknown[]) => Promise<unknown>)(...callArgs)) as unknown as SqlClient;
  return new Proxy(passthrough, {
    get: (target, property) => {
      if (property === "begin") {
        return (callback: (transaction: TransactionClient) => Promise<unknown>) =>
          real.begin((transaction) => callback(faultTransaction(transaction)));
      }
      return (target as unknown as Record<PropertyKey, unknown>)[property];
    },
  }) as SqlClient;
}

async function insertSettlement(options: { reviewRounds?: number } = {}): Promise<{
  settlementId: string;
  issueId: string;
  pullRequestId: string;
  creditorId: string;
  creditorLogin: string;
  debtorId: string;
  issueNumber: number;
  issueTitle: string;
  pullRequestNumber: number;
}> {
  const creditorId = await insertUser("creditor");
  const debtorId = await insertUser("sponsor");
  const [creditor] = await sql<{ github_login: string }[]>`
    select github_login from users where id = ${creditorId}
  `;
  const scaffold = await insertClosedIssue({
    sponsorId: debtorId,
    authorId: creditorId,
    authorLogin: creditor.github_login,
  });
  // Deliberately not the issue's 5, for the same reason the calibration opens
  // at 7: an equal value would pass against issues.opening_comparison_points.
  const [settlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${scaffold.pullRequestId}, ${scaffold.issueId}, ${creditorId}, ${creditor.github_login}, ${debtorId},
      6, ${null}, ${options.reviewRounds ?? 0}, 0,
      ${nextExternalId().toString(16).padStart(64, "0")}, ${"UNSETTLED"}
    )
    returning id
  `;
  return {
    settlementId: settlement.id,
    issueId: scaffold.issueId,
    pullRequestId: scaffold.pullRequestId,
    creditorId,
    creditorLogin: creditor.github_login,
    debtorId,
    issueNumber: scaffold.issueNumber,
    issueTitle: scaffold.issueTitle,
    pullRequestNumber: scaffold.pullRequestNumber,
  };
}

/**
 * A sponsor who closed their own issue: the fold records that outcome as a
 * calibration rather than a settlement, so there is no settlement row to name.
 */
async function insertCalibration(
  options: { actualPoints?: number | null; settledEvidence?: { label: string; points: number } } = {},
): Promise<{
  calibrationId: string;
  issueId: string;
  sponsorId: string;
  sponsorLogin: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
}> {
  const sponsorId = await insertUser("self-worker");
  const [sponsor] = await sql<{ github_login: string }[]>`
    select github_login from users where id = ${sponsorId}
  `;
  const scaffold = await insertClosedIssue({
    sponsorId,
    authorId: sponsorId,
    authorLogin: sponsor.github_login,
    settledEvidence: options.settledEvidence,
  });
  const actualPoints = options.actualPoints === undefined ? 4 : options.actualPoints;
  // Deliberately not the issue's 5: the queue must read this row's figure, and
  // an equal value would pass just as well against issues.opening_comparison_points.
  const [calibration] = await sql<{ id: string }[]>`
    insert into self_work_calibrations (
      pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
    )
    values (${scaffold.pullRequestId}, ${scaffold.issueId}, ${sponsorId}, 7, ${actualPoints})
    returning id
  `;
  return {
    calibrationId: calibration.id,
    issueId: scaffold.issueId,
    sponsorId,
    sponsorLogin: sponsor.github_login,
    pullRequestNumber: scaffold.pullRequestNumber,
    pullRequestTitle: scaffold.pullRequestTitle,
    pullRequestUrl: scaffold.pullRequestUrl,
  };
}

async function insertClosedIssue(input: {
  sponsorId: string;
  authorId: string;
  authorLogin: string;
  settledEvidence?: { label: string; points: number };
}): Promise<Scaffold> {
  const { sponsorId, authorId, authorLogin, settledEvidence } = input;
  const githubRepositoryId = nextExternalId();
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${githubRepositoryId}, ${`owner-${githubRepositoryId}/repository`}, ${sponsorId},
      ${"PUBLIC"}, ${nextExternalId()}, ${sql.json(difficultyScheme())}::jsonb
    )
    returning id
  `;
  const githubIssueId = nextExternalId();
  const issueNumber = nextExternalId();
  const issueTitle = `A disputed issue ${githubIssueId}`;
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${repository.id}, ${issueNumber}, ${issueTitle}, ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${issueNumber}`}, ${"CLOSED"}, ${"M"}, 5, 5
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const pullRequestNumber = nextExternalId();
  if (settledEvidence !== undefined) {
    // The settled columns are all-or-nothing under
    // issues_settled_evidence_complete_check, so the provenance goes in with
    // the label even though only the label and points are read back here.
    await sql`
      update issues
      set settled_label = ${settledEvidence.label},
          settled_points = ${settledEvidence.points},
          settled_label_event_id = ${`label-event-${githubIssueId}`},
          settled_label_actor_login = ${authorLogin},
          settled_label_applied_at = ${"2026-09-01T12:30:00.000Z"},
          settled_rationale_comment_id = ${`rationale-comment-${githubIssueId}`},
          settled_rationale_actor_login = ${authorLogin},
          settled_rationale_commented_at = ${"2026-09-01T12:45:00.000Z"}
      where id = ${issue.id}
    `;
  }
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, author_github_login, state, merged_at, proof_sha256
    )
    values (
      ${githubPullRequestId}, ${repository.id}, ${issue.id}, ${pullRequestNumber},
      ${`https://github.com/example/repository/pull/${pullRequestNumber}`},
      ${`A merged pull request ${githubPullRequestId}`}, ${"Pull request evidence"},
      ${authorId}, ${authorLogin}, ${"MERGED"}, ${"2026-09-01T12:00:00.000Z"},
      ${githubPullRequestId.toString(16).padStart(64, "0")}
    )
    returning id
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${repository.id})
  `;
  return {
    issueId: issue.id,
    issueNumber,
    issueTitle,
    pullRequestId: pullRequest.id,
    pullRequestNumber,
    pullRequestTitle: `A merged pull request ${githubPullRequestId}`,
    pullRequestUrl: `https://github.com/example/repository/pull/${pullRequestNumber}`,
  };
}
