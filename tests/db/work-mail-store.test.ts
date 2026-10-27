import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresWorkMailStore, deleteAllWorkMailData, reserveDailySend } from "@/lib/accounts/work-mail-store";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";

let sql: Sql;
let container: StartedTestContainer;
let store: PostgresWorkMailStore;
const original = process.env.OVERFLOW_DATABASE_URL;
const tokenKey = randomBytes(32).toString("base64url");
const limits = { dailyLimit: 100 };
let seed = 0;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "work_mail", user: "work_mail" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  store = new PostgresWorkMailStore(sql, tokenKey, "");
});
beforeEach(async () => {
  await sql`delete from contributor_work_mail_confirmations`;
  await sql`delete from contributor_work_mail_subscriptions`;
  await sql`delete from contributor_work_mail_daily`;
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

async function insertUser(): Promise<string> {
  seed += 1;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${8_400_000 + seed}, ${`mail-${seed}`}) returning id`;
  return row!.id;
}

function addressFor(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}@example.test`;
}

async function confirmationsOf(userId: string): Promise<{ address_digest: Buffer; sent_at: Date }[]> {
  return sql`select address_digest, sent_at from contributor_work_mail_confirmations where user_id = ${userId} order by sent_at, id`;
}

async function dailySent(): Promise<number | null> {
  const [row] = await sql<{ sent: number }[]>`select sent from contributor_work_mail_daily`;
  return row?.sent ?? null;
}

async function subscriptionRow(userId: string) {
  const [row] = await sql<{ address: string; confirm_token_hash: Buffer | null; confirmed_at: Date | null;
    last_notified_at: Date | null; confirm_expires_at: Date | null }[]>`
    select address, confirm_token_hash, confirmed_at, last_notified_at, confirm_expires_at
    from contributor_work_mail_subscriptions where user_id = ${userId}`;
  return row;
}

async function confirmedSubscriber(): Promise<{ userId: string; id: string; address: string }> {
  const userId = await insertUser();
  const address = addressFor("confirmed");
  const outcome = await store.requestConfirmation(userId, address, limits);
  if (outcome.kind !== "send") throw new Error(`seed confirmation was ${outcome.kind}`);
  expect(await store.confirm(userId, outcome.token)).toBe(true);
  const subscription = await store.getSubscription(userId);
  return { userId, id: subscription!.id, address };
}

describe("requestConfirmation", () => {
  it("stores a pending subscription, the token's SHA-256, one keyed address digest and one daily unit", async () => {
    const userId = await insertUser();
    const address = addressFor("Mixed.Case");
    const outcome = await store.requestConfirmation(userId, address, limits);
    expect(outcome.kind).toBe("send");
    const token = (outcome as { token: string }).token;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = await subscriptionRow(userId);
    expect(row).toMatchObject({ address, confirmed_at: null, last_notified_at: null });
    expect(row!.confirm_token_hash).toEqual(createHash("sha256").update(token, "utf8").digest());
    const [db] = await sql<{ in_day: boolean }[]>`
      select confirm_expires_at = created_at + interval '24 hours' as in_day
      from contributor_work_mail_subscriptions where user_id = ${userId}`;
    expect(db!.in_day).toBe(true);
    // The digest is HMAC-SHA256 over the lowercased address under a key derived from the token key.
    const derived = createHmac("sha256", Buffer.from(tokenKey, "base64url"))
      .update("overflow:work-mail-address-digest", "utf8").digest();
    const expected = createHmac("sha256", derived).update(address.toLowerCase(), "utf8").digest();
    expect((await confirmationsOf(userId)).map((row) => row.address_digest)).toEqual([expected]);
    expect(await dailySent()).toBe(1);
  });

  it("refuses the fourth request of one account in 24 hours and writes nothing", async () => {
    const userId = await insertUser();
    for (let index = 0; index < 3; index += 1) {
      expect((await store.requestConfirmation(userId, addressFor(`a${index}`), limits)).kind).toBe("send");
    }
    const before = await subscriptionRow(userId);
    const outcome = await store.requestConfirmation(userId, addressFor("fourth"), limits);
    expect(outcome.kind).toBe("account-limited");
    expect((await confirmationsOf(userId))).toHaveLength(3);
    expect(await subscriptionRow(userId)).toEqual(before);
    expect(await dailySent()).toBe(3);
  });

  it("names the wait until the third-newest request leaves the window", async () => {
    const userId = await insertUser();
    for (let index = 0; index < 3; index += 1) {
      await store.requestConfirmation(userId, addressFor(`w${index}`), limits);
    }
    const ids = (await sql<{ id: string }[]>`
      select id from contributor_work_mail_confirmations where user_id = ${userId} order by sent_at, id`).map((r) => r.id);
    await sql`update contributor_work_mail_confirmations set sent_at = now() - interval '23 hours' where id = ${ids[0]!}`;
    await sql`update contributor_work_mail_confirmations set sent_at = now() - interval '2 hours' where id = ${ids[1]!}`;
    await sql`update contributor_work_mail_confirmations set sent_at = now() - interval '1 hour' where id = ${ids[2]!}`;
    const outcome = await store.requestConfirmation(userId, addressFor("wait"), limits);
    expect(outcome.kind).toBe("account-limited");
    const retry = (outcome as { retryAfterSeconds: number }).retryAfterSeconds;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
  });

  it("counts only the last 24 hours against the account", async () => {
    const userId = await insertUser();
    for (let index = 0; index < 3; index += 1) {
      await store.requestConfirmation(userId, addressFor(`old${index}`), limits);
    }
    const [oldest] = await sql<{ id: string }[]>`
      select id from contributor_work_mail_confirmations where user_id = ${userId} order by sent_at, id limit 1`;
    await sql`update contributor_work_mail_confirmations set sent_at = now() - interval '24 hours 1 second' where id = ${oldest!.id}`;
    expect((await store.requestConfirmation(userId, addressFor("fresh"), limits)).kind).toBe("send");
  });

  it("suppresses the fourth request for one address across accounts: pending row, nothing sent or reserved", async () => {
    const address = addressFor("target");
    for (let index = 0; index < 3; index += 1) {
      // Case differs per requester; the digest is over the lowercased address.
      const spelled = index === 1 ? address.toUpperCase() : address;
      expect((await store.requestConfirmation(await insertUser(), spelled, limits)).kind).toBe("send");
    }
    const userId = await insertUser();
    const outcome = await store.requestConfirmation(userId, address, limits);
    expect(outcome).toEqual({ kind: "suppressed" });
    expect(await confirmationsOf(userId)).toEqual([]);
    expect(await dailySent()).toBe(3);
    const row = await subscriptionRow(userId);
    expect(row).toMatchObject({ address, confirmed_at: null, last_notified_at: null });
    expect(row!.confirm_token_hash).toBeInstanceOf(Buffer);
    expect(row!.confirm_expires_at).toBeInstanceOf(Date);
  });

  it("checks the account cap before the address cap", async () => {
    const address = addressFor("both");
    for (let index = 0; index < 3; index += 1) await store.requestConfirmation(await insertUser(), address, limits);
    const userId = await insertUser();
    for (let index = 0; index < 3; index += 1) await store.requestConfirmation(userId, addressFor(`own${index}`), limits);
    expect((await store.requestConfirmation(userId, address, limits)).kind).toBe("account-limited");
  });

  it("refuses at the daily ceiling and rolls the request back", async () => {
    const first = await insertUser();
    expect((await store.requestConfirmation(first, addressFor("one"), { dailyLimit: 1 })).kind).toBe("send");
    const second = await insertUser();
    expect(await store.requestConfirmation(second, addressFor("two"), { dailyLimit: 1 })).toEqual({ kind: "ceiling" });
    expect(await confirmationsOf(second)).toEqual([]);
    expect(await subscriptionRow(second)).toBeUndefined();
    expect(await dailySent()).toBe(1);
  });

  it("re-requesting replaces the address and resets confirmation and the watermark, but keeps the 24-hour floor", async () => {
    const { userId } = await confirmedSubscriber();
    await sql`update contributor_work_mail_subscriptions set last_notified_at = now(), last_digest_at = now() - interval '1 hour'
              where user_id = ${userId}`;
    const [before] = await sql<{ last_digest_at: Date }[]>`
      select last_digest_at from contributor_work_mail_subscriptions where user_id = ${userId}`;
    const replacement = addressFor("replacement");
    expect((await store.requestConfirmation(userId, replacement, limits)).kind).toBe("send");
    expect(await subscriptionRow(userId)).toMatchObject({ address: replacement, confirmed_at: null, last_notified_at: null });
    const [after] = await sql<{ last_digest_at: Date }[]>`
      select last_digest_at from contributor_work_mail_subscriptions where user_id = ${userId}`;
    expect(after!.last_digest_at).toEqual(before!.last_digest_at);
  });

  it("answers a capped address like a fresh one once the daily ceiling is spent, writing nothing", async () => {
    const address = addressFor("probed");
    for (let index = 0; index < 3; index += 1) {
      expect((await store.requestConfirmation(await insertUser(), address, { dailyLimit: 3 })).kind).toBe("send");
    }
    expect(await store.requestConfirmation(await insertUser(), addressFor("fresh"), { dailyLimit: 3 })).toEqual({ kind: "ceiling" });
    const prober = await insertUser();
    expect(await store.requestConfirmation(prober, address, { dailyLimit: 3 })).toEqual({ kind: "ceiling" });
    expect(await subscriptionRow(prober)).toBeUndefined();
    expect(await dailySent()).toBe(3);
  });

  it("reads a spent ceiling on the UTC day whatever the session time zone", async () => {
    const address = addressFor("zoned");
    for (let index = 0; index < 3; index += 1) {
      expect((await store.requestConfirmation(await insertUser(), address, { dailyLimit: 3 })).kind).toBe("send");
    }
    // At any instant at least one of UTC+14 and UTC-12 is on another local date than UTC.
    for (const zone of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      const zoned = postgres(process.env.OVERFLOW_DATABASE_URL!, { max: 1, connection: { TimeZone: zone } });
      try {
        const prober = await insertUser();
        expect(await new PostgresWorkMailStore(zoned, tokenKey, "").requestConfirmation(prober, address, { dailyLimit: 3 }), zone)
          .toEqual({ kind: "ceiling" });
        expect(await subscriptionRow(prober)).toBeUndefined();
      } finally {
        await zoned.end();
      }
    }
  });

  it("keeps counting an address across a key rotation while the old key is the previous key", async () => {
    const oldKey = randomBytes(32).toString("base64url");
    const newKey = randomBytes(32).toString("base64url");
    const address = addressFor("rotated");
    for (let index = 0; index < 3; index += 1) {
      await new PostgresWorkMailStore(sql, oldKey, "").requestConfirmation(await insertUser(), address, limits);
    }
    const rotated = new PostgresWorkMailStore(sql, newKey, oldKey);
    expect(await rotated.requestConfirmation(await insertUser(), address, limits)).toEqual({ kind: "suppressed" });
    // Control: without the previous key the old digests are unrecognisable.
    expect((await new PostgresWorkMailStore(sql, newKey, "").requestConfirmation(await insertUser(), address, limits)).kind).toBe("send");
  });

  it("serialises concurrent requests of different accounts for one address to exactly three sends", async () => {
    const address = addressFor("contested");
    const users = await Promise.all(Array.from({ length: 6 }, () => insertUser()));
    const outcomes = await Promise.all(users.map((userId) => store.requestConfirmation(userId, address, limits)));
    expect(outcomes.filter((outcome) => outcome.kind === "send")).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.kind === "suppressed")).toHaveLength(3);
  });

  it("serialises concurrent requests of one account to exactly three sends", async () => {
    const userId = await insertUser();
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, (_, index) => store.requestConfirmation(userId, addressFor(`race${index}`), limits)));
    expect(outcomes.filter((outcome) => outcome.kind === "send")).toHaveLength(3);
    expect(await confirmationsOf(userId)).toHaveLength(3);
  });
});

describe("confirm", () => {
  async function pending(): Promise<{ userId: string; token: string }> {
    const userId = await insertUser();
    const outcome = await store.requestConfirmation(userId, addressFor("pending"), limits);
    return { userId, token: (outcome as { token: string }).token };
  }

  it("confirms with the matching token and clears the token", async () => {
    const { userId, token } = await pending();
    expect(await store.confirm(userId, token)).toBe(true);
    const row = await subscriptionRow(userId);
    expect(row!.confirmed_at).toBeInstanceOf(Date);
    expect(row).toMatchObject({ confirm_token_hash: null, confirm_expires_at: null });
  });

  it("answers the same false for an expired, foreign, used or malformed token", async () => {
    const expired = await pending();
    await sql`update contributor_work_mail_subscriptions set confirm_expires_at = now() - interval '1 second'
      where user_id = ${expired.userId}`;
    expect(await store.confirm(expired.userId, expired.token)).toBe(false);

    const owner = await pending();
    const stranger = await insertUser();
    expect(await store.confirm(stranger, owner.token)).toBe(false);

    const used = await pending();
    expect(await store.confirm(used.userId, used.token)).toBe(true);
    expect(await store.confirm(used.userId, used.token)).toBe(false);

    expect(await store.confirm(owner.userId, `${owner.token}x`)).toBe(false);
    expect(await store.confirm(owner.userId, randomBytes(32).toString("base64url"))).toBe(false);
    // None of the refusals touched the owner's pending row.
    expect((await subscriptionRow(owner.userId))!.confirmed_at).toBeNull();
    expect((await subscriptionRow(expired.userId))!.confirmed_at).toBeNull();
  });
});

describe("subscription reads and deletes", () => {
  it("getSubscription never returns the token hash", async () => {
    const userId = await insertUser();
    const address = addressFor("read");
    await store.requestConfirmation(userId, address, limits);
    const subscription = await store.getSubscription(userId);
    expect(Object.keys(subscription!).sort()).toEqual(
      ["address", "confirmExpiresAt", "confirmedAt", "createdAt", "id", "lastNotifiedAt", "updatedAt"]);
    expect(subscription!.address).toBe(address);
    expect(await store.getSubscription(await insertUser())).toBeNull();
  });

  it("deleteSubscription removes the subscription row and keeps the confirmation history", async () => {
    const { userId } = await confirmedSubscriber();
    const other = await confirmedSubscriber();
    expect(await store.deleteSubscription(userId)).toBe(true);
    expect(await subscriptionRow(userId)).toBeUndefined();
    expect(await confirmationsOf(userId)).toHaveLength(1);
    expect(await subscriptionRow(other.userId)).toBeDefined();
    expect(await store.deleteSubscription(userId)).toBe(false);
  });

  it("deleteAllWorkMailData removes the user's subscription and confirmation history only", async () => {
    const { userId } = await confirmedSubscriber();
    const other = await confirmedSubscriber();
    await deleteAllWorkMailData(sql, [userId]);
    expect(await subscriptionRow(userId)).toBeUndefined();
    expect(await confirmationsOf(userId)).toEqual([]);
    expect(await subscriptionRow(other.userId)).toBeDefined();
    expect(await confirmationsOf(other.userId)).toHaveLength(1);
    // A user with history but no subscription row loses the history too.
    const requester = await insertUser();
    await store.requestConfirmation(requester, addressFor("history"), limits);
    await store.deleteSubscription(requester);
    await sql.begin((tx) => deleteAllWorkMailData(tx, [requester]));
    expect(await confirmationsOf(requester)).toEqual([]);
  });

  it("opting out with deleteSubscription does not reset the account cap", async () => {
    const userId = await insertUser();
    for (let index = 0; index < 3; index += 1) {
      expect((await store.requestConfirmation(userId, addressFor(`optout${index}`), limits)).kind).toBe("send");
      expect(await store.deleteSubscription(userId)).toBe(true);
    }
    expect((await store.requestConfirmation(userId, addressFor("after"), limits)).kind).toBe("account-limited");
  });

  it("opting out with deleteSubscriptionById does not reset the address cap", async () => {
    const address = addressFor("victim");
    for (let index = 0; index < 3; index += 1) {
      const userId = await insertUser();
      expect((await store.requestConfirmation(userId, address, limits)).kind).toBe("send");
      expect(await store.deleteSubscriptionById((await store.getSubscription(userId))!.id)).toBe(true);
    }
    expect(await store.requestConfirmation(await insertUser(), address, limits)).toEqual({ kind: "suppressed" });
  });

  it("deleteSubscriptionById removes that subscription only", async () => {
    const one = await confirmedSubscriber();
    const two = await confirmedSubscriber();
    expect(await store.deleteSubscriptionById(one.id)).toBe(true);
    expect(await subscriptionRow(one.userId)).toBeUndefined();
    expect(await subscriptionRow(two.userId)).toBeDefined();
    expect(await store.deleteSubscriptionById(one.id)).toBe(false);
  });
});

describe("reserveDailySend", () => {
  it("grants up to the limit and refuses past it", async () => {
    expect(await reserveDailySend(sql, 2)).toBe(true);
    expect(await reserveDailySend(sql, 2)).toBe(true);
    expect(await reserveDailySend(sql, 2)).toBe(false);
    expect(await dailySent()).toBe(2);
  });

  it("never exceeds the limit under concurrent reservations", async () => {
    const granted = await Promise.all(Array.from({ length: 20 }, () => reserveDailySend(sql, 5)));
    expect(granted.filter(Boolean)).toHaveLength(5);
    expect(await dailySent()).toBe(5);
  });

  it("keys the counter on the UTC day whatever the session time zone", async () => {
    // At any instant at least one of UTC+14 and UTC-12 is on another local date than UTC.
    for (const zone of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      const zoned = postgres(process.env.OVERFLOW_DATABASE_URL!, { max: 1, connection: { TimeZone: zone } });
      try {
        expect(await reserveDailySend(zoned, 5)).toBe(true);
      } finally {
        await zoned.end();
      }
    }
    const rows = await sql<{ today: boolean; sent: number }[]>`
      select utc_day = (now() at time zone 'UTC')::date as today, sent from contributor_work_mail_daily`;
    expect(rows).toEqual([{ today: true, sent: 2 }]);
  });
});

describe("digest support", () => {
  it("lists confirmed subscriptions never notified or last notified 24 hours ago, with their watermark", async () => {
    const fresh = await confirmedSubscriber();
    const recent = await confirmedSubscriber();
    const old = await confirmedSubscriber();
    await sql`update contributor_work_mail_subscriptions set last_notified_at = now() - interval '23 hours',
              last_digest_at = now() - interval '23 hours' where id = ${recent.id}`;
    await sql`update contributor_work_mail_subscriptions set last_notified_at = now() - interval '25 hours',
              last_digest_at = now() - interval '25 hours' where id = ${old.id}`;
    await store.requestConfirmation(await insertUser(), addressFor("unconfirmed"), limits);
    const due = await store.listDueSubscriptions();
    expect(due.map((row) => row.id).sort()).toEqual([fresh.id, old.id].sort());
    const [freshRow] = await sql<{ confirmed_at: Date }[]>`select confirmed_at from contributor_work_mail_subscriptions where id = ${fresh.id}`;
    const [oldRow] = await sql<{ last_notified_at: Date }[]>`select last_notified_at from contributor_work_mail_subscriptions where id = ${old.id}`;
    expect(due.find((row) => row.id === fresh.id)).toEqual({
      id: fresh.id, userId: fresh.userId, address: fresh.address, watermark: freshRow!.confirmed_at, lastNotifiedAt: null });
    expect(due.find((row) => row.id === old.id)).toEqual({
      id: old.id, userId: old.userId, address: old.address, watermark: oldRow!.last_notified_at, lastNotifiedAt: oldRow!.last_notified_at });
  });

  it("hasIssueCreatedAfter answers by issues.created_at", async () => {
    const sponsor = await insertUser();
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
      values (${8_400_500 + seed}, ${`mail-owner/repo-${seed}`}, ${sponsor}, 'PUBLIC', ${8_400_600 + seed}, ${sql.json(validDifficultyScheme())})
      returning id`;
    // Millisecond-exact, so a Date can name the boundary itself.
    const [issue] = await sql<{ created_at: Date }[]>`
      insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                          opening_label, opening_comparison_points, opening_reserve_points, created_at)
      values (${8_400_700 + seed}, ${repository!.id}, 1, 'Mail fixture', '', 'https://example.test/issue', 'OPEN', 'M', 5, 5,
              date_trunc('milliseconds', now()))
      returning created_at`;
    const createdAt = issue!.created_at;
    expect(await store.hasIssueCreatedAfter(new Date(createdAt.getTime() - 1))).toBe(true);
    expect(await store.hasIssueCreatedAfter(createdAt)).toBe(false);
  });

  it("claimDigestSlot stamps the slot once: a second claim on the same previous value loses", async () => {
    const { id } = await confirmedSubscriber();
    const t0 = await store.dbNow();
    const { address } = await sql<{ address: string }[]>`select address from contributor_work_mail_subscriptions where id = ${id}`.then((rows) => rows[0]!);
    expect(await store.claimDigestSlot(id, null, t0, 10)).toEqual({ address });
    expect((await sql<{ last_notified_at: Date }[]>`
      select last_notified_at from contributor_work_mail_subscriptions where id = ${id}`)[0]!.last_notified_at).toEqual(t0);
    expect(await store.claimDigestSlot(id, null, t0, 10)).toBe(false);
    expect(await dailySent()).toBe(2);
  });

  it("claimDigestSlot matches a previous stamp written at database precision", async () => {
    const { id } = await confirmedSubscriber();
    await sql`update contributor_work_mail_subscriptions set last_notified_at = now() - interval '25 hours',
              last_digest_at = now() - interval '25 hours' where id = ${id}`;
    const [due] = await store.listDueSubscriptions();
    expect(await store.claimDigestSlot(id, due!.lastNotifiedAt, await store.dbNow(), 10)).toEqual({ address: due!.address });
  });

  it("stamps the claim at the database time, apart from the cycle start", async () => {
    const { id } = await confirmedSubscriber();
    const t0 = new Date((await store.dbNow()).getTime() - 10 * 60_000);
    const before = await store.dbNow();
    expect(await store.claimDigestSlot(id, null, t0, 10)).not.toBe(false);
    const after = await store.dbNow();
    const [row] = await sql<{ last_notified_at: Date; last_digest_at: Date }[]>`
      select last_notified_at, last_digest_at from contributor_work_mail_subscriptions where id = ${id}`;
    expect(row!.last_notified_at).toEqual(t0);
    expect(row!.last_digest_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row!.last_digest_at.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("keeps a row claimed late in its cycle off the due list until 24 hours after the claim", async () => {
    const { id } = await confirmedSubscriber();
    // Claimed ten minutes after its cycle started.
    expect(await store.claimDigestSlot(id, null, new Date((await store.dbNow()).getTime() - 10 * 60_000), 10)).not.toBe(false);
    const age = (interval: string) => sql`
      update contributor_work_mail_subscriptions
      set last_notified_at = last_notified_at - ${interval}::interval, last_digest_at = last_digest_at - ${interval}::interval
      where id = ${id}`;
    // 23 h 55 min on: past 24 hours after the cycle start, short of 24 hours after the claim.
    await age("23 hours 55 minutes");
    expect((await store.listDueSubscriptions()).map((row) => row.id)).not.toContain(id);
    await age("6 minutes");
    expect((await store.listDueSubscriptions()).map((row) => row.id)).toContain(id);
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const { id } = await confirmedSubscriber();
    const t0 = await store.dbNow();
    const results = await Promise.all([store.claimDigestSlot(id, null, t0, 10), store.claimDigestSlot(id, null, t0, 10)]);
    expect(results.filter((result) => typeof result === "object")).toHaveLength(1);
    expect(results.filter((result) => result === false)).toHaveLength(1);
  });

  it("a claim after an address change returns the address it claimed, never the listed one", async () => {
    const { id, userId, address: listed } = await confirmedSubscriber();
    const [due] = await store.listDueSubscriptions();
    expect(due!.address).toBe(listed);
    const replacement = addressFor("replacement");
    const outcome = await store.requestConfirmation(userId, replacement, limits);
    expect(await store.confirm(userId, (outcome as { token: string }).token)).toBe(true);
    expect(await store.claimDigestSlot(id, due!.lastNotifiedAt, await store.dbNow(), 10)).toEqual({ address: replacement });
  });

  it("never claims a subscription that went back to pending", async () => {
    const { id, userId } = await confirmedSubscriber();
    await store.requestConfirmation(userId, addressFor("changed"), limits);
    expect(await store.claimDigestSlot(id, null, await store.dbNow(), 10)).toBe(false);
  });

  it("rolls the claim back at the daily ceiling", async () => {
    const { id } = await confirmedSubscriber();
    expect(await store.claimDigestSlot(id, null, await store.dbNow(), 1)).toBe("ceiling");
    expect((await subscriptionRow((await sql<{ user_id: string }[]>`
      select user_id from contributor_work_mail_subscriptions where id = ${id}`)[0]!.user_id))!.last_notified_at).toBeNull();
    expect(await dailySent()).toBe(1);
  });
});

describe("schema", () => {
  it("refuses a row neither confirmed nor carrying a live token", async () => {
    const userId = await insertUser();
    await expect(sql`insert into contributor_work_mail_subscriptions (user_id, address) values (${userId}, 'a@example.test')`)
      .rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an address longer than 254 characters and a second subscription for one user", async () => {
    const userId = await insertUser();
    await expect(sql`insert into contributor_work_mail_subscriptions (user_id, address, confirmed_at)
      values (${userId}, ${`${"a".repeat(243)}@example.test`}, now())`).rejects.toMatchObject({ code: "23514" });
    await sql`insert into contributor_work_mail_subscriptions (user_id, address, confirmed_at) values (${userId}, 'a@example.test', now())`;
    await expect(sql`insert into contributor_work_mail_subscriptions (user_id, address, confirmed_at)
      values (${userId}, 'b@example.test', now())`).rejects.toMatchObject({ code: "23505" });
  });

  it("refuses a negative daily count", async () => {
    await expect(sql`insert into contributor_work_mail_daily (utc_day, sent) values (current_date, -1)`)
      .rejects.toMatchObject({ code: "23514" });
  });
});
