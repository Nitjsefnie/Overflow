import type { EnforcementState, SqlClient } from "@/lib/db/types";
import type { DifficultyScheme, DifficultySchemeVersion } from "@/lib/domain/difficulty-scheme";
import { moderationEventsFromJson } from "@/lib/fold/moderation-history";
import { timestampToIso, toSafeInteger } from "@/lib/fold/postgres-row-mapping";
import type { ReconciliationRepository, RepositoryUnavailableReason } from "@/lib/fold/reconcile";
import type { RepositoryCoordinator } from "@/lib/fold/repository-coordination";
import type { FoldForgeIdentity, FoldUser } from "@/lib/fold/repository-fold";
import { logField } from "@/lib/webhooks/log-field";
import type { RegisteredRepository } from "@/lib/repositories/register";

type RepositoryRow = {
  id: string;
  github_repository_id: number | string;
  owner_name: string;
  active: boolean;
  created_at: string | Date;
  difficulty_scheme: DifficultyScheme;
  provider: string | null;
  instance_url: string | null;
  sponsor_id: string;
  sponsor_github_user_id: number | string;
  sponsor_github_login: string;
  sponsor_enforcement_state: EnforcementState;
  sponsor_moderation_events: unknown;
  dispute_pull_requests: { id: string; number: number }[];
};

type UserRow = {
  id: string;
  github_user_id: number | string;
  github_login: string;
  enforcement_state: EnforcementState;
  moderation_events: unknown;
};

export class PostgresRepositoryLookupStore {
  public constructor(
    private readonly sql: SqlClient,
    private readonly coordinator: RepositoryCoordinator,
  ) {}

  public async findForgeIdentitiesByForgeUserIds(
    repositoryId: string,
    forgeUserIds: number[],
  ): Promise<FoldForgeIdentity[]> {
    if (forgeUserIds.length === 0) return [];
    // Scope: the exact triple's repository-side columns. The fold's match is
    // the triple by construction, so the same forge id on another instance or
    // another forge never resolves here.
    // The moderation-events projection mirrors the GitHub identity query: the
    // fold's participation gate replays at-merge state from these events, and
    // a forge identity whose account was banned at merge but unbanned later
    // must replay the ban, not the current state.
    const rows = await this.sql<{
      id: string;
      github_user_id: number | string;
      github_login: string;
      enforcement_state: EnforcementState;
      forge_user_id: number | string;
      moderation_events: unknown;
    }[]>`
      select users.id, users.github_user_id, users.github_login, users.enforcement_state,
             identities.forge_user_id,
             coalesce((
               select jsonb_agg(jsonb_build_object(
                 'id', events.id,
                 'priorState', events.prior_state,
                 'newState', events.new_state,
                 'occurredAt', events.created_at
               ) order by events.created_at, events.id)
               from moderation_events as events
               where events.target_user_id = users.id
             ), '[]'::jsonb) as moderation_events
      from user_forge_identities as identities
      join users on users.id = identities.user_id
      join registered_repositories as repositories
        on repositories.provider = identities.provider
        and repositories.instance_url = identities.instance_url
      where repositories.id = ${repositoryId}
        and identities.provider = 'gitlab'
        and identities.forge_user_id = any(${this.sql.array(forgeUserIds)}::bigint[])
    `;
    return rows.map((row) => ({
      forgeUserId: toSafeInteger(row.forge_user_id),
      user: {
        id: row.id,
        githubUserId: toSafeInteger(row.github_user_id),
        githubLogin: row.github_login,
        enforcementState: row.enforcement_state,
        moderationEvents: moderationEventsFromJson(row.moderation_events),
      },
    }));
  }

  public async getRepository(repositoryId: string): Promise<ReconciliationRepository | null> {
    const [row] = await this.sql<RepositoryRow[]>`
      select
        repositories.id,
        repositories.github_repository_id,
        repositories.owner_name,
        repositories.active,
        repositories.created_at,
        repositories.difficulty_scheme,
        repositories.provider,
        repositories.instance_url,
        sponsors.id as sponsor_id,
        sponsors.github_user_id as sponsor_github_user_id,
        sponsors.github_login as sponsor_github_login,
        sponsors.enforcement_state as sponsor_enforcement_state,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', events.id,
            'priorState', events.prior_state,
            'newState', events.new_state,
            'occurredAt', events.created_at
          ) order by events.created_at, events.id)
          from moderation_events as events
          where events.target_user_id = sponsors.id
        ), '[]'::jsonb) as sponsor_moderation_events,
        coalesce((
          select jsonb_agg(jsonb_build_object('id', pr.github_pull_request_id::text, 'number', pr.pull_request_number)
            order by pr.github_pull_request_id)
          from pull_requests pr
          where pr.repository_id = repositories.id
            and exists (select 1 from closed_pr_dispute_requests requests where requests.pull_request_id = pr.id)
        ), '[]'::jsonb) as dispute_pull_requests
      from registered_repositories as repositories
      join users as sponsors on sponsors.id = repositories.sponsor_id
      where repositories.id = ${repositoryId}
      limit 1
    `;
    if (row === undefined) {
      return null;
    }
    const difficultySchemeVersions = await this.listDifficultySchemeVersions(row.github_repository_id);
    return toReconciliationRepository(row, difficultySchemeVersions);
  }

  private async listDifficultySchemeVersions(
    githubRepositoryId: number | string,
  ): Promise<DifficultySchemeVersion[]> {
    const rows = await this.sql<{
      version_number: number | string;
      scheme: DifficultyScheme;
      effective_from: string | Date;
    }[]>`
      select version_number, scheme, effective_from
      from repository_difficulty_scheme_versions
      where github_repository_id = ${githubRepositoryId}
      order by effective_from, version_number
    `;
    return rows.map((row) => ({
      versionNumber: toSafeInteger(row.version_number),
      scheme: row.scheme,
      effectiveFrom: timestampToIso(row.effective_from),
    }));
  }

  public async recordVerifiedRepositoryIdentity(input: {
    repositoryId: string;
    ownerName: string;
    visibility: "PUBLIC";
  }): Promise<void> {
    try {
      await this.coordinator.withRepositoryPublication(input.repositoryId, async (transaction) => {
        await transaction`
          update registered_repositories
          set
            owner_name = ${input.ownerName},
            visibility = ${input.visibility},
            unavailable_reason = null,
            unavailable_since = null,
            updated_at = now()
          where id = ${input.repositoryId}
            and (owner_name, visibility, unavailable_reason)
              is distinct from (${input.ownerName}, ${input.visibility}, null)
        `;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // owner_name is unique and a rename can land on a path another registration
      // still holds. The numeric id already proved which repository this row is, so
      // keep the crawl available and leave the display name to the row that owns it; the verified path is forge text, so the warning encodes it (issue 1042).
      console.warn(
        `Verified owner name ${logField(input.ownerName)} for repository ${input.repositoryId} is already registered `
        + "to another repository. The stored path stays stale, so this recurs on every reconciliation until the other registration releases the path.",
      );
      await this.coordinator.withRepositoryPublication(input.repositoryId, async (transaction) => {
        await transaction`
          update registered_repositories
          set
            visibility = ${input.visibility},
            unavailable_reason = null,
            unavailable_since = null,
            updated_at = now()
          where id = ${input.repositoryId}
        `;
      });
    }
  }

  // The sweep re-attempts a dark repository every few hours for as long as it stays
  // dark, so a repeat of the reason already recorded must not touch the row at all.
  public async markRepositoryUnavailable(input: {
    repositoryId: string;
    reason: RepositoryUnavailableReason;
    at: Date;
  }): Promise<void> {
    // The where guard is what preserves the first observation: a row whose reason
    // already equals the input never reaches this set list, so every row that does
    // is taking on a reason it did not carry before. Relaxing that guard would
    // require unavailable_since to go back to keeping the earlier value.
    await this.coordinator.withRepositoryPublication(input.repositoryId, async (transaction) => {
      await transaction`
        update registered_repositories
        set
          unavailable_reason = ${input.reason},
          unavailable_since = ${input.at},
          updated_at = now()
        where id = ${input.repositoryId}
          and unavailable_reason is distinct from ${input.reason}
      `;
    });
  }

  public async findRepositoryByOwnerName(ownerName: string): Promise<Pick<RegisteredRepository, "id" | "registrationMethod"> | null> {
    const [row] = await this.sql<Pick<RegisteredRepository, "id" | "registrationMethod">[]>`
      select id, registration_method as "registrationMethod"
      from registered_repositories
      where owner_name = ${ownerName} and active = true
      limit 1
    `;
    return row ?? null;
  }

  public async listActiveRepositoryIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select id from registered_repositories where active = true order by id
    `;
    return rows.map((row) => row.id);
  }

  /** The sweep's listing: each active repository beside the sponsor it folds under. */
  public async listActiveRepositorySponsors(): Promise<{ repositoryId: string; sponsorId: string }[]> {
    const rows = await this.sql<{ repositoryId: string; sponsorId: string }[]>`
      select id as "repositoryId", sponsor_id as "sponsorId"
      from registered_repositories
      where active = true
      order by id
    `;
    return rows;
  }

  public async findUsersByGitHubUserIds(githubUserIds: readonly number[]): Promise<FoldUser[]> {
    const normalized = [...new Set(githubUserIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (normalized.length === 0) {
      return [];
    }
    const rows = await this.sql<UserRow[]>`
      select
        users.id,
        users.github_user_id,
        users.github_login,
        users.enforcement_state,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', events.id,
            'priorState', events.prior_state,
            'newState', events.new_state,
            'occurredAt', events.created_at
          ) order by events.created_at, events.id)
          from moderation_events as events
          where events.target_user_id = users.id
        ), '[]'::jsonb) as moderation_events
      from users
      where users.github_user_id = any(${this.sql.array(normalized.map(String))}::bigint[])
    `;
    return rows.map(toFoldUser);
  }

}

function toReconciliationRepository(
  row: RepositoryRow,
  difficultySchemeVersions: DifficultySchemeVersion[],
): ReconciliationRepository {
  return {
    id: row.id,
    githubRepositoryId: toSafeInteger(row.github_repository_id),
    ownerName: row.owner_name,
    active: row.active,
    registeredAt: timestampToIso(row.created_at),
    difficultyScheme: row.difficulty_scheme,
    difficultySchemeVersions,
    provider: row.provider ?? "github",
    instanceUrl: row.instance_url,
    disputePullRequests: row.dispute_pull_requests.map(pr => ({ id: toSafeInteger(pr.id), number: pr.number })),
    sponsor: {
      id: row.sponsor_id,
      githubUserId: toSafeInteger(row.sponsor_github_user_id),
      githubLogin: row.sponsor_github_login,
      enforcementState: row.sponsor_enforcement_state,
      moderationEvents: moderationEventsFromJson(row.sponsor_moderation_events),
    },
  };
}

function toFoldUser(row: UserRow): FoldUser {
  return {
    id: row.id,
    githubUserId: toSafeInteger(row.github_user_id),
    githubLogin: row.github_login,
    enforcementState: row.enforcement_state,
    moderationEvents: moderationEventsFromJson(row.moderation_events),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
