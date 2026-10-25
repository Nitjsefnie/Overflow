import { readEnv } from "@/lib/env";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type { GitHubRepositoryReference } from "@/lib/github/types";

/** The forge count reads: narrower than ReconciliationGateway, so no fake widens. */
export type RepositorySizeGateway = {
  /**
   * The repository's issues plus pull requests in every state, closed ones
   * included. Null means the measure is unavailable and the caller keeps the
   * previous stored size; a transport or authentication failure throws.
   */
  getRepositoryHistoryCount(repository: GitHubRepositoryReference): Promise<number | null>;
};

/** An unparsable threshold reads as this default. */
export const DEFAULT_DIFF_ONLY_BACKLOG = 1000;

export function readDiffOnlyBacklogThreshold(environment: Partial<Record<string, string>>): number {
  const raw = environment.RECONCILIATION_DIFF_ONLY_BACKLOG ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DIFF_ONLY_BACKLOG;
}

/** A row measured within this window is fresh and the sweep skips it. */
export const REPOSITORY_SIZE_REMEASURE_MS = 6 * 60 * 60 * 1000;

export type RepositorySizeRow = {
  totalCount: number;
  measuredAt: Date;
};

export class PostgresRepositorySizeStore {
  public constructor(private readonly connection?: SqlClient) {}
  private get sql(): SqlClient { return this.connection ?? getSql(); }

  /** The stored measure, or null when the repository has never been measured. */
  public async get(repositoryId: string): Promise<RepositorySizeRow | null> {
    const [row] = await this.sql<{ total_count: number; measured_at: Date }[]>`
      select total_count, measured_at from repository_reconciliation_sizes
      where repository_id = ${repositoryId}`;
    return row === undefined ? null : { totalCount: row.total_count, measuredAt: row.measured_at };
  }

  public async store(repositoryId: string, totalCount: number, measuredAt: Date): Promise<void> {
    await this.sql`insert into repository_reconciliation_sizes (repository_id, total_count, measured_at)
      values (${repositoryId}, ${totalCount}, ${measuredAt})
      on conflict (repository_id) do update
      set total_count = excluded.total_count, measured_at = excluded.measured_at`;
  }

  /**
   * The sum over the sponsor's ACTIVE repositories, an unmeasured repository
   * counting as zero. Null when nothing of the sponsor's was ever measured;
   * the diff-only decision treats null as zero.
   */
  public async getSponsorBacklog(sponsorId: string): Promise<number | null> {
    const [row] = await this.sql<{ backlog: number | null }[]>`
      select sum(sizes.total_count)::int as backlog
      from repository_reconciliation_sizes as sizes
      join registered_repositories as repositories on repositories.id = sizes.repository_id
      where repositories.sponsor_id = ${sponsorId} and repositories.active`;
    return row === undefined ? null : row.backlog;
  }
}

/** The pieces of the fold repository snapshot a measure needs. */
export type RepositorySizeMeasureRepository = {
  ownerName: string;
  provider?: string | undefined;
  instanceUrl?: string | null | undefined;
  sponsor: { id: string };
};

export type RepositorySizeMeasureDependencies = {
  getRepository(repositoryId: string): Promise<RepositorySizeMeasureRepository | null>;
  getGitHubAccessToken(userId: string): Promise<string | null>;
  resolveForgeToken(userId: string, instanceUrl: string): Promise<{ token: string; identityId: string } | null>;
};

/**
 * The count read rides the repository's own sponsor's credential, resolved
 * per repository; the reference is the registered owner/name path, whose
 * staleness costs a failed read and keeps the previous size. Null — measure
 * unavailable, previous size stands — when the row is gone, the GitLab
 * instance is unwired, no linked identity answers for it (fail-closed), or
 * the GitHub token is gone. Forge failures propagate.
 */
export function measureRepositorySize(
  dependencies: RepositorySizeMeasureDependencies,
  createGateway: (
    input: { provider: "github"; accessToken: string; ownerId: string }
    | { provider: "gitlab"; instanceUrl: string; token: string },
  ) => RepositorySizeGateway,
): (repositoryId: string) => Promise<number | null> {
  return async (repositoryId) => {
    const repository = await dependencies.getRepository(repositoryId);
    if (repository === null) return null;
    const separator = repository.ownerName.lastIndexOf("/");
    if (separator <= 0 || separator === repository.ownerName.length - 1) return null;
    const reference: GitHubRepositoryReference = {
      owner: repository.ownerName.slice(0, separator),
      name: repository.ownerName.slice(separator + 1),
    };
    if (repository.provider === "gitlab") {
      const instanceUrl = repository.instanceUrl;
      if (instanceUrl === null || instanceUrl === undefined) return null;
      const credential = await dependencies.resolveForgeToken(repository.sponsor.id, instanceUrl);
      if (credential === null) return null;
      return createGateway({ provider: "gitlab", instanceUrl, token: credential.token })
        .getRepositoryHistoryCount(reference);
    }
    const accessToken = await dependencies.getGitHubAccessToken(repository.sponsor.id);
    if (accessToken === null) return null;
    return createGateway({ provider: "github", accessToken, ownerId: repository.sponsor.id })
      .getRepositoryHistoryCount(reference);
  };
}
