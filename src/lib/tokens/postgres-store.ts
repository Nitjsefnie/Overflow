import { getSql } from "@/lib/db/client";
import type { EnforcementState, SqlClient, UserRole } from "@/lib/db/types";

export type ApiTokenAccount = {
  id: string;
  role: UserRole;
  enforcementState: EnforcementState;
};

export type ApiTokenSummary = {
  createdAt: Date;
};

/**
 * Issues and resolves the hashes of Overflow-issued API tokens.
 *
 * Issuing is one upsert on the `user_id` unique constraint, which is what makes
 * regeneration revoke the previous token atomically: a delete followed by an
 * insert would leave a window in which the account has no token, and a bare
 * insert a window in which it has two. Reissuing resets `created_at`, so a
 * summary always describes the token the account currently holds.
 *
 * Nothing here hands back token material. A hash only ever arrives as an
 * argument, and a resolved account carries just the fields an actor needs.
 */
export class PostgresApiTokenStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async issueToken(userId: string, tokenHash: Buffer): Promise<ApiTokenSummary> {
    const [row] = await this.sql<{ created_at: Date }[]>`
      insert into api_tokens (user_id, token_hash)
      values (${userId}, ${tokenHash})
      on conflict (user_id) do update
      set token_hash = excluded.token_hash, created_at = now()
      returning created_at
    `;
    return { createdAt: row.created_at };
  }

  public async findAccountByTokenHash(tokenHash: Buffer): Promise<ApiTokenAccount | null> {
    const [row] = await this.sql<
      { id: string; role: UserRole; enforcement_state: EnforcementState }[]
    >`
      select users.id, users.role, users.enforcement_state
      from api_tokens
      join users on users.id = api_tokens.user_id
      where api_tokens.token_hash = ${tokenHash}
      limit 1
    `;
    if (row === undefined) {
      return null;
    }
    return { id: row.id, role: row.role, enforcementState: row.enforcement_state };
  }

  public async getTokenSummary(userId: string): Promise<ApiTokenSummary | null> {
    const [row] = await this.sql<{ created_at: Date }[]>`
      select created_at from api_tokens where user_id = ${userId} limit 1
    `;
    return row === undefined ? null : { createdAt: row.created_at };
  }
}
