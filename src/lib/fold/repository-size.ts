import { readEnv } from "@/lib/env";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type { GitHubRepositoryReference } from "@/lib/github/types";

/** The forge count reads: narrower than ReconciliationGateway, so no fake widens. */
export type RepositorySizeGateway = {
  /** Every-state totals; null keeps the previous stored size; failures throw. */
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

  /** Active repositories only; unmeasured counts zero; null when nothing measured. */
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
  githubRepositoryId: number;
  provider?: string | undefined;
  instanceUrl?: string | null | undefined;
  sponsor: { id: string };
};

export type RepositorySizeMeasureDependencies = {
  getRepository(repositoryId: string): Promise<RepositorySizeMeasureRepository | null>;
  getGitHubAccessToken(userId: string): Promise<string | null>;
  resolveForgeToken(userId: string, instanceUrl: string): Promise<{ token: string; identityId: string } | null>;
};

export type SponsorGatewayInput =
  | { provider: "github"; accessToken: string; ownerId: string }
  | { provider: "gitlab"; instanceUrl: string; token: string };

/** Null on a 404 only. */
export type RepositoryLookupGateway = {
  getRepositoryById(forgeRepositoryId: number): Promise<object | null>;
};

/**
 * Rides the repository's own sponsor's credential, aimed by the registered
 * owner/name path. Null keeps the previous size; forge failures propagate.
 */
export function measureRepositorySize(
  dependencies: RepositorySizeMeasureDependencies,
  createGateway: (input: SponsorGatewayInput) => RepositorySizeGateway,
): (repositoryId: string) => Promise<number | null> {
  return async (repositoryId) => {
    const target = await resolveSponsorGateway(dependencies, repositoryId);
    return target === null ? null : createGateway(target.input).getRepositoryHistoryCount(target.reference);
  };
}

/**
 * Gone only when the by-id lookup on the measure's credential answers 404: a
 * rename also misses by name. No lookup, so not gone, where the measure has none.
 */
export function findRepositoryGone(
  dependencies: RepositorySizeMeasureDependencies,
  createGateway: (input: SponsorGatewayInput) => RepositoryLookupGateway,
): (repositoryId: string) => Promise<boolean> {
  return async (repositoryId) => {
    const target = await resolveSponsorGateway(dependencies, repositoryId);
    return target !== null && isStoredPath(target.repository)
      && await createGateway(target.input).getRepositoryById(target.repository.githubRepositoryId) === null;
  };
}

// Stricter than the measure's last-slash split, which stays as it was: GitHub
// is exactly owner/name, GitLab a namespace path of any depth.
function isStoredPath({ ownerName, provider }: RepositorySizeMeasureRepository): boolean {
  const segments = ownerName.split("/");
  return !segments.includes("") && (provider === "gitlab" ? segments.length >= 2 : segments.length === 2);
}

async function resolveSponsorGateway(
  dependencies: RepositorySizeMeasureDependencies,
  repositoryId: string,
): Promise<{ repository: RepositorySizeMeasureRepository; reference: GitHubRepositoryReference; input: SponsorGatewayInput } | null> {
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
    return { repository, reference, input: { provider: "gitlab", instanceUrl, token: credential.token } };
  }
  const accessToken = await dependencies.getGitHubAccessToken(repository.sponsor.id);
  if (accessToken === null) return null;
  return { repository, reference, input: { provider: "github", accessToken, ownerId: repository.sponsor.id } };
}
