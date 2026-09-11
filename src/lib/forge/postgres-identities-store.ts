import type { Sql } from "postgres";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { decryptToken } from "@/lib/security/token-cipher";
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

  public constructor(sql: Sql, tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY) {
    this.sql = sql;
    this.tokenEncryptionKey = tokenEncryptionKey;
  }

  /**
   * The linked instance's PAT, decrypted for gateway use — the credential the
   * GitLab registration and reconciliation paths read with. Null when the
   * user has no verified identity on that instance. The identity's own
   * normalization guarantees the lookup matches the stored row.
   */
  public async getForgeToken(userId: string, instanceUrl: string): Promise<string | null> {
    const normalized = normalizeInstanceUrl(instanceUrl);
    if (this.tokenEncryptionKey === undefined || this.tokenEncryptionKey.length === 0) {
      throw new Error("Token encryption key must be configured.");
    }
    const [row] = await this.sql<{ encrypted_token: Buffer }[]>`
      select encrypted_token
      from user_forge_identities
      where user_id = ${userId} and provider = 'gitlab' and instance_url = ${normalized}
      limit 1
    `;
    if (row === undefined) {
      return null;
    }
    return decryptToken(Buffer.from(row.encrypted_token).toString("utf8"), this.tokenEncryptionKey);
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
   * Marks the owner's identity on this instance as needing re-verification.
   * The statement matches the exact normalized instance and the provider the
   * gateway reads with, so a rejection made through one linked identity never
   * marks another's. Rows that do not exist match nothing and the mark is
   * silently done — the marker records a failure the fold already surfaced,
   * so there is nothing to refuse here.
   */
  public async markTokenRejected(userId: string, instanceUrl: string): Promise<void> {
    const normalized = normalizeInstanceUrl(instanceUrl);
    await this.sql`
      update user_forge_identities
      set token_failed_at = now()
      where user_id = ${userId} and provider = 'gitlab' and instance_url = ${normalized}
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
    const [row] = await this.sql<IdentityRow[]>`
      insert into user_forge_identities
        (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at, token_failed_at)
      values
        (${input.userId}, ${input.provider}, ${input.instanceUrl}, ${input.forgeUserId},
         ${input.forgeLogin}, ${Buffer.from(input.encryptedToken, "utf8")}, now(), null)
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
