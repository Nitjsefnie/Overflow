import { readEnv } from "@/lib/env";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type { GitHubRepositoryReference } from "@/lib/github/types";

/**
 * The repository size measure: one forge count read per active repository,
 * refreshed by the sweep at most once per measure window, stored per
 * repository, and summed per sponsor as the diff-only backlog.
 *
 * The gateway interface is deliberately narrower than ReconciliationGateway:
 * the forge count reads add one member each and widen nothing every test fake
 * already implements.
 */
export type RepositorySizeGateway = {
  /**
   * The repository's history size: its issues plus pull requests in every
   * state, closed ones included. Resolves null when the measure is
   * unavailable — a repository the forge cannot resolve, or a total it does
   * not answer with — and the caller keeps the previous stored size. A
   * transport or authentication failure throws; the caller counts it the same
   * way.
   */
  getRepositoryHistoryCount(repository: GitHubRepositoryReference): Promise<number | null>;
};

/** Forge read cost, never correctness: an unparsable threshold reads as this default. */
export const DEFAULT_DIFF_ONLY_BACKLOG = 1000;

export function readDiffOnlyBacklogThreshold(environment: Partial<Record<string, string>>): number {
  const raw = environment.RECONCILIATION_DIFF_ONLY_BACKLOG ?? "";
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DIFF_ONLY_BACKLOG;
}

/**
 * The sweep refreshes each repository's measure at most once per window, the
 * same cadence the sweep itself runs at: a row measured within the window is
 * fresh and is skipped.
 */
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
   * The sponsor's diff-only backlog: the sum over the sponsor's ACTIVE
   * repositories of the stored size, an unmeasured repository counting as
   * zero. Resolves null when nothing of the sponsor's has ever been measured;
   * the diff-only decision treats null as zero (under threshold).
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
 * The count query rides the repository's own sponsor's credential, the same
 * rule every other forge read follows, so the composition resolves the
 * credential per repository before the gateway answers. The reference is the
 * registered owner/name path: the measure is advisory (a stale path fails the
 * read and keeps the previous size), and aiming it at the verified numeric
 * identity would cost every fold's identity read per measure.
 *
 * Resolves null — the measure is unavailable and the previous size stands —
 * when the repository row is gone, the GitLab instance is unwired, no linked
 * identity answers for the instance (fail-closed, as the fold's GitLab path
 * is), or the sponsor's GitHub token is gone. Forge failures propagate to the
 * caller.
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
