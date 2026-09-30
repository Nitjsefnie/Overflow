import { getSql } from "@/lib/db/client";
import type { EnforcementState, SqlClient, UserRole } from "@/lib/db/types";
import { API_TOKEN_DELIVERY_WINDOW_MINUTES, API_TOKEN_LIFETIME_DAYS } from "@/lib/tokens/lifetime";

export type ApiTokenAccount = {
  id: string;
  tokenId: string;
  role: UserRole;
  enforcementState: EnforcementState;
};

export type ApiTokenSummary = {
  createdAt: Date;
  expiresAt: Date;
  /** The instant a request first authenticated with this token's value, or null while nobody has. */
  confirmedAt: Date | null;
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
 * clears last use and any confirmation, and resets `created_at` and
 * `expires_at`, so a summary describes the current token and regeneration
 * restarts its delivery window.
 *
 * An issued token carries a delivery window, not a lifetime. Its plaintext
 * exists in one response, written to no log and recoverable from nowhere, so a
 * token whose holder never receives it is indistinguishable here from one in
 * use. Confirmation is the only evidence that the value arrived: the first
 * request that authenticates with it stamps `confirmed_at` and extends the
 * expiry to the full lifetime measured from that request. Before then the
 * window stands, and a value nobody presented stops authenticating.
 *
 * Expiry is decided here, once, by the database clock: every bearer route
 * resolves its credential through `findAccountByTokenHash`, so an expired
 * token is refused everywhere exactly as a token that was never issued — which
 * is what a token past its unconfirmed delivery window is. So is a deleted
 * account: resolution requires the account row to be live, and a token row
 * that outlives its account authenticates nobody.
 *
 * Nothing here hands back token material. A hash only ever arrives as an
 * argument, and a resolved account carries just the fields an actor needs.
 */
export class PostgresApiTokenStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async issueToken(userId: string, tokenHash: Buffer): Promise<ApiTokenSummary> {
    const [row] = await this.sql<{ created_at: Date; expires_at: Date; confirmed_at: Date | null }[]>`
      insert into api_tokens (user_id, token_hash, expires_at)
      values (
        ${userId}, ${tokenHash},
        now() + make_interval(mins => ${API_TOKEN_DELIVERY_WINDOW_MINUTES})
      )
      on conflict (user_id) do update
      set id = gen_random_uuid(), token_hash = excluded.token_hash,
          created_at = now(), expires_at = excluded.expires_at,
          last_used_at = null, confirmed_at = null
      returning created_at, expires_at, confirmed_at
    `;
    return { createdAt: row.created_at, expiresAt: row.expires_at, confirmedAt: row.confirmed_at };
  }

  public async findAccountByTokenHash(tokenHash: Buffer): Promise<ApiTokenAccount | null> {
    const [row] = await this.sql<
      { id: string; token_id: string; role: UserRole; enforcement_state: EnforcementState }[]
    >`
      with matched_token as (
        select id, user_id from api_tokens
        where token_hash = ${tokenHash} and expires_at > now()
      ), stamped as (
        -- Every expression on the right-hand side reads the row's PRE-image, so
        -- the confirmed_at test below judges the state this statement found and
        -- not the one it is writing. That is what makes two concurrent first
        -- uses idempotent: the loser of the row lock re-reads the winner's
        -- commit, finds confirmed_at set, and leaves expires_at alone, so the
        -- lifetime is measured from the FIRST use and never rolled forward.
        update api_tokens set
          confirmed_at = coalesce(confirmed_at, now()),
          expires_at = case when confirmed_at is null
            then now() + make_interval(days => ${API_TOKEN_LIFETIME_DAYS})
            else expires_at end,
          last_used_at = now()
        where id = (select id from matched_token)
          and (
            confirmed_at is null or last_used_at is null
            or last_used_at < now() - interval '1 minute'
          )
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
    // Confirming a token rewrites that expiry in the same statement that
    // resolves it, so both readings move together and stay one predicate.
    const [row] = await this.sql<
      { created_at: Date; expires_at: Date; confirmed_at: Date | null; expired: boolean }[]
    >`
      select created_at, expires_at, confirmed_at, expires_at <= now() as expired
      from api_tokens where user_id = ${userId} limit 1
    `;
    return row === undefined
      ? null
      : {
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        confirmedAt: row.confirmed_at,
        expired: row.expired,
      };
  }
}
