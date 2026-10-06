import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEnforcementHistory } from "@/lib/dashboard/queries";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import type { SanctionContestDecision } from "@/lib/moderation/sanction-contest-service";
import { SanctionContestService } from "@/lib/moderation/sanction-contest-service";
import { PostgresSanctionContestStore } from "@/lib/moderation/sanction-contest-store";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 61_000;
let probeExternalId = 700_000;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "sanction_contest_test",
    user: "sanction_contest_test",
    password: "sanction_contest_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  delete process.env.DATABASE_URL;
});

describe("migration 061 — sanction_contest_requests", () => {
  it("creates the request table with the pinned columns", async () => {
    const columns = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, is_nullable, column_default
      from information_schema.columns
      where table_name = 'sanction_contest_requests'
      order by ordinal_position
    `;
    expect(columns).toEqual([
      { column_name: "id", is_nullable: "NO", column_default: "gen_random_uuid()" },
      { column_name: "account_id", is_nullable: "NO", column_default: null },
      { column_name: "sanction_event_id", is_nullable: "NO", column_default: null },
      { column_name: "request_reason", is_nullable: "NO", column_default: null },
      { column_name: "state", is_nullable: "NO", column_default: "'OPEN'::text" },
      { column_name: "decision", is_nullable: "YES", column_default: null },
      { column_name: "decided_by", is_nullable: "YES", column_default: null },
      { column_name: "decided_by_sole_moderator", is_nullable: "NO", column_default: "false" },
      { column_name: "decided_reason", is_nullable: "YES", column_default: null },
      { column_name: "decided_at", is_nullable: "YES", column_default: null },
      { column_name: "created_at", is_nullable: "NO", column_default: "now()" },
    ]);

    const checkNames = await sql<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'sanction_contest_requests'::regclass
        and contype = 'c' and conname like 'sanction_contest_requests_%'
      order by conname
    `;
    expect(checkNames.map((row) => row.conname)).toEqual([
      "sanction_contest_requests_decided_reason_length_check",
      "sanction_contest_requests_decided_reason_nonblank_check",
      "sanction_contest_requests_decision_allowed_check",
      "sanction_contest_requests_decision_complete_check",
      "sanction_contest_requests_request_reason_length_check",
      "sanction_contest_requests_request_reason_nonblank_check",
      "sanction_contest_requests_state_allowed_check",
    ]);

    const foreignKeys = await sql<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'sanction_contest_requests'::regclass and contype = 'f'
      order by conname
    `;
    expect(foreignKeys.map((row) => row.conname)).toEqual([
      "sanction_contest_requests_account_id_fkey",
      "sanction_contest_requests_decided_by_fkey",
      "sanction_contest_requests_sanction_event_id_fkey",
    ]);

    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where tablename = 'sanction_contest_requests' order by indexname
    `;
    expect(indexes.map((row) => row.indexname)).toContain("sanction_contest_requests_one_open_per_sanction");
  });

  it("adds the nullable contest_request_id link column to moderation_events", async () => {
    const columns = await sql<{ column_name: string; data_type: string; is_nullable: string }[]>`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_name = 'moderation_events' and column_name = 'contest_request_id'
    `;
    expect(columns).toEqual([{ column_name: "contest_request_id", data_type: "uuid", is_nullable: "YES" }]);

    const foreignKeys = await sql<{ conname: string; references: string }[]>`
      select conname, confrelid::regclass::text as references
      from pg_constraint
      where conrelid = 'moderation_events'::regclass and conname like '%contest_request%'
    `;
    expect(foreignKeys).toEqual([
      { conname: "moderation_events_contest_request_id_fkey", references: "sanction_contest_requests" },
    ]);
  });

  it("holds the one-open-per-sanction rule against a manual second OPEN insert", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "RECALIBRATING");
    const sanctionEvent = await liveSanctionEvent(accountId);

    const first = await sql<{ id: string }[]>`
      insert into sanction_contest_requests (account_id, sanction_event_id, request_reason)
      values (${accountId}, ${sanctionEvent.id}, ${"The evidence was reviewed twice."})
      returning id
    `;
    expect(first).toHaveLength(1);
    await expect(
      sql`
        insert into sanction_contest_requests (account_id, sanction_event_id, request_reason)
        values (${accountId}, ${sanctionEvent.id}, ${"A second open request must lose to the partial index."})
      `,
    ).rejects.toThrowError(/sanction_contest_requests_one_open_per_sanction/);
  });
});

describe("sanction contest store", () => {
  it("files a contest on a live sanctioned account and writes the filing moderation event", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "RECALIBRATING");
    const sanctionEvent = await liveSanctionEvent(accountId);

    const result = await store().fileSanctionContest({
      accountId,
      sanctionEventId: sanctionEvent.id,
      reason: "The cited review rounds were counted from the same reviewer twice.",
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      throw new Error("Expected the filing to succeed.");
    }
    const filed = result.value;
    expect(filed.state).toBe("OPEN");
    expect(filed.accountId).toBe(accountId);
    expect(filed.sanctionEventId).toBe(sanctionEvent.id);
    expect(filed.requestReason).toBe("The cited review rounds were counted from the same reviewer twice.");
    expect(filed.decision).toBeNull();
    expect(filed.decidedBy).toBeNull();
    expect(filed.decidedBySoleModerator).toBe(false);
    expect(filed.decidedReason).toBeNull();
    expect(filed.decidedAt).toBeNull();

    const events = await sql<{
      target_user_id: string;
      actor_id: string;
      audit_id: string | null;
      prior_state: string;
      new_state: string;
      reason: string;
      contest_request_id: string | null;
      credential_kind: string | null;
      credential_token_id: string | null;
    }[]>`
      select target_user_id, actor_id, audit_id, prior_state::text, new_state::text,
             reason, contest_request_id, credential_kind, credential_token_id
      from moderation_events
      where contest_request_id = ${filed.id}
    `;
    expect(events).toEqual([
      {
        target_user_id: accountId,
        actor_id: accountId,
        audit_id: null,
        prior_state: "RECALIBRATING",
        new_state: "RECALIBRATING",
        reason: "The cited review rounds were counted from the same reviewer twice.",
        contest_request_id: filed.id,
        credential_kind: null,
        credential_token_id: null,
      },
    ]);
  }, 60_000);

  it("refuses an account that is not the sanctioned account on the event", async () => {
    const sanctionedId = await insertUser("MEMBER");
    const outsiderId = await insertUser("MEMBER");
    await sanctionAccount(sanctionedId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(sanctionedId);

    await expect(
      store().fileSanctionContest({
        accountId: outsiderId,
        sanctionEventId: sanctionEvent.id,
        reason: "Not my sanction.",
      }),
    ).resolves.toEqual({ kind: "invalid_state" });
  });

  it("refuses an event whose state is not a sanction at all", async () => {
    const accountId = await insertUser("MEMBER");
    const auditId = await openAudit(accountId);
    await sql`
      insert into moderation_events (target_user_id, actor_id, audit_id, prior_state, new_state, reason)
      values (${accountId}, ${accountId}, ${auditId}, ${"ACTIVE"}, ${"UNDER_AUDIT"}, ${"Audit opened."})
    `;
    const [auditEvent] = await sql<{ id: string }[]>`
      select id from moderation_events where audit_id = ${auditId}
    `;
    if (auditEvent === undefined) {
      throw new Error("Expected the audit event to exist.");
    }

    await expect(
      store().fileSanctionContest({
        accountId,
        sanctionEventId: auditEvent.id,
        reason: "An audit is not a sanction.",
      }),
    ).resolves.toEqual({ kind: "invalid_state" });
  });

  it("refuses when the sanction is no longer the account's live state", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);
    await sql`update users set enforcement_state = ${"ACTIVE"} where id = ${accountId}`;

    await expect(
      store().fileSanctionContest({
        accountId,
        sanctionEventId: sanctionEvent.id,
        reason: "The sanction was reversed, so a contest targets nothing live.",
      }),
    ).resolves.toEqual({ kind: "invalid_state" });
  });

  it("refuses an unknown account and an unknown event", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);

    await expect(
      store().fileSanctionContest({
        accountId: "00000000-0000-4000-8000-ffffffffffff",
        sanctionEventId: sanctionEvent.id,
        reason: "No such account.",
      }),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      store().fileSanctionContest({
        accountId,
        sanctionEventId: "00000000-0000-4000-8000-ffffffffffff",
        reason: "No such event.",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("enforces one open request per sanction, and permits a fresh one after a decision", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);
    const contestStore = store();

    const first = await contestStore.fileSanctionContest({
      accountId,
      sanctionEventId: sanctionEvent.id,
      reason: "First request.",
    });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") {
      throw new Error("Expected the first filing to succeed.");
    }
    await expect(
      contestStore.fileSanctionContest({ accountId, sanctionEventId: sanctionEvent.id, reason: "Second while open." }),
    ).resolves.toEqual({ kind: "invalid_state" });

    // A DECIDED row leaves the partial index's OPEN slice, so a fresh request
    // on the same sanction is permitted again.
    const decidedRows = await sql<{ id: string }[]>`
      update sanction_contest_requests
      set state = ${"DECIDED"}, decision = ${"DENIED"}, decided_by = ${await insertModerator()},
          decided_by_sole_moderator = ${true}, decided_reason = ${"The sanction stands."},
          decided_at = now()
      where id = ${first.value.id}
      returning id
    `;
    expect(decidedRows).toHaveLength(1);
    await expect(
      contestStore.fileSanctionContest({
        accountId,
        sanctionEventId: sanctionEvent.id,
        reason: "Fresh after the decision.",
      }),
    ).resolves.toMatchObject({ kind: "ok" });
  }, 60_000);

  it("leaves participation eligibility unchanged by the filing event, and lists it in the console history", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "RECALIBRATING");
    const sanctionEvent = await liveSanctionEvent(accountId);

    const beforePast = await eligibilityAt(accountId, new Date(Date.now() - 60_000));
    const beforeNow = await eligibilityAt(accountId, new Date());
    const beforeFuture = await eligibilityAt(accountId, new Date(Date.now() + 60_000));

    const result = await store().fileSanctionContest({
      accountId,
      sanctionEventId: sanctionEvent.id,
      reason: "A filing event is a same-state no-op for the fold.",
    });
    expect(result.kind).toBe("ok");

    const afterPast = await eligibilityAt(accountId, new Date(Date.now() - 120_000));
    const afterNow = await eligibilityAt(accountId, new Date());
    const afterFuture = await eligibilityAt(accountId, new Date(Date.now() + 60_000));
    expect(afterPast).toEqual(beforePast);
    expect(afterNow).toEqual(beforeNow);
    expect(afterFuture).toEqual(beforeFuture);
    expect(afterNow).toBe(false);

    const history = await listEnforcementHistory();
    const filing = history.find((entry) => entry.reason === "A filing event is a same-state no-op for the fold.");
    expect(filing).toBeDefined();
    expect(filing).toMatchObject({
      targetAccountId: accountId,
      actorLogin: expect.any(String),
      priorState: "RECALIBRATING",
      newState: "RECALIBRATING",
    });
  }, 60_000);

  it("lists the account's own requests, newest first, with decided outcomes", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);
    const contestStore = store();

    const older = await contestStore.fileSanctionContest({ accountId, sanctionEventId: sanctionEvent.id, reason: "Older." });
    expect(older.kind).toBe("ok");
    if (older.kind !== "ok") {
      throw new Error("Expected the older filing to succeed.");
    }
    await sql`
      update sanction_contest_requests
      set state = ${"DECIDED"}, decision = ${"GRANTED"}, decided_by = ${await insertModerator()},
          decided_reason = ${"The recalibration was wrong."}, decided_at = ${new Date("2026-01-01T00:00:00.000Z")}
      where id = ${older.value.id}
    `;
    // Stamp an older created_at so the ordering pin does not lean on two
    // same-instant inserts; the second request is filed after and reads first.
    await sql`
      update sanction_contest_requests
      set created_at = ${new Date("2025-06-01T00:00:00.000Z")}
      where id = ${older.value.id}
    `;

    const newer = await contestStore.fileSanctionContest({ accountId, sanctionEventId: sanctionEvent.id, reason: "Newer." });
    expect(newer.kind).toBe("ok");
    if (newer.kind !== "ok") {
      throw new Error("Expected the newer filing to succeed.");
    }

    const listed = await contestStore.listRequestsForAccount(accountId);
    expect(listed.map((request) => request.id)).toEqual([newer.value.id, older.value.id]);
    const decided = listed.find((request) => request.id === older.value.id);
    expect(decided).toMatchObject({
      state: "DECIDED",
      decision: "GRANTED",
      decidedBySoleModerator: false,
      decidedReason: "The recalibration was wrong.",
      decidedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("lists the account's live sanctions as the form's candidates", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "RECALIBRATING");
    const sanctionEvent = await liveSanctionEvent(accountId);

    await expect(store().listFileableSanctions(accountId)).resolves.toEqual([
      {
        id: sanctionEvent.id,
        newState: "RECALIBRATING",
        reason: sanctionEvent.reason,
        occurredAt: expect.any(String),
      },
    ]);

    // An ACTIVE account has no live sanction to contest.
    const activeId = await insertUser("MEMBER");
    await expect(store().listFileableSanctions(activeId)).resolves.toEqual([]);
  });

  it("refuses a blank reason through the service's normalizer", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);
    const service = new SanctionContestService(store());

    for (const blank of ["", "   "]) {
      await expect(
        service.fileSanctionContest({ id: accountId }, { sanctionEventId: sanctionEvent.id, reason: blank }),
      ).rejects.toMatchObject({ name: "SanctionContestError", code: "INVALID_INPUT" });
    }
    await expect(
      sql<{ count: number }[]>`
        select count(*)::int as count from sanction_contest_requests where account_id = ${accountId}
      `,
    ).resolves.toEqual([{ count: 0 }]);
  });

  it("maps the store's refusals onto the service's error codes", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);
    const service = new SanctionContestService(store());

    const first = await service.fileSanctionContest(
      { id: accountId },
      { sanctionEventId: sanctionEvent.id, reason: "First request." },
    );
    expect(first.state).toBe("OPEN");
    await expect(
      service.fileSanctionContest({ id: accountId }, { sanctionEventId: sanctionEvent.id, reason: "Second." }),
    ).rejects.toMatchObject({ name: "SanctionContestError", code: "CONFLICT" });
    await expect(
      service.fileSanctionContest(
        { id: accountId },
        { sanctionEventId: "00000000-0000-4000-8000-ffffffffffff", reason: "Missing event." },
      ),
    ).rejects.toMatchObject({ name: "SanctionContestError", code: "NOT_FOUND" });
  });

  it("refuses to list another account's contests through the account-scoped read", async () => {
    const mineId = await insertUser("MEMBER");
    const theirsId = await insertUser("MEMBER");
    await sanctionAccount(mineId, "BANNED");
    await sanctionAccount(theirsId, "BANNED");
    const mineEvent = await liveSanctionEvent(mineId);
    const theirsEvent = await liveSanctionEvent(theirsId);
    const contestStore = store();

    const mine = await contestStore.fileSanctionContest({ accountId: mineId, sanctionEventId: mineEvent.id, reason: "Mine." });
    const theirs = await contestStore.fileSanctionContest({
      accountId: theirsId,
      sanctionEventId: theirsEvent.id,
      reason: "Theirs.",
    });
    expect(mine.kind).toBe("ok");
    expect(theirs.kind).toBe("ok");
    if (mine.kind !== "ok" || theirs.kind !== "ok") {
      throw new Error("Expected both filings to succeed.");
    }

    const mineList = await contestStore.listRequestsForAccount(mineId);
    expect(mineList.map((request) => request.id)).toEqual([mine.value.id]);
    expect(mineList.map((request) => request.id)).not.toContain(theirs.value.id);
  });
});

function store(): PostgresSanctionContestStore {
  return new PostgresSanctionContestStore(sql);
}

async function fileOpenRequest(accountId: string, sanctionEventId: string, reason: string): Promise<string> {
  const result = await store().fileSanctionContest({ accountId, sanctionEventId, reason });
  if (result.kind !== "ok") {
    throw new Error(`Expected the filing to succeed, got ${result.kind}.`);
  }
  return result.value.id;
}

async function decide(
  requestId: string,
  moderatorAccountId: string,
  decision: SanctionContestDecision,
  decidedReason: string,
): Promise<Awaited<ReturnType<PostgresSanctionContestStore["decideSanctionContest"]>>> {
  return store().decideSanctionContest({ requestId, moderatorAccountId, decision, decidedReason });
}

async function readRequestRow(requestId: string) {
  const [row] = await sql<
    { state: string; decision: string | null; decided_by: string | null; decided_by_sole_moderator: boolean; decided_reason: string | null }[]
  >`
    select state::text, decision::text, decided_by, decided_by_sole_moderator, decided_reason
    from sanction_contest_requests where id = ${requestId}
  `;
  if (row === undefined) {
    throw new Error("Expected the request row to exist.");
  }
  return row;
}

describe("sanction contest decision path", () => {
  it("refuses the imposer while another live moderator exists, writing no decision", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const otherModeratorId = await insertModerator();
    // The precondition the refusal rests on, asserted the way the store reads
    // it: the live roster holds exactly the imposer and this second moderator,
    // so the imposer decides while another live moderator exists. The sanity
    // line this replaces — expect(otherModeratorId).toBeDefined() — could not
    // fail: insertModerator returns a fresh id or the insert throws, so the
    // assertion proved nothing the test was not already crashing on.
    const roster = await sql<{ id: string }[]>`
      select id from users where role = 'MODERATOR' and deleted_at is null
    `;
    expect(roster.map((row) => row.id).sort()).toEqual([imposerId, otherModeratorId].sort());
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "The imposer's read was the only one.");

    const result = await decide(requestId, imposerId, "DENIED", "The sanction stands.");
    expect(result).toEqual({ kind: "forbidden_imposer" });

    const row = await readRequestRow(requestId);
    expect(row).toMatchObject({ state: "OPEN", decision: null, decided_by: null, decided_reason: null });
  }, 60_000);

  it("allows the imposer as the sole live moderator and records that on the request", async () => {
    await retireLiveModerators();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    // With every other moderator retired, the fresh sanction's actor is the
    // only live moderator left.
    const sanctionEvent = await liveSanctionEvent(accountId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "One moderator, both hats.");

    const result = await decide(requestId, sanctionEvent.imposerId, "GRANTED", "The pattern does not hold.");
    expect(result).toMatchObject({ kind: "ok" });
    if (result.kind !== "ok") {
      throw new Error("Expected the sole-moderator decision to succeed.");
    }
    expect(result.value.decidedBySoleModerator).toBe(true);
    expect(result.value.decidedBy).toBe(sanctionEvent.imposerId);

    const row = await readRequestRow(requestId);
    expect(row).toMatchObject({
      state: "DECIDED",
      decision: "GRANTED",
      decided_by: sanctionEvent.imposerId,
      decided_by_sole_moderator: true,
      decided_reason: "The pattern does not hold.",
    });
  }, 60_000);

  it("lets a non-imposing moderator decide freely with the flag false", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);

    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "A second moderator can review it.");
    const result = await decide(requestId, deciderId, "DENIED", "The confirmed patterns persist.");
    expect(result).toMatchObject({ kind: "ok" });
    if (result.kind !== "ok") {
      throw new Error("Expected the non-imposer decision to succeed.");
    }
    expect(result.value.decidedBySoleModerator).toBe(false);
    expect(result.value.decidedBy).toBe(deciderId);
  }, 60_000);

  it("records the sole-moderator flag when the only live moderator is not the imposer", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const soleDeciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    // Retire the imposer too, leaving the fresh decider as the only live
    // moderator: a sole non-imposer decides freely, and the record says the
    // decision came from the only live moderator.
    await sql`update users set deleted_at = now() where id = ${imposerId}`;

    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "The remaining moderator reviews it.");
    const result = await decide(requestId, soleDeciderId, "GRANTED", "The recalibration was miscounted.");
    expect(result).toMatchObject({ kind: "ok" });
    if (result.kind !== "ok") {
      throw new Error("Expected the sole non-imposer decision to succeed.");
    }
    expect(result.value.decidedBySoleModerator).toBe(true);
  }, 60_000);

  it("refuses a second decision on an already decided request", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "First decision takes it.");
    const first = await decide(requestId, imposerId, "DENIED", "The sanction stands.");
    expect(first).toMatchObject({ kind: "ok" });

    const second = await decide(requestId, imposerId, "GRANTED", "Too late to change it.");
    // Its own answer, not the filing path's shared invalid_state: the
    // decision route carries this cause out with the already-decided message,
    // not the cannot-contest one a filer sees.
    expect(second).toEqual({ kind: "already_decided" });
    await expect(
      new SanctionContestService(store()).decideContest(
        { id: imposerId },
        { requestId, decision: "DENIED", reason: "Too late to change it." },
      ),
    ).rejects.toMatchObject({
      name: "SanctionContestError",
      code: "CONFLICT",
      message: "This contest request has already been decided.",
    });
  }, 60_000);

  it("answers not_found for an unknown request", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    await liveSanctionEvent(accountId);

    await expect(
      decide("00000000-0000-4000-8000-ffffffffffff", await insertModerator(), "DENIED", "No such request."),
    ).resolves.toEqual({ kind: "not_found" });
  }, 60_000);

  it("refuses a blank decided reason before touching the request", async () => {
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const sanctionEvent = await liveSanctionEvent(accountId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "A decision carries its reason.");

    const result = await decide(requestId, await insertModerator(), "DENIED", "   ");
    expect(result).toEqual({ kind: "invalid_input" });

    const row = await readRequestRow(requestId);
    expect(row).toMatchObject({ state: "OPEN", decision: null });
  }, 60_000);

  it("writes the decision event with the deciding moderator as actor and restores eligibility on a grant, and reads back exactly", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "RECALIBRATING");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "The cohort was not representative.");

    const beforeNow = await eligibilityAt(accountId, new Date());
    expect(beforeNow).toBe(false);

    const result = await decide(requestId, imposerId, "GRANTED", "The audit overcounted.");
    expect(result).toMatchObject({ kind: "ok" });

    const events = await sql<
      { target_user_id: string; actor_id: string; audit_id: string | null; prior_state: string; new_state: string; reason: string; contest_request_id: string | null; credential_kind: string | null; credential_token_id: string | null }[]
    >`
      select target_user_id, actor_id, audit_id, prior_state::text, new_state::text,
             reason, contest_request_id, credential_kind, credential_token_id
      from moderation_events
      where contest_request_id = ${requestId}
        and actor_id = ${imposerId}
        and prior_state::text = ${"RECALIBRATING"}
        and new_state::text = ${"RECALIBRATING"}
    `;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      target_user_id: accountId,
      actor_id: imposerId,
      audit_id: null,
      prior_state: "RECALIBRATING",
      new_state: "RECALIBRATING",
      reason: "The audit overcounted.",
      contest_request_id: requestId,
      credential_kind: null,
      credential_token_id: null,
    });

    // The grant lifted the live sanction in the decision's transaction: the
    // reversal event moved the account RECALIBRATING → ACTIVE, so eligibility
    // resumes with the already-decided test's shape — at the lift event, not
    // at the same-state decision event.
    const afterNow = await eligibilityAt(accountId, new Date());
    expect(afterNow).toBe(true);
    const afterFuture = await eligibilityAt(accountId, new Date(Date.now() + 60_000));
    expect(afterFuture).toBe(true);

    const listed = await store().listRequestsForAccount(accountId);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: requestId,
      state: "DECIDED",
      decision: "GRANTED",
      decidedBy: imposerId,
      // The imposer here is the file's only live moderator (retireLiveModerators
      // ran above), so the record says a sole moderator decided.
      decidedBySoleModerator: true,
      decidedReason: "The audit overcounted.",
    });
    expect(listed[0]?.decidedAt).toEqual(expect.any(String));
  }, 60_000);

  it("lists open requests for the moderation queue with account, sanction state, reason and filed date", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const sanctionedId = await insertUser("MEMBER");
    await sanctionAccount(sanctionedId, "BANNED");
    const openEvent = await sanctionEventBy(sanctionedId, imposerId);
    const openRequestId = await fileOpenRequest(sanctionedId, openEvent.id, "Still waiting for a moderator.");

    const decidedId = await insertUser("MEMBER");
    await sanctionAccount(decidedId, "BANNED");
    const decidedEvent = await sanctionEventBy(decidedId, imposerId);
    const decidedRequestId = await fileOpenRequest(decidedId, decidedEvent.id, "Decided while the queue is watched.");
    const decidedResult = await decide(decidedRequestId, deciderId, "DENIED", "The patterns persist.");
    expect(decidedResult).toMatchObject({ kind: "ok" });

    const open = await store().listOpenContestRequests();
    const mine = open.find((entry) => entry.requestId === openRequestId);
    expect(mine).toMatchObject({
      requestId: openRequestId,
      accountId: sanctionedId,
      sanctionState: "BANNED",
      requestReason: "Still waiting for a moderator.",
    });
    expect(mine?.accountLogin).toEqual(expect.any(String));
    expect(mine?.filedAt).toEqual(expect.any(String));
    // The decided request has left the queue.
    expect(open.map((entry) => entry.requestId)).not.toContain(decidedRequestId);
  }, 60_000);
});

describe("sanction contest grant lifts the sanction (issue 1134)", () => {
  it("grants a contest on a live BANNED sanction: lifts to ACTIVE, reactivates the flagged scope, and journals both events", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const flaggedId = await insertProbeRepository(accountId, "flagged");
    const activeId = await insertProbeRepository(accountId, "active");
    const otherReasonId = await insertProbeRepository(accountId, "inactive");
    const unregisteredId = await insertProbeRepository(accountId, "unregistered");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "The ban outran its evidence.");

    const result = await decide(requestId, deciderId, "GRANTED", "The re-review cleared the pattern.");
    expect(result).toMatchObject({ kind: "ok" });

    // The account is ACTIVE and the reactivation is the reversal's own scope:
    // the rows the sanction flagged come back, a row inactive for any other
    // reason and a row the sponsor left stay exactly as they were.
    expect(await enforcementState(accountId)).toBe("ACTIVE");
    expect(await probeRepositoryShapes(accountId)).toEqual(expect.arrayContaining([
      { id: flaggedId, active: true, flag: null, unregistered: false },
      { id: activeId, active: true, flag: null, unregistered: false },
      { id: otherReasonId, active: false, flag: null, unregistered: false },
      { id: unregisteredId, active: false, flag: null, unregistered: true },
    ]));

    // Two events cite the request: the decision (same-state history) and the
    // reversal (BANNED → ACTIVE), the latter through the 1072 path's shape —
    // the deciding moderator as actor, the decided reason, the request's id.
    const decisionEvents = await contestEvents(requestId, "BANNED", "BANNED", deciderId);
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]).toMatchObject({
      target_user_id: accountId,
      actor_id: deciderId,
      audit_id: null,
      reason: "The re-review cleared the pattern.",
      credential_kind: null,
      credential_token_id: null,
      recalibration_plan: null,
    });
    const liftEvents = await contestEvents(requestId, "BANNED", "ACTIVE", deciderId);
    expect(liftEvents).toHaveLength(1);
    expect(liftEvents[0]).toMatchObject({
      target_user_id: accountId,
      actor_id: deciderId,
      audit_id: null,
      reason: "The re-review cleared the pattern.",
      contest_request_id: requestId,
      credential_kind: null,
      credential_token_id: null,
      recalibration_plan: null,
    });

    // Eligibility resumes with the lift event, not the same-state decision.
    expect(await eligibilityAt(accountId, new Date())).toBe(true);
  }, 60_000);

  it("grants a contest on a live RECALIBRATING sanction through closeRecalibration's reactivation scope", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "RECALIBRATING");
    const flaggedId = await insertProbeRepository(accountId, "flagged");
    const activeId = await insertProbeRepository(accountId, "active");
    const plainInactiveId = await insertProbeRepository(accountId, "inactive");
    const unregisteredId = await insertProbeRepository(accountId, "unregistered");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "The recalibration was miscounted.");

    const result = await decide(requestId, deciderId, "GRANTED", "The cohort was not representative.");
    expect(result).toMatchObject({ kind: "ok" });

    // The closure's scope, not the reversal's: every inactive row that has not
    // been unregistered comes back, flagged or not.
    expect(await enforcementState(accountId)).toBe("ACTIVE");
    expect(await probeRepositoryShapes(accountId)).toEqual(expect.arrayContaining([
      { id: flaggedId, active: true, flag: null, unregistered: false },
      { id: activeId, active: true, flag: null, unregistered: false },
      { id: plainInactiveId, active: true, flag: null, unregistered: false },
      { id: unregisteredId, active: false, flag: null, unregistered: true },
    ]));

    const liftEvents = await contestEvents(requestId, "RECALIBRATING", "ACTIVE");
    expect(liftEvents).toHaveLength(1);
    expect(liftEvents[0]).toMatchObject({
      target_user_id: accountId,
      actor_id: deciderId,
      audit_id: null,
      reason: "The cohort was not representative.",
      contest_request_id: requestId,
    });
  }, 60_000);

  it("records an already-gone grant: the grant lands, the lift is skipped, no lift event is written", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const flaggedId = await insertProbeRepository(accountId, "flagged");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "Too late — the reversal got there first.");

    // A reversal commits between the filing and the decision, leaving the
    // account ACTIVE: the contested sanction is gone when the grant lands.
    await sql`update users set enforcement_state = ${"ACTIVE"} where id = ${accountId}`;

    const result = await decide(requestId, deciderId, "GRANTED", "Granted after the fact.");
    // Its own kind, not ok: the decision was recorded but nothing was lifted.
    expect(result).toEqual({ kind: "already_gone", value: expect.objectContaining({ id: requestId }) });

    // The request row says GRANTED and the decision event cites it, but no
    // event moved the account and the repositories are untouched.
    expect(await readRequestRow(requestId)).toMatchObject({ state: "DECIDED", decision: "GRANTED" });
    const decisionEvents = await contestEvents(requestId, "BANNED", "BANNED", deciderId);
    expect(decisionEvents).toHaveLength(1);
    expect(await contestEvents(requestId, "BANNED", "ACTIVE")).toHaveLength(0);
    expect(await enforcementState(accountId)).toBe("ACTIVE");
    expect(await probeRepositoryShapes(accountId)).toEqual([
      { id: flaggedId, active: false, flag: expect.any(Date), unregistered: false },
    ]);
  }, 60_000);

  it("denies a contest without touching the sanction", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    const flaggedId = await insertProbeRepository(accountId, "flagged");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "Please lift it anyway.");

    const result = await decide(requestId, deciderId, "DENIED", "The confirmed patterns persist.");
    expect(result).toMatchObject({ kind: "ok" });

    expect(await enforcementState(accountId)).toBe("BANNED");
    expect(await probeRepositoryShapes(accountId)).toEqual([
      { id: flaggedId, active: false, flag: expect.any(Date), unregistered: false },
    ]);
    const decisionEvents = await contestEvents(requestId, "BANNED", "BANNED", deciderId);
    expect(decisionEvents).toHaveLength(1);
    expect(await contestEvents(requestId, "BANNED", "ACTIVE")).toHaveLength(0);
  }, 60_000);

  it("takes the already-gone path when a ban reversal commits before the grant", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const moderatorId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    await insertProbeRepository(accountId, "flagged");
    await insertSubstantiatedAudit(accountId);
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "Filed before the reversal landed.");

    // The 1072 reversal commits first, in its own transaction.
    const moderationStore = new PostgresModerationStore(sql);
    await expect(moderationStore.reverseBan({
      actorId: moderatorId,
      targetAccountId: accountId,
      reason: "The reversal won the race.",
      credential: null,
    })).resolves.toMatchObject({ kind: "ok", value: { priorState: "BANNED", targetState: "ACTIVE" } });

    // The grant then reads the moved-on state under the row lock and takes
    // the already-gone path instead of lifting a sanction that is not there.
    const result = await decide(requestId, deciderId, "GRANTED", "The grant arrived second.");
    expect(result.kind).toBe("already_gone");
    expect(await enforcementState(accountId)).toBe("ACTIVE");
    expect(await contestEvents(requestId, "BANNED", "ACTIVE")).toHaveLength(0);
    expect(await contestEvents(requestId, "BANNED", "BANNED", deciderId)).toHaveLength(1);
  }, 60_000);

  it("refuses a subsequent ban reversal once a grant has lifted the sanction", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const moderatorId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    await insertProbeRepository(accountId, "flagged");
    await insertSubstantiatedAudit(accountId);
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "The grant won the race.");

    const result = await decide(requestId, deciderId, "GRANTED", "The grant lifted it first.");
    expect(result).toMatchObject({ kind: "ok" });
    expect(await enforcementState(accountId)).toBe("ACTIVE");

    // The same row lock that ran the lift makes the later reversal read the
    // ACTIVE state and refuse on its own state gate.
    const moderationStore = new PostgresModerationStore(sql);
    await expect(moderationStore.reverseBan({
      actorId: moderatorId,
      targetAccountId: accountId,
      reason: "Nothing left to reverse.",
      credential: null,
    })).resolves.toEqual({ kind: "invalid_state" });
  }, 60_000);

  it("leaves no granted-but-still-sanctioned account: the decision and the lift commit together", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const accountId = await insertUser("MEMBER");
    await sanctionAccount(accountId, "BANNED");
    await insertProbeRepository(accountId, "flagged");
    const sanctionEvent = await sanctionEventBy(accountId, imposerId);
    const requestId = await fileOpenRequest(accountId, sanctionEvent.id, "One transaction or none.");

    // The store's result and the post-state are pinned together: an ok on a
    // live sanction commits the lift in the same transaction, so there is no
    // reachable state where the store says ok and the account is still
    // sanctioned.
    const result = await decide(requestId, deciderId, "GRANTED", "Granted and lifted at once.");
    expect(result.kind).toBe("ok");
    expect(await enforcementState(accountId)).toBe("ACTIVE");
    expect(await contestEvents(requestId, "BANNED", "ACTIVE")).toHaveLength(1);
  }, 60_000);

  it("maps the grant's effects onto the service's decision outcome", async () => {
    await retireLiveModerators();
    const imposerId = await insertModerator();
    const deciderId = await insertModerator();
    const service = new SanctionContestService(store());

    // A grant on a live sanction lifts it.
    const liveId = await insertUser("MEMBER");
    await sanctionAccount(liveId, "BANNED");
    const liveEvent = await sanctionEventBy(liveId, imposerId);
    const liveRequestId = await fileOpenRequest(liveId, liveEvent.id, "Live when granted.");
    await expect(
      service.decideContest({ id: deciderId }, { requestId: liveRequestId, decision: "GRANTED", reason: "Lifted now." }),
    ).resolves.toMatchObject({ effect: "lifted", request: { id: liveRequestId, decision: "GRANTED" } });
    expect(await enforcementState(liveId)).toBe("ACTIVE");

    // A grant on an already-lifted sanction reports already-gone.
    const goneId = await insertUser("MEMBER");
    await sanctionAccount(goneId, "BANNED");
    const goneEvent = await sanctionEventBy(goneId, imposerId);
    const goneRequestId = await fileOpenRequest(goneId, goneEvent.id, "Gone when granted.");
    await sql`update users set enforcement_state = ${"ACTIVE"} where id = ${goneId}`;
    await expect(
      service.decideContest({ id: deciderId }, { requestId: goneRequestId, decision: "GRANTED", reason: "Gone already." }),
    ).resolves.toMatchObject({ effect: "already_gone", request: { id: goneRequestId, decision: "GRANTED" } });

    // A denial records without an effect on the sanction.
    const deniedId = await insertUser("MEMBER");
    await sanctionAccount(deniedId, "BANNED");
    const deniedEvent = await sanctionEventBy(deniedId, imposerId);
    const deniedRequestId = await fileOpenRequest(deniedId, deniedEvent.id, "Denied.");
    await expect(
      service.decideContest({ id: deciderId }, { requestId: deniedRequestId, decision: "DENIED", reason: "It stands." }),
    ).resolves.toMatchObject({ effect: "recorded", request: { id: deniedRequestId, decision: "DENIED" } });
    expect(await enforcementState(deniedId)).toBe("BANNED");
  }, 60_000);
});

/** Reads the account's enforcement state, the way the concurrency pins compare post-state. */
async function enforcementState(accountId: string): Promise<string> {
  const [row] = await sql<{ enforcement_state: string }[]>`
    select enforcement_state::text from users where id = ${accountId}
  `;
  if (row === undefined) {
    throw new Error("Expected the account to exist.");
  }
  return row.enforcement_state;
}

/** Reads the contest-cited events between the two named states by the named actor. */
async function contestEvents(requestId: string, priorState: string, newState: string, actorId?: string) {
  return sql<
    {
      target_user_id: string;
      actor_id: string;
      audit_id: string | null;
      prior_state: string;
      new_state: string;
      reason: string;
      contest_request_id: string | null;
      credential_kind: string | null;
      credential_token_id: string | null;
      recalibration_plan: string | null;
    }[]
  >`
    select target_user_id, actor_id, audit_id, prior_state::text, new_state::text,
           reason, contest_request_id, credential_kind, credential_token_id, recalibration_plan
    from moderation_events
    where contest_request_id = ${requestId}
      and prior_state::text = ${priorState}
      and new_state::text = ${newState}
      and (${actorId === undefined} or actor_id = ${actorId ?? requestId})
  `;
}

/**
 * Inserts a repository probe in one of the four shapes the reactivation scopes
 * read: active, flagged (sanction-deactivated), inactive for another reason,
 * and unregistered by the sponsor.
 */
async function insertProbeRepository(
  sponsorId: string,
  shape: "active" | "flagged" | "inactive" | "unregistered",
): Promise<string> {
  const githubRepositoryId = probeExternalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
      active, unregistered_at, sanction_deactivated_at
    )
    values (
      ${githubRepositoryId}, ${`example/probe-${githubRepositoryId}`}, ${sponsorId}, ${"PUBLIC"},
      ${probeExternalId + 500_000}, ${sql.json(probeDifficultyScheme())},
      ${shape === "active"},
      ${shape === "unregistered" ? new Date() : null},
      ${shape === "flagged" ? new Date() : null}
    )
    returning id
  `;
  return row!.id;
}

async function probeRepositoryShapes(accountId: string): Promise<Array<{ id: string; active: boolean; flag: Date | null; unregistered: boolean }>> {
  const rows = await sql<{ id: string; active: boolean; flag: Date | null; unregistered: boolean }[]>`
    select id, active, sanction_deactivated_at as flag, (unregistered_at is not null) as unregistered
    from registered_repositories
    where sponsor_id = ${accountId}
    order by id
  `;
  return rows;
}

function probeDifficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [{ label: "size/M", comparisonPoints: 4, reservePoints: 4 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

/**
 * Seeds the SUBSTANTIATED audit a 1072 reversal anchors on: the concurrency
 * pins drive the real reverseBan, which refuses a banned account with no
 * audit to anchor its event.
 */
async function insertSubstantiatedAudit(accountId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into calibration_audits (
      account_id, repository_id, reporter_id, moderator_id, state, rationale,
      sample_started_at, sample_ended_at, settled_sample_size, prior_enforcement_state,
      cohort_definition, cohort_statistics
    )
    values (
      ${accountId}, null, ${accountId}, ${accountId}, ${"SUBSTANTIATED"},
      ${"The audit behind the live ban."},
      ${new Date("2020-01-01T00:00:00.000Z")}, ${new Date("2030-01-01T00:00:00.000Z")}, 10, ${"ACTIVE"},
      ${sql.json({ sampleStartedAt: "2020-01-01T00:00:00.000Z", sampleEndedAt: "2030-01-01T00:00:00.000Z", selfWorkPairs: [], outsiderSettlementPairs: [] })},
      ${sql.json({ selfWork: { count: 0, meanDelta: 0, medianDelta: 0 }, outsider: { count: 0, meanDelta: 0, medianDelta: 0 }, differenceBetweenMeans: 0 })}
    )
    returning id
  `;
  return row!.id;
}

async function eligibilityAt(accountId: string, at: Date): Promise<boolean> {
  const [row] = await sql<{ eligible: boolean }[]>`
    select participation_eligible_at(${accountId}, ${at}) as eligible
  `;
  if (row === undefined) {
    throw new Error("Eligibility probe returned no row.");
  }
  return row.eligible;
}

async function insertUser(role: "MEMBER" | "MODERATOR"): Promise<string> {
  const githubUserId = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, role)
    values (${githubUserId}, ${`contest-${githubUserId}`}, ${role})
    returning id
  `;
  return row!.id;
}

async function insertModerator(): Promise<string> {
  return insertUser("MODERATOR");
}

/** Stamps the account into a sanction state without writing a moderation event. */
async function sanctionAccount(accountId: string, state: "RECALIBRATING" | "BANNED"): Promise<void> {
  await sql`update users set enforcement_state = ${state} where id = ${accountId}`;
}

/**
 * Writes the sanction's own moderation event, the way a substantiation would,
 * anchored on the account's stamped enforcement state. The event's actor is a
 * fresh moderator — the imposer a decision path resolves.
 */
async function liveSanctionEvent(accountId: string): Promise<{ id: string; reason: string; imposerId: string }> {
  const [current] = await sql<{ enforcement_state: string }[]>`
    select enforcement_state::text from users where id = ${accountId}
  `;
  if (current === undefined) {
    throw new Error("Expected the sanctioned account to exist.");
  }
  const [row] = await sql<{ id: string; reason: string; actor_id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (
      ${accountId},
      ${await insertModerator()},
      ${"WARNED"},
      ${current.enforcement_state},
      ${`Sanction event ${externalId++} — the third confirmed pattern.`}
    )
    returning id, reason, actor_id
  `;
  const rowValue = row!;
  return { id: rowValue.id, reason: rowValue.reason, imposerId: rowValue.actor_id };
}

/**
 * Retires every live moderator so a test can pin the sole-moderator rule
 * against a known roster: role changes and deletions leave the live set to
 * whatever the file's earlier tests-insertions left behind otherwise.
 */
async function retireLiveModerators(): Promise<void> {
  await sql`update users set deleted_at = now() where role = ${"MODERATOR"} and deleted_at is null`;
}

/**
 * Writes the sanction event with an explicit imposer, the way a decision-path
 * test needs: the imposer is who the event's actor names, and the immutability
 * trigger forbids rewriting it afterwards.
 */
async function sanctionEventBy(accountId: string, imposerId: string): Promise<{ id: string; reason: string }> {
  const [current] = await sql<{ enforcement_state: string }[]>`
    select enforcement_state::text from users where id = ${accountId}
  `;
  if (current === undefined) {
    throw new Error("Expected the sanctioned account to exist.");
  }
  const [row] = await sql<{ id: string; reason: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (
      ${accountId},
      ${imposerId},
      ${"WARNED"},
      ${current.enforcement_state},
      ${`Sanction event ${externalId++} — the third confirmed pattern.`}
    )
    returning id, reason
  `;
  return row!;
}

async function openAudit(accountId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into calibration_audits (
      account_id, repository_id, reporter_id, moderator_id, state, rationale,
      sample_started_at, sample_ended_at, settled_sample_size, prior_enforcement_state
    )
    values (
      ${accountId}, null, ${accountId}, ${accountId}, ${"OPEN"},
      ${"Audit for the non-sanction event refusal."},
      ${new Date("2020-01-01T00:00:00.000Z")}, ${new Date("2030-01-01T00:00:00.000Z")}, 10, ${"ACTIVE"}
    )
    returning id
  `;
  return row!.id;
}
