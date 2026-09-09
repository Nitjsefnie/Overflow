import {
  isParticipationEligible,
  participationEligibleEnforcementStates,
  type EnforcementState,
  type SqlClient,
} from "@/lib/db/types";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  NewRegisteredRepository,
  RegisteredRepository,
  RepositoryCatalogChange,
  RepositoryRegistrationStore,
} from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
  RepositorySchemeChangeForbiddenError,
  RepositorySchemeChangeOrderError,
  RepositoryWebhookIdConflictError,
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

type EnforcementStateRow = {
  enforcement_state: EnforcementState;
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
      // The registration and its first catalog version are one statement, so a
      // repository row never exists without the version that governs from its
      // registration instant. `now()` is transaction time, the same instant
      // created_at records, and `inserted` is empty on an on-conflict skip, so
      // a re-submitted registration seeds no version either.
      const [row] = await this.sql<RepositoryRow[]>`
        with eligible_sponsor as (
          select id
          from users
          where id = ${repository.sponsorId}
            and enforcement_state::text = any(${this.sql.array([...participationEligibleEnforcementStates])})
          for update
        ),
        inserted as (
          insert into registered_repositories (
            github_repository_id,
            owner_name,
            sponsor_id,
            visibility,
            github_webhook_id,
            difficulty_scheme
          )
          select
            ${repository.githubRepositoryId},
            ${repository.ownerName},
            eligible_sponsor.id,
            ${repository.visibility},
            ${repository.githubWebhookId},
            ${this.sql.json(repository.difficultyScheme)}
          from eligible_sponsor
          on conflict (github_repository_id) do nothing
          returning
            id,
            github_repository_id,
            owner_name,
            sponsor_id,
            visibility,
            github_webhook_id
        ),
        first_version as (
          insert into repository_difficulty_scheme_versions (
            github_repository_id,
            version_number,
            scheme,
            effective_from
          )
          select
            inserted.github_repository_id,
            1,
            ${this.sql.json(repository.difficultyScheme)},
            now()
          from inserted
        )
        select
          id,
          github_repository_id,
          owner_name,
          sponsor_id,
          visibility,
          github_webhook_id
        from inserted
      `;
      if (row === undefined) {
        const enforcementState = await this.getEnforcementState(repository.sponsorId);
        if (enforcementState === null || !isParticipationEligible(enforcementState)) {
          throw new RepositoryRegistrationEnforcementError();
        }
        return null;
      }

      return toRegisteredRepository(row);
    } catch (error) {
      // A duplicate github_repository_id never lands here: the on-conflict clause above absorbs
      // it and the caller reads the missing row as "already registered". Every other unique
      // constraint on the table describes a different collision, so answering "already
      // registered" for one of those names a repository the sponsor did not submit.
      const constraint = uniqueViolationConstraint(error);
      if (constraint === ownerNameConstraint) {
        throw new RepositoryOwnerNameConflictError(repository.ownerName);
      }
      if (constraint === webhookIdConstraint) {
        throw new RepositoryWebhookIdConflictError(repository.githubWebhookId);
      }
      throw error;
    }
  }

  public async appendDifficultySchemeVersion(input: {
    githubRepositoryId: number;
    sponsorId: string;
    scheme: DifficultyScheme;
    effectiveFrom: Date;
  }): Promise<RepositoryCatalogChange | null> {
    return await this.sql.begin(async (transaction) => {
        // The row lock serializes appends for one repository, so two racing
        // sponsors' versions number themselves off the same committed history.
        const [row] = await transaction<{
          id: string;
          sponsor_id: string;
          difficulty_scheme: DifficultyScheme;
        }[]>`
          select id, sponsor_id, difficulty_scheme
          from registered_repositories
          where github_repository_id = ${input.githubRepositoryId}
          limit 1
          for update
        `;
        if (row === undefined) {
          return null;
        }
        if (row.sponsor_id !== input.sponsorId) {
          throw new RepositorySchemeChangeForbiddenError(input.githubRepositoryId);
        }
        if (sameDifficultyScheme(row.difficulty_scheme, input.scheme)) {
          return { changed: false, versionNumber: null, effectiveFrom: null };
        }

        // Windows are assigned once and never rewritten, so an append may begin
        // governing at or after the version before it. A backdated append would
        // silently re-assign which catalog governs closures that already
        // settled — exactly the destructive write versioning exists to prevent.
        const [history] = await transaction<{ latest_effective_from: Date | string | null }[]>`
          select max(effective_from) as latest_effective_from
          from repository_difficulty_scheme_versions
          where github_repository_id = ${input.githubRepositoryId}
        `;
        const latestEffectiveFrom = history?.latest_effective_from;
        if (
          latestEffectiveFrom !== null &&
          latestEffectiveFrom !== undefined &&
          new Date(latestEffectiveFrom).getTime() > input.effectiveFrom.getTime()
        ) {
          throw new RepositorySchemeChangeOrderError(input.githubRepositoryId);
        }

        const [version] = await transaction<{
          version_number: number | string;
          effective_from: Date | string;
        }[]>`
          insert into repository_difficulty_scheme_versions (
            github_repository_id,
            version_number,
            scheme,
            effective_from
          )
          values (
            ${input.githubRepositoryId},
            (
              select coalesce(max(version_number), 0) + 1
              from repository_difficulty_scheme_versions
              where github_repository_id = ${input.githubRepositoryId}
            ),
            ${this.sql.json(input.scheme)},
            ${input.effectiveFrom}
          )
          returning version_number, effective_from
        `;
        if (version === undefined) {
          throw new Error("Appending a difficulty catalog version produced no row.");
        }

        await transaction`
          update registered_repositories
          set difficulty_scheme = ${this.sql.json(input.scheme)}
          where id = ${row.id}
        `;

        return {
          changed: true,
          versionNumber: toSafeInteger(version.version_number),
          effectiveFrom: timestampToIso(version.effective_from),
        };
      });
  }

  public async findActiveRepositoryById(repositoryId: string): Promise<RegisteredRepository | null> {
    const [row] = await this.sql<RepositoryRow[]>`
      select id, github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id
      from registered_repositories
      where id = ${repositoryId} and active = true
      limit 1
    `;
    return row === undefined ? null : toRegisteredRepository(row);
  }

  public async getEnforcementState(userId: string): Promise<EnforcementState | null> {
    const [row] = await this.sql<EnforcementStateRow[]>`
      select enforcement_state
      from users
      where id = ${userId}
      limit 1
    `;
    return row?.enforcement_state ?? null;
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

function timestampToIso(value: string | Date): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Repository record was invalid.");
  }
  return parsed.toISOString();
}

/**
 * Whether two catalogs are the same catalog, compared on their content rather
 * than their shape: label order carries no meaning the validation or the fold
 * reads, so a resubmission that merely reorders its labels is the unchanged
 * catalog, not a new version.
 */
function sameDifficultyScheme(left: DifficultyScheme, right: DifficultyScheme): boolean {
  return JSON.stringify(canonicalDifficultyScheme(left)) === JSON.stringify(canonicalDifficultyScheme(right));
}

function canonicalDifficultyScheme(scheme: DifficultyScheme): unknown {
  return {
    openingName: scheme.openingName,
    actualName: scheme.actualName,
    openingLabels: scheme.openingLabels
      .map((label) => ({ label: label.label, comparisonPoints: label.comparisonPoints, reservePoints: label.reservePoints }))
      .sort((left, right) => left.label.localeCompare(right.label)),
    actualLabels: scheme.actualLabels
      .map((label) => ({ label: label.label, points: label.points }))
      .sort((left, right) => left.points - right.points),
  };
}

// PostgreSQL names an inline column `unique` after its table and column, and the postgres
// driver copies the server's error fields onto the thrown error verbatim, so the failing
// constraint arrives as the snake_case `constraint_name`.
const ownerNameConstraint = "registered_repositories_owner_name_key";
const webhookIdConstraint = "registered_repositories_github_webhook_id_key";

function uniqueViolationConstraint(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const reported = error as { code?: unknown; constraint_name?: unknown };
  if (reported.code !== "23505" || typeof reported.constraint_name !== "string") {
    return null;
  }
  return reported.constraint_name;
}
