import type { SqlClient } from "@/lib/db/types";
import { credentialBinding, decryptToken, tokenKeySetFrom } from "@/lib/security/token-cipher";

export class PostgresSponsorCredentialStore {
  public constructor(
    private readonly sql: SqlClient,
    private readonly tokenEncryptionKey: string | undefined,
    private readonly previousTokenEncryptionKey: string | undefined,
  ) {}

  public async getGitHubAccessToken(userId: string): Promise<string | null> {
    const [row] = await this.sql<{ github_user_id: string | number; encrypted_oauth_token: Buffer | null }[]>`
      select github_user_id, encrypted_oauth_token from users where id = ${userId} limit 1
    `;
    if (row === undefined || row.encrypted_oauth_token === null) {
      return null;
    }
    const keys = tokenKeySetFrom(this.tokenEncryptionKey, this.previousTokenEncryptionKey);
    return decryptToken(Buffer.from(row.encrypted_oauth_token).toString("utf8"), keys,
      credentialBinding.userOAuthToken(row.github_user_id));
  }
}
