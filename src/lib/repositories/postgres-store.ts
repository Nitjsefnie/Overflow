import {
  isParticipationEligible,
  participationEligibleEnforcementStates,
  type EnforcementState,
  type SqlClient,
} from "@/lib/db/types";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  AbandonedWebhookCleanup,
  NewRegisteredRepository,
  RegisteredRepository,
  RepositoryCatalogChange,
  RepositoryRegistrationState,
  RepositoryRegistrationStore,
  RepositoryUnregisterOutcome,
} from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryProviderConflictError,
  RepositoryRegistrationEnforcementError,
  RepositorySchemeChangeForbiddenError,
  RepositorySchemeChangeOrderError,
  RepositoryWebhookIdConflictError,
} from "@/lib/repositories/register";
import { getCoordinationSql, getSql } from "@/lib/db/client";
import { decryptToken, encryptToken } from "@/lib/security/token-cipher";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { generateWebhookCredential, type WebhookCredentialRecord, type WebhookCredentialTarget } from "@/lib/webhooks/credentials";

type RepositoryRow = {
  id: string;
  github_repository_id: number | string;
  owner_name: string;
  sponsor_id: string;
  visibility: "PUBLIC" | "PRIVATE";
  github_webhook_id: number | string | null;
};

type RepositoryStateRow = RepositoryRow & {
  unregistered_at: Date | null;
};

type UnregisterLockRow = RepositoryStateRow & {
  provider: string;
};

type OAuthTokenRow = {
  encrypted_oauth_token: Buffer | null;
};

type AbandonedWebhookCleanupRow = {
  github_repository_id: number | string;
  owner_name: string;
  webhook_id: number | string;
  created_at: Date | string;
  provider: string;
  instance_url: string | null;
};

type EnforcementStateRow = {
  enforcement_state: EnforcementState;
};

type WebhookCredentialRow = {
  id: string; webhook_credential_id: string | null; encrypted_webhook_secret: Buffer | null;
  provider: "github" | "gitlab"; instance_url: string | null;
  project_id: string | number; github_webhook_id: string | number; webhook_configured_at: Date | null;
};

export class PostgresRepositoryStore implements RepositoryRegistrationStore {
  public constructor(
    private readonly sql: SqlClient = getSql(),
    private readonly tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
  ) {}

  public async findRepositoryProviderById(githubRepositoryId: number): Promise<string | null> {
    const [row] = await this.sql<{ provider: string | null }[]>`
      select provider
      from registered_repositories
      where github_repository_id = ${githubRepositoryId}
      limit 1
    `;
    // No row holds the id: no provider to collide with. Rows that predate
    // migration 038 carry the default 'github'.
    return row === undefined ? null : row.provider;
  }

  public async findWebhookCredential(selector: string, provider: "github" | "gitlab"): Promise<WebhookCredentialRecord | null> {
    const [row] = await this.sql<WebhookCredentialRow[]>`
      select id, webhook_credential_id, encrypted_webhook_secret, provider, instance_url,
        case when provider = 'github' then github_repository_id else forge_project_id end as project_id,
        github_webhook_id, webhook_configured_at
      from registered_repositories
      where webhook_credential_id = ${selector} and provider = ${provider}
        and active = true and unregistered_at is null
        and github_webhook_id is not null and encrypted_webhook_secret is not null
    `;
    if (row === undefined) return null;
    return this.toWebhookCredential(row);
  }

  /** A row lock mints once; the transaction commits pending material before any remote update. */
  public async stageWebhookCredential(target: WebhookCredentialTarget): Promise<WebhookCredentialRecord | null> {
    return await this.sql.begin(async (transaction) => {
      const [row] = await transaction<WebhookCredentialRow[]>`
        select id, webhook_credential_id, encrypted_webhook_secret, provider, instance_url,
          case when provider = 'github' then github_repository_id else forge_project_id end as project_id,
          github_webhook_id, webhook_configured_at
        from registered_repositories
        where id = ${target.repositoryId} and provider = ${target.provider}
          and instance_url is not distinct from ${target.instanceUrl}
          and (case when provider = 'github' then github_repository_id else forge_project_id end) = ${target.projectId}
          and github_webhook_id = ${target.webhookId} and active = true and unregistered_at is null
        for update
      `;
      if (row === undefined) return null;
      if (row.webhook_credential_id !== null) return this.toWebhookCredential(row);
      const credential = generateWebhookCredential();
      const encrypted = Buffer.from(encryptToken(credential.secret, this.tokenEncryptionKey ?? ""), "utf8");
      await transaction`
        update registered_repositories set webhook_credential_id = ${credential.id},
          encrypted_webhook_secret = ${encrypted}, webhook_configured_at = null
        where id = ${row.id}
      `;
      return this.toWebhookCredential({ ...row, webhook_credential_id: credential.id, encrypted_webhook_secret: encrypted });
    });
  }

  public async finalizeWebhookCredential(credential: WebhookCredentialRecord): Promise<boolean> {
    const [row] = await this.sql<{ id: string }[]>`
      update registered_repositories set webhook_configured_at = coalesce(webhook_configured_at, now())
      where id = ${credential.repositoryId} and webhook_credential_id = ${credential.credentialId}
        and provider = ${credential.provider} and instance_url is not distinct from ${credential.instanceUrl}
        and (case when provider = 'github' then github_repository_id else forge_project_id end) = ${credential.projectId}
        and github_webhook_id = ${credential.webhookId} and active = true and unregistered_at is null
      returning id
    `;
    return row !== undefined;
  }

  public async withWebhookUpgradeLock<T>(repositoryId: string, operation: () => Promise<T>): Promise<T> {
    return getCoordinationSql().begin(async (transaction) => {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`webhook-upgrade:${repositoryId}`}, 0))`;
      return operation();
    }) as Promise<T>;
  }

  private toWebhookCredential(row: WebhookCredentialRow): WebhookCredentialRecord {
    if (row.webhook_credential_id === null || row.encrypted_webhook_secret === null) {
      throw new Error("Webhook credential material is incomplete.");
    }
    return {
      repositoryId: row.id, credentialId: row.webhook_credential_id,
      secret: decryptToken(Buffer.from(row.encrypted_webhook_secret).toString("utf8"), this.tokenEncryptionKey ?? ""),
      provider: row.provider,
      instanceUrl: row.instance_url === null ? null : normalizeInstanceUrl(row.instance_url),
      projectId: toSafeInteger(row.project_id), webhookId: toSafeInteger(row.github_webhook_id),
      configuredAt: row.webhook_configured_at,
    };
  }

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

  public async findRepositoryRegistrationStateByOwnerName(ownerName: string): Promise<RepositoryRegistrationState | null> {
    const [row] = await this.sql<RepositoryStateRow[]>`
      select
        id,
        github_repository_id,
        owner_name,
        sponsor_id,
        visibility,
        github_webhook_id,
        unregistered_at
      from registered_repositories
      where owner_name = ${ownerName}
      limit 1
    `;
    return row === undefined ? null : toRegistrationState(row);
  }

  /**
   * The GitLab registration holding this owner/name path, with the hook
   * target fields the unregistration's forge-first deletion needs (issue
   * 547). Null when no row holds the path AND when a GitHub registration
   * holds it — the GitHub flow owns those rows' hook deletion.
   */
  public async findGitLabWebhookTargetByOwnerName(ownerName: string): Promise<{
    sponsorId: string;
    githubWebhookId: number | null;
    instanceUrl: string | null;
  } | null> {
    const [row] = await this.sql<{ sponsor_id: string; github_webhook_id: number | string | null; instance_url: string | null }[]>`
      select sponsor_id, github_webhook_id, instance_url
      from registered_repositories
      where owner_name = ${ownerName} and provider = 'gitlab'
      limit 1
    `;
    if (row === undefined) {
      return null;
    }
    return {
      sponsorId: row.sponsor_id,
      githubWebhookId: row.github_webhook_id === null ? null : toSafeInteger(row.github_webhook_id),
      instanceUrl: row.instance_url,
    };
  }

  public async findRepositoryRegistrationState(githubRepositoryId: number): Promise<RepositoryRegistrationState | null> {
    const [row] = await this.sql<RepositoryStateRow[]>`
      select
        id,
        github_repository_id,
        owner_name,
        sponsor_id,
        visibility,
        github_webhook_id,
        unregistered_at
      from registered_repositories
      where github_repository_id = ${githubRepositoryId}
      limit 1
    `;
    return row === undefined ? null : toRegistrationState(row);
  }

  // Exactly one of forgeProjectId and ownerName is set by the caller. The
  // partial index on (provider, instance_url, forge_project_id) serves the id
  // form; the path form matches the stored owner_name, which carries the
  // path_with_namespace.
  public async findRepositoryRegistrationStateByForgeIdentity(
    input: { provider: string; instanceUrl: string; forgeProjectId?: number; ownerName?: string },
  ): Promise<RepositoryRegistrationState | null> {
    if (input.forgeProjectId !== undefined) {
      const [row] = await this.sql<RepositoryStateRow[]>`
        select
          id,
          github_repository_id,
          owner_name,
          sponsor_id,
          visibility,
          github_webhook_id,
          unregistered_at
        from registered_repositories
        where provider = ${input.provider}
          and instance_url = ${input.instanceUrl}
          and forge_project_id = ${input.forgeProjectId}
        limit 1
      `;
      return row === undefined ? null : toRegistrationState(row);
    }

    // The interface contract names exactly one of the two keys, so an input
    // with neither is a caller bug; the guard exists to keep the tagged
    // template's parameter honest, never to answer a lookup.
    const ownerName = input.ownerName;
    if (ownerName === undefined) {
      throw new Error("The forge identity names neither a project id nor a project path.");
    }

    const [row] = await this.sql<RepositoryStateRow[]>`
      select
        id,
        github_repository_id,
        owner_name,
        sponsor_id,
        visibility,
        github_webhook_id,
        unregistered_at
      from registered_repositories
      where provider = ${input.provider}
        and instance_url = ${input.instanceUrl}
        and owner_name = ${ownerName}
      limit 1
    `;
    return row === undefined ? null : toRegistrationState(row);
  }

  public async unregisterRepository(input: {
    ownerName: string;
    sponsorId: string;
    provider: "github" | "gitlab";
  }): Promise<RepositoryUnregisterOutcome> {
    return await this.sql.begin(async (transaction) => {
      // The row lock holds to the end of the transaction, so the provider
      // check, the sponsor check, the unregistered_at check and the write all
      // see one committed state: two racing unregister calls resolve
      // sequentially, and a concurrent createRepository reactivation cannot
      // interleave between them.
      const [row] = await transaction<UnregisterLockRow[]>`
        select
          id,
          github_repository_id,
          owner_name,
          sponsor_id,
          visibility,
          github_webhook_id,
          unregistered_at,
          provider
        from registered_repositories
        where owner_name = ${input.ownerName}
        limit 1
        for update
      `;
      if (row === undefined) {
        return { kind: "NOT_REGISTERED" };
      }
      // Before the sponsor check, in the order the register.ts guard pins: a
      // row another forge holds is a collision whoever asks (issue 571).
      if (row.provider !== input.provider) {
        return {
          kind: "PROVIDER_CONFLICT",
          githubRepositoryId: toSafeInteger(row.github_repository_id),
          storedProvider: row.provider,
        };
      }
      if (row.sponsor_id !== input.sponsorId) {
        return { kind: "FORBIDDEN" };
      }
      if (row.unregistered_at !== null) {
        return { kind: "ALREADY_UNREGISTERED", repository: toRegisteredRepository(row) };
      }

      // active and unregistered_at move in one statement so the check
      // constraint's invariant — an active row was never unregistered —
      // holds in every committed state.
      const [updated] = await transaction<RepositoryRow[]>`
        update registered_repositories
        set active = false, unregistered_at = now(), updated_at = now()
        where id = ${row.id} and sponsor_id = ${input.sponsorId}
        returning
          id,
          github_repository_id,
          owner_name,
          sponsor_id,
          visibility,
          github_webhook_id
      `;
      // Unreachable through the flow above — the lock guarantees the row —
      // but a zero-row write after a passed sponsor lock must not read as
      // success.
      if (updated === undefined) {
        return { kind: "NOT_REGISTERED" };
      }
      return { kind: "UNREGISTERED", repository: toRegisteredRepository(updated) };
    });
  }

  public async createRepository(repository: NewRegisteredRepository): Promise<RegisteredRepository | null> {
    const credential = repository.webhookCredential;
    const encryptedSecret = credential == null ? null : Buffer.from(
      encryptToken(credential.secret, this.tokenEncryptionKey ?? ""), "utf8",
    );
    try {
      // The registration and its first catalog version are one statement, so a
      // repository row never exists without the version that governs from its
      // registration instant. `now()` is transaction time, the same instant
      // created_at records. An on-conflict insert fires its update only when
      // the held row carries an unregistration instant — the sponsor left, so
      // the resubmission reactivates that same row, moving the stored catalog
      // and appending the submitted one as the next version (the versions
      // table's key is (github_repository_id, version_number), so a second
      // version 1 would fail every re-registration). On a where-clause skip
      // `inserted` is empty, so a still-registered resubmission seeds no
      // version either.
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
            difficulty_scheme,
            provider,
            instance_url,
            forge_project_id,
            webhook_credential_id,
            encrypted_webhook_secret,
            webhook_configured_at
          )
          select
            ${repository.githubRepositoryId},
            ${repository.ownerName},
            eligible_sponsor.id,
            ${repository.visibility},
            ${repository.githubWebhookId},
            ${this.sql.json(repository.difficultyScheme)},
            ${repository.provider ?? "github"},
            ${repository.instanceUrl ?? null},
            ${repository.forgeProjectId ?? null},
            ${credential?.id ?? null},
            ${encryptedSecret},
            ${credential == null ? null : new Date()}
          from eligible_sponsor
          on conflict (github_repository_id) do update set
            owner_name = excluded.owner_name,
            sponsor_id = excluded.sponsor_id,
            visibility = excluded.visibility,
            github_webhook_id = excluded.github_webhook_id,
            difficulty_scheme = excluded.difficulty_scheme,
            provider = excluded.provider,
            instance_url = excluded.instance_url,
            forge_project_id = excluded.forge_project_id,
            webhook_credential_id = excluded.webhook_credential_id,
            encrypted_webhook_secret = excluded.encrypted_webhook_secret,
            webhook_configured_at = excluded.webhook_configured_at,
            active = true,
            unregistered_at = null,
            updated_at = now()
          where registered_repositories.unregistered_at is not null
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
            coalesce((
              select max(version_number)
              from repository_difficulty_scheme_versions
              where github_repository_id = inserted.github_repository_id
            ), 0) + 1,
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
      // A null id cannot collide: Postgres unique indexes let NULLs
      // coexist, so this conflict always names a claimed non-null id.
      if (constraint === webhookIdConstraint && repository.githubWebhookId !== null) {
        throw new RepositoryWebhookIdConflictError(repository.githubWebhookId);
      }
      throw error;
    }
  }

  public async appendDifficultySchemeVersion(input: {
    githubRepositoryId: number;
    sponsorId: string;
    provider: "github" | "gitlab";
    scheme: DifficultyScheme;
    effectiveFrom: Date;
  }): Promise<RepositoryCatalogChange | null> {
    return await this.sql.begin(async (transaction) => {
        // The row lock serializes appends for one repository, so two racing
        // sponsors' versions number themselves off the same committed history,
        // and the provider check below holds at write time.
        const [row] = await transaction<{
          id: string;
          sponsor_id: string;
          provider: string;
          difficulty_scheme: DifficultyScheme;
        }[]>`
          select id, sponsor_id, provider, difficulty_scheme
          from registered_repositories
          where github_repository_id = ${input.githubRepositoryId}
          limit 1
          for update
        `;
        if (row === undefined) {
          return null;
        }
        // Before the sponsor check, in the order the register.ts guard pins: a
        // row another forge holds is a collision whoever asks (issue 571).
        if (row.provider !== input.provider) {
          throw new RepositoryProviderConflictError(input.githubRepositoryId, input.provider, row.provider);
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

  /**
   * The active registration's forge columns — the pair the webhook upgrade
   * drain branches on (issue 547). Null when the row is gone or no longer
   * active; the drain answers REGISTRATION_FAILED for that.
   */
  public async findActiveRepositoryForgeById(
    repositoryId: string,
  ): Promise<{ provider: string; instanceUrl: string | null } | null> {
    const [row] = await this.sql<{ provider: string; instance_url: string | null }[]>`
      select provider, instance_url
      from registered_repositories
      where id = ${repositoryId} and active = true
      limit 1
    `;
    return row === undefined ? null : { provider: row.provider, instanceUrl: row.instance_url };
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

  // The abandoned-webhook cleanup surface (issue 451): the record written before
  // the compensating delete is attempted, the queue the drain reads, and the
  // removal once the hook is proven gone. Kept as one contiguous block so a
  // concurrent edit of this file lands beside it, not inside it.

  public async saveAbandonedWebhookCleanup(record: AbandonedWebhookCleanup): Promise<void> {
    await this.sql`
      insert into abandoned_webhook_cleanups
        (github_repository_id, owner_name, webhook_id, created_at, provider, instance_url)
      values
        (${record.githubRepositoryId}, ${record.ownerName}, ${record.webhookId}, ${record.createdAt}::timestamptz,
         ${record.provider}, ${record.instanceUrl})
      on conflict (github_repository_id, provider, webhook_id) do update set
        owner_name = excluded.owner_name,
        created_at = excluded.created_at,
        instance_url = excluded.instance_url
    `;
  }

  public async listAbandonedWebhookCleanups(): Promise<AbandonedWebhookCleanup[]> {
    const rows = await this.sql<AbandonedWebhookCleanupRow[]>`
      select
        github_repository_id,
        owner_name,
        webhook_id,
        created_at,
        provider,
        instance_url
      from abandoned_webhook_cleanups
      order by created_at asc, github_repository_id asc, provider asc, webhook_id asc
    `;
    return rows.map(toAbandonedWebhookCleanup);
  }

  public async clearAbandonedWebhookCleanup(githubRepositoryId: number, provider: "github" | "gitlab", webhookId: number): Promise<void> {
    await this.sql`
      delete from abandoned_webhook_cleanups
      where github_repository_id = ${githubRepositoryId} and provider = ${provider} and webhook_id = ${webhookId}
    `;
  }
}

function toRegisteredRepository(row: RepositoryRow): RegisteredRepository {
  return {
    id: row.id,
    githubRepositoryId: toSafeInteger(row.github_repository_id),
    ownerName: row.owner_name,
    sponsorId: row.sponsor_id,
    visibility: row.visibility,
    githubWebhookId: row.github_webhook_id === null ? null : toSafeInteger(row.github_webhook_id),
  };
}

function toRegistrationState(row: RepositoryStateRow): RepositoryRegistrationState {
  return {
    repository: toRegisteredRepository(row),
    unregisteredAt: row.unregistered_at === null ? null : timestampToIso(row.unregistered_at),
  };
}

function toAbandonedWebhookCleanup(row: AbandonedWebhookCleanupRow): AbandonedWebhookCleanup {
  return {
    githubRepositoryId: toSafeInteger(row.github_repository_id),
    ownerName: row.owner_name,
    webhookId: toSafeInteger(row.webhook_id),
    createdAt: timestampToIso(row.created_at),
    provider: row.provider === "gitlab" ? "gitlab" : "github",
    instanceUrl: row.instance_url,
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
