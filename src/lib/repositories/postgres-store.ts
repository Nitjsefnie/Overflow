import type { SqlClient } from "@/lib/db/types";
import type {
  NewRegisteredRepository,
  RegisteredRepository,
  RepositoryRegistrationStore,
} from "@/lib/repositories/register";
import { getSql } from "@/lib/db/client";
import { decryptToken } from "@/lib/security/token-cipher";

type RepositoryRow = {
  id: string;
  github_repository_id: number | string;
  owner_name: string;
  sponsor_id: string;
  visibility: "PUBLIC" | "PRIVATE";
  github_webhook_id: number | string;
};

type OAuthTokenRow = {
  encrypted_oauth_token: Buffer | null;
};

export class PostgresRepositoryStore implements RepositoryRegistrationStore {
  public constructor(
    private readonly sql: SqlClient = getSql(),
    private readonly tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
  ) {}

  public async findRepositoryByGitHubId(githubRepositoryId: number): Promise<RegisteredRepository | null> {
    const [row] = await this.sql<RepositoryRow[]>`
      select
        id,
        github_repository_id,
        owner_name,
        sponsor_id,
        visibility,
        github_webhook_id
      from registered_repositories
      where github_repository_id = ${githubRepositoryId}
      limit 1
    `;
    return row === undefined ? null : toRegisteredRepository(row);
  }

  public async createRepository(repository: NewRegisteredRepository): Promise<RegisteredRepository | null> {
    try {
      const [row] = await this.sql<RepositoryRow[]>`
        insert into registered_repositories (
          github_repository_id,
          owner_name,
          sponsor_id,
          visibility,
          github_webhook_id,
          difficulty_scheme
        )
        values (
          ${repository.githubRepositoryId},
          ${repository.ownerName},
          ${repository.sponsorId},
          ${repository.visibility},
          ${repository.githubWebhookId},
          ${this.sql.json(repository.difficultyScheme)}
        )
        returning
          id,
          github_repository_id,
          owner_name,
          sponsor_id,
          visibility,
          github_webhook_id
      `;
      if (row === undefined) {
        throw new Error("Repository insert returned no row.");
      }

      return toRegisteredRepository(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  public async getGitHubAccessToken(userId: string): Promise<string | null> {
    const [row] = await this.sql<OAuthTokenRow[]>`
      select encrypted_oauth_token
      from users
      where id = ${userId}
      limit 1
    `;
    if (row?.encrypted_oauth_token === null || row === undefined) {
      return null;
    }

    const tokenEncryptionKey = this.tokenEncryptionKey;
    if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
      throw new Error("Token encryption key must be configured.");
    }

    return decryptToken(Buffer.from(row.encrypted_oauth_token).toString("utf8"), tokenEncryptionKey);
  }
}

function toRegisteredRepository(row: RepositoryRow): RegisteredRepository {
  return {
    id: row.id,
    githubRepositoryId: toSafeInteger(row.github_repository_id),
    ownerName: row.owner_name,
    sponsorId: row.sponsor_id,
    visibility: row.visibility,
    githubWebhookId: toSafeInteger(row.github_webhook_id),
  };
}

function toSafeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Repository record was invalid.");
  }
  return parsed;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
