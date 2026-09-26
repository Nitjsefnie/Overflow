import { getSql } from "@/lib/db/client";
import type { EnforcementState, SqlClient, UserRole } from "@/lib/db/types";
import { API_TOKEN_LIFETIME_DAYS } from "@/lib/tokens/lifetime";

export type ApiTokenAccount = {
  id: string;
  tokenId: string;
  role: UserRole;
  enforcementState: EnforcementState;
};

export type ApiTokenSummary = {
  createdAt: Date;
  expiresAt: Date;
};

/**
 * A summary with the database's verdict on whether it has expired, decided by
 * the same clock and predicate that refuse the token on a bearer route.
 */
export type ApiTokenStatus = ApiTokenSummary & { expired: boolean };

/**
 * Issues and resolves the hashes of Overflow-issued API tokens.
 *
 * Issuing is one upsert on the `user_id` unique constraint, which is what makes
 * regeneration revoke the previous token atomically: a delete followed by an
 * insert would leave a window in which the account has no token, and a bare
 * insert a window in which it has two. Reissuing rotates the issuance id,
 * clears last use, and resets `created_at` and `expires_at`, so a summary
 * describes the current token and regeneration restarts its lifetime.
 *
 * Expiry is decided here, once, by the database clock: every bearer route
 * resolves its credential through `findAccountByTokenHash`, so an expired
 * token is refused everywhere exactly as a token that was never issued. So is
 * a deleted account: resolution requires the account row to be live, and a
 * token row that outlives its account authenticates nobody.
 *
 * Nothing here hands back token material. A hash only ever arrives as an
 * argument, and a resolved account carries just the fields an actor needs.
 */
export class PostgresApiTokenStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async issueToken(userId: string, tokenHash: Buffer): Promise<ApiTokenSummary> {
    const [row] = await this.sql<{ created_at: Date; expires_at: Date }[]>`
      insert into api_tokens (user_id, token_hash, expires_at)
      values (${userId}, ${tokenHash}, now() + make_interval(days => ${API_TOKEN_LIFETIME_DAYS}))
      on conflict (user_id) do update
      set id = gen_random_uuid(), token_hash = excluded.token_hash,
          created_at = now(), expires_at = excluded.expires_at, last_used_at = null
      returning created_at, expires_at
    `;
    return { createdAt: row.created_at, expiresAt: row.expires_at };
  }

  public async findAccountByTokenHash(tokenHash: Buffer): Promise<ApiTokenAccount | null> {
    const [row] = await this.sql<
      { id: string; token_id: string; role: UserRole; enforcement_state: EnforcementState }[]
    >`
      with matched_token as (
        select id, user_id from api_tokens
        where token_hash = ${tokenHash} and expires_at > now()
      ), stamped as (
        update api_tokens set last_used_at = now()
        where id = (select id from matched_token)
          and (last_used_at is null or last_used_at < now() - interval '1 minute')
      )
      select users.id, matched_token.id as token_id, users.role, users.enforcement_state
      from matched_token
      join users on users.id = matched_token.user_id and users.deleted_at is null
    `;
    if (row === undefined) {
      return null;
    }
    return { id: row.id, tokenId: row.token_id, role: row.role, enforcementState: row.enforcement_state };
  }

  public async getTokenSummary(userId: string): Promise<ApiTokenStatus | null> {
    // `expired` is the negation of findAccountByTokenHash's `expires_at > now()`.
    const [row] = await this.sql<{ created_at: Date; expires_at: Date; expired: boolean }[]>`
      select created_at, expires_at, expires_at <= now() as expired
      from api_tokens where user_id = ${userId} limit 1
    `;
    return row === undefined
      ? null
      : { createdAt: row.created_at, expiresAt: row.expires_at, expired: row.expired };
  }
}
