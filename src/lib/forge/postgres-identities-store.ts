import type { Sql } from "postgres";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { credentialBinding, decryptToken, tokenKeySetFrom } from "@/lib/security/token-cipher";
import type { ForgeIdentityStore, ForgeIdentityView } from "@/lib/forge/identities";

type IdentityRow = {
  id: string;
  provider: string;
  instance_url: string;
  forge_login: string;
  verified_at: Date;
  token_failed_at: Date | null;
};

/**
 * The Postgres implementation of identity storage. The upsert is conditional
 * on ownership: `on conflict (provider, instance_url, forge_user_id)` fires
 * its update only when the held row belongs to the linking user, so a re-link
 * by the owner refreshes the row while the same forge identity held by
 * another account inserts nothing and returns nothing — the caller's refusal.
 */
export class PostgresForgeIdentityStore implements ForgeIdentityStore {
  private readonly sql: Sql;
  private readonly tokenEncryptionKey: string | undefined;
  private readonly previousTokenEncryptionKey: string | undefined;

  public constructor(
    sql: Sql,
    tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
    previousTokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
  ) {
    this.sql = sql;
    this.tokenEncryptionKey = tokenEncryptionKey;
    this.previousTokenEncryptionKey = previousTokenEncryptionKey;
  }

  /**
   * The normalized instance's decrypted PAT and supplying identity id. Prefer
   * un-failed credentials, then the oldest failure stamp; equal failure stamps
   * (including null) prefer the most recently verified identity. Failed-only
   * sets still resolve; null means the user has no usable identity on that
   * instance — none at all, or one scrubbed by account deletion (a null
   * encrypted_token is never selected, so it is never decrypted).
   */
  public async getForgeToken(userId: string, instanceUrl: string): Promise<{ token: string; identityId: string } | null> {
    const normalized = normalizeInstanceUrl(instanceUrl);
    if (this.tokenEncryptionKey === undefined || this.tokenEncryptionKey.length === 0) {
      throw new Error("Token encryption key must be configured.");
    }
    const [row] = await this.sql<{
      id: string; provider: string; instance_url: string; forge_user_id: string | number; encrypted_token: Buffer;
    }[]>`
      select id, provider, instance_url, forge_user_id, encrypted_token
      from user_forge_identities
      where user_id = ${userId} and provider = 'gitlab' and instance_url = ${normalized}
        and encrypted_token is not null
      order by token_failed_at asc nulls first, verified_at desc
      limit 1
    `;
    if (row === undefined) {
      return null;
    }
    return {
      token: decryptToken(
        Buffer.from(row.encrypted_token).toString("utf8"),
        tokenKeySetFrom(this.tokenEncryptionKey, this.previousTokenEncryptionKey),
        credentialBinding.forgeToken({
          provider: row.provider, instanceUrl: row.instance_url, forgeUserId: row.forge_user_id,
        }),
      ),
      identityId: row.id,
    };
  }

  public async listForUser(userId: string): Promise<ForgeIdentityView[]> {
    const rows = await this.sql<IdentityRow[]>`
      select id, provider, instance_url, forge_login, verified_at, token_failed_at
      from user_forge_identities
      where user_id = ${userId}
      order by created_at
    `;
    return rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      instanceUrl: row.instance_url,
      forgeLogin: row.forge_login,
      verifiedAt: row.verified_at.toISOString(),
      tokenFailedAt: row.token_failed_at === null ? null : row.token_failed_at.toISOString(),
    }));
  }

  /**
   * Marks only the credential-supplying GitLab identity as needing re-verification.
   * Matching both the identity id and owner means a rejection never marks
   * another identity, even on the same instance. Missing or foreign rows match
   * nothing and silently succeed — the marker records a failure the fold already surfaced,
   * so there is nothing to refuse here.
   */
  public async markTokenRejected(userId: string, identityId: string): Promise<void> {
    await this.sql`
      update user_forge_identities
      set token_failed_at = now()
      where id = ${identityId} and user_id = ${userId} and provider = 'gitlab'
    `;
  }

  public async upsertIdentity(input: {
    userId: string;
    provider: string;
    instanceUrl: string;
    forgeUserId: number;
    forgeLogin: string;
    encryptedToken: string;
  }): Promise<ForgeIdentityView | null> {
    // The write is gated on a live account inside the statement itself: the
    // `eligible_account` CTE takes the same users row lock `deleteAccount`
    // holds, so the deleted_at re-check reads whichever transaction committed
    // second — a link cannot slip past the deletion, and the deletion cannot
    // scrub a link that has not happened yet. With the CTE empty (deleted or
    // absent account) the insert has no source rows, so neither the insert
    // leg nor the conflict-update leg writes anything and the caller's
    // existing null → FORBIDDEN mapping answers the refusal.
    const [row] = await this.sql<IdentityRow[]>`
      with eligible_account as (
        select id from users
        where id = ${input.userId} and deleted_at is null
        for update
      )
      insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at, token_failed_at)
      select ${input.userId}, ${input.provider}, ${input.instanceUrl}, ${input.forgeUserId},
             ${input.forgeLogin}, ${Buffer.from(input.encryptedToken, "utf8")}, now(), null
      from eligible_account
      on conflict (provider, instance_url, forge_user_id) do update
        set forge_login = excluded.forge_login,
            encrypted_token = excluded.encrypted_token,
            verified_at = now(),
            token_failed_at = null
        where user_forge_identities.user_id = excluded.user_id
      returning id, provider, instance_url, forge_login, verified_at, token_failed_at
    `;
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      provider: row.provider,
      instanceUrl: row.instance_url,
      forgeLogin: row.forge_login,
      verifiedAt: row.verified_at.toISOString(),
      tokenFailedAt: row.token_failed_at === null ? null : row.token_failed_at.toISOString(),
    };
  }

  public async deleteForUser(input: { identityId: string; userId: string }): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      delete from user_forge_identities
      where id = ${input.identityId} and user_id = ${input.userId}
      returning id
    `;
    return rows.length > 0;
  }
}
