import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listEnforcementHistory } from "@/lib/dashboard/queries";
import { SanctionContestService } from "@/lib/moderation/sanction-contest-service";
import { PostgresSanctionContestStore } from "@/lib/moderation/sanction-contest-store";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 61_000;

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
 * anchored on the account's stamped enforcement state.
 */
async function liveSanctionEvent(accountId: string): Promise<{ id: string; reason: string }> {
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
      ${await insertModerator()},
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
