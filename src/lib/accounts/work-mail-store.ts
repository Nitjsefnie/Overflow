import { createHash, createHmac, randomBytes } from "node:crypto";
import { addressDigestInput } from "@/lib/accounts/work-mail-config";
import { getSql } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { readEnv } from "@/lib/env";
import { derivePurposeKey, tokenKeySetFrom } from "@/lib/security/token-cipher";

const CONFIRMATIONS_PER_ACCOUNT = 3;
const CONFIRMATIONS_PER_ADDRESS = 3;
const ADDRESS_DIGEST_LABEL = "overflow:work-mail-address-digest";

export type ConfirmationOutcome =
  | { kind: "send"; token: string }
  | { kind: "suppressed" }
  | { kind: "account-limited"; retryAfterSeconds: number }
  | { kind: "ceiling" };

export type WorkMailSubscription = {
  id: string;
  address: string;
  confirmedAt: Date | null;
  confirmExpiresAt: Date | null;
  lastNotifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type DueSubscription = { id: string; userId: string; address: string; watermark: Date; lastNotifiedAt: Date | null };

/** One unit of today's (UTC) contributor-mail ceiling; false when the day is spent. */
export async function reserveDailySend(sql: SqlClient | TransactionClient, limit: number): Promise<boolean> {
  const rows = await sql`
    insert into contributor_work_mail_daily (utc_day, sent) values ((now() at time zone 'UTC')::date, 1)
    on conflict (utc_day) do update set sent = contributor_work_mail_daily.sent + 1
    where contributor_work_mail_daily.sent < ${limit}
    returning sent
  `;
  return rows.length === 1;
}

export type WorkMailRowCounts = { subscriptions: number; confirmations: number };

/** Account erasure inside the caller's transaction: the subscriptions and the confirmation history. */
export async function deleteAllWorkMailData(
  sql: SqlClient | TransactionClient, userIds: readonly string[],
): Promise<WorkMailRowCounts> {
  const users = sql.array([...userIds]);
  const [row] = await sql<WorkMailRowCounts[]>`
    with history as (delete from contributor_work_mail_confirmations where user_id = any(${users}::uuid[]) returning 1),
      subscription as (delete from contributor_work_mail_subscriptions where user_id = any(${users}::uuid[]) returning 1)
    select (select count(*) from subscription)::int as subscriptions, (select count(*) from history)::int as confirmations
  `;
  return row!;
}

/** What deleteAllWorkMailData would remove, for a dry run. */
export async function countAllWorkMailData(
  sql: SqlClient | TransactionClient, userIds: readonly string[],
): Promise<WorkMailRowCounts> {
  const users = sql.array([...userIds]);
  const [row] = await sql<WorkMailRowCounts[]>`
    select (select count(*) from contributor_work_mail_subscriptions where user_id = any(${users}::uuid[]))::int as subscriptions,
           (select count(*) from contributor_work_mail_confirmations where user_id = any(${users}::uuid[]))::int as confirmations
  `;
  return row!;
}

async function dailyCeilingSpent(sql: TransactionClient, limit: number): Promise<boolean> {
  const [row] = await sql<{ spent: boolean }[]>`
    select sent >= ${limit} as spent from contributor_work_mail_daily where utc_day = (now() at time zone 'UTC')::date
  `;
  return row?.spent ?? false;
}

const ceilingRefusal = new Error("contributor mail ceiling reached");

export class PostgresWorkMailStore {
  public constructor(
    private readonly sql: SqlClient = getSql(),
    private readonly tokenEncryptionKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY"),
    private readonly previousTokenEncryptionKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS"),
  ) {}

  /** Commits before the caller sends; "suppressed" must be answered exactly like "send". */
  public async requestConfirmation(userId: string, address: string, limits: { dailyLimit: number }): Promise<ConfirmationOutcome> {
    const keys = tokenKeySetFrom(this.tokenEncryptionKey, this.previousTokenEncryptionKey);
    // Digests under the previous key still count, so a key rotation does not reset the address cap.
    const [digest, previousDigest] = [keys.current, keys.previous ?? keys.current].map((key) =>
      createHmac("sha256", derivePurposeKey(key, ADDRESS_DIGEST_LABEL)).update(addressDigestInput(address), "utf8").digest());
    return this.sql.begin(async (tx): Promise<ConfirmationOutcome> => {
      await tx`select pg_advisory_xact_lock(hashtext('overflow:work-mail-confirmation'))`;
      const [counts] = await tx<{ by_account: number; by_address: number }[]>`
        select count(*) filter (where user_id = ${userId})::int as by_account,
               count(*) filter (where address_digest in (${digest}, ${previousDigest}))::int as by_address
        from contributor_work_mail_confirmations
        where sent_at > now() - interval '24 hours'
          and (user_id = ${userId} or address_digest in (${digest}, ${previousDigest}))
      `;
      if (counts!.by_account >= CONFIRMATIONS_PER_ACCOUNT) {
        // The account frees a slot when its third-newest request leaves the window.
        const [row] = await tx<{ seconds: number }[]>`
          select greatest(1, ceil(extract(epoch from sent_at + interval '24 hours' - now())))::int as seconds
          from contributor_work_mail_confirmations
          where user_id = ${userId} and sent_at > now() - interval '24 hours'
          order by sent_at desc offset ${CONFIRMATIONS_PER_ACCOUNT - 1} limit 1
        `;
        return { kind: "account-limited", retryAfterSeconds: row!.seconds };
      }
      const sends = counts!.by_address < CONFIRMATIONS_PER_ADDRESS;
      if (sends) {
        if (!(await reserveDailySend(tx, limits.dailyLimit))) return { kind: "ceiling" };
        await tx`insert into contributor_work_mail_confirmations (user_id, address_digest) values (${userId}, ${digest})`;
      } else if (await dailyCeilingSpent(tx, limits.dailyLimit)) {
        // Every refusal of success looks alike, or a spent day would tell a capped address from a fresh one.
        return { kind: "ceiling" };
      }
      const token = randomBytes(32).toString("base64url");
      await tx`
        insert into contributor_work_mail_subscriptions (user_id, address, confirm_token_hash, confirm_expires_at)
        values (${userId}, ${address}, ${hashToken(token)}, now() + interval '24 hours')
        on conflict (user_id) do update
        set address = excluded.address, confirm_token_hash = excluded.confirm_token_hash,
            confirm_expires_at = excluded.confirm_expires_at, confirmed_at = null, last_notified_at = null,
            updated_at = now()
      `;
      return sends ? { kind: "send", token } : { kind: "suppressed" };
    });
  }

  public async confirm(userId: string, token: string): Promise<boolean> {
    const rows = await this.sql`
      update contributor_work_mail_subscriptions
      set confirmed_at = now(), confirm_token_hash = null, confirm_expires_at = null, updated_at = now()
      where confirm_token_hash = ${hashToken(token)} and user_id = ${userId} and confirm_expires_at > now()
      returning id
    `;
    return rows.length === 1;
  }

  public async getSubscription(userId: string): Promise<WorkMailSubscription | null> {
    const [row] = await this.sql<{ id: string; address: string; confirmed_at: Date | null; confirm_expires_at: Date | null;
      last_notified_at: Date | null; created_at: Date; updated_at: Date }[]>`
      select id, address, confirmed_at, confirm_expires_at, last_notified_at, created_at, updated_at
      from contributor_work_mail_subscriptions where user_id = ${userId}
    `;
    return row === undefined ? null : {
      id: row.id, address: row.address, confirmedAt: row.confirmed_at, confirmExpiresAt: row.confirm_expires_at,
      lastNotifiedAt: row.last_notified_at, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // Opt-out keeps the confirmation history (digests only), so it cannot reset the caps; it ages out by the prune.
  public async deleteSubscription(userId: string): Promise<boolean> {
    const rows = await this.sql`delete from contributor_work_mail_subscriptions where user_id = ${userId} returning id`;
    return rows.length === 1;
  }

  public async deleteSubscriptionById(id: string): Promise<boolean> {
    const rows = await this.sql`delete from contributor_work_mail_subscriptions where id = ${id} returning id`;
    return rows.length === 1;
  }

  public async listDueSubscriptions(): Promise<DueSubscription[]> {
    const rows = await this.sql<{ id: string; user_id: string; address: string; watermark: Date; last_notified_at: Date | null }[]>`
      select id, user_id, address, coalesce(last_notified_at, confirmed_at) as watermark, last_notified_at
      from contributor_work_mail_subscriptions
      where confirmed_at is not null
        and (last_notified_at is null or last_notified_at <= now() - interval '24 hours')
      order by watermark, id
    `;
    return rows.map((row) => ({
      id: row.id, userId: row.user_id, address: row.address, watermark: row.watermark, lastNotifiedAt: row.last_notified_at,
    }));
  }

  public async hasIssueCreatedAfter(createdAfter: Date): Promise<boolean> {
    const [row] = await this.sql<{ found: boolean }[]>`select exists (select 1 from issues where created_at > ${createdAfter}) as found`;
    return row!.found;
  }

  /**
   * Stamps the digest slot iff nobody else did since `prevLastNotifiedAt` was read, and spends one ceiling unit.
   * Send to the returned address: the listed one may have been replaced and re-confirmed since.
   */
  public async claimDigestSlot(
    id: string, prevLastNotifiedAt: Date | null, t0: Date, limit: number,
  ): Promise<{ address: string } | false | "ceiling"> {
    try {
      return await this.sql.begin(async (tx) => {
        // A Date carries milliseconds and the column microseconds: compare at the precision the caller read.
        const [claimed] = await tx<{ address: string }[]>`
          update contributor_work_mail_subscriptions set last_notified_at = ${t0}, updated_at = now()
          where id = ${id} and confirmed_at is not null
            and date_trunc('milliseconds', last_notified_at) is not distinct from ${prevLastNotifiedAt}
          returning address
        `;
        if (claimed === undefined) return false;
        if (!(await reserveDailySend(tx, limit))) throw ceilingRefusal;
        return { address: claimed.address };
      });
    } catch (error) {
      if (error === ceilingRefusal) return "ceiling";
      throw error;
    }
  }

  public async dbNow(): Promise<Date> {
    const [row] = await this.sql<{ now: Date }[]>`select now() as now`;
    return row!.now;
  }
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
