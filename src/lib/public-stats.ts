import { readNumber, resolveSql, type DashboardQueryDependencies } from "@/lib/dashboard/queries";
import type { RegistrationAttemptKind, RegistrationRefusalKind } from "@/lib/stats/registration-attempts";

export type SettledWorkStats = {
  pullRequests: number;
  contributors: number;
  points: number;
  readAt: Date;
};

/** How long a reading is reused; the stats page states this same number to visitors. */
export const SETTLED_WORK_REFRESH_MINUTES = 10;

export function createSettledWorkReader(
  dependencies: Pick<DashboardQueryDependencies, "sql"> & { now?: () => number } = {},
) {
  const now = dependencies.now ?? Date.now;
  let cached: SettledWorkStats | undefined;
  let inFlight: Promise<SettledWorkStats> | undefined;
  return async () => {
    if (inFlight !== undefined) return inFlight;
    if (cached !== undefined && now() - cached.readAt.getTime() < SETTLED_WORK_REFRESH_MINUTES * 60 * 1000) return cached;
    inFlight = (async () => {
      const sql = resolveSql(dependencies);
      const [row] = await sql<{ pull_requests: string; contributors: string; points: string }[]>`
        select count(distinct settlements.pull_request_id) as pull_requests,
          count(distinct settlements.creditor_id) as contributors,
          coalesce(sum(settlements.credits), 0) as points
        from settlements
        where settlements.status = 'SETTLED'
      `;
      const result = {
        pullRequests: readNumber(row.pull_requests, "Settled pull requests"),
        contributors: readNumber(row.contributors, "Settled contributors"),
        points: readNumber(row.points, "Settled points"),
        readAt: new Date(now()),
      };
      cached = result;
      return result;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

export const getSettledWorkStats = createSettledWorkReader();

export const REGISTRATION_REFUSAL_LABELS: Record<RegistrationRefusalKind, string> = {
  MISSING_CATALOG_LABELS: "Missing catalog labels",
  WEBHOOK_SCOPE_MISSING: "Token without webhook administration",
  NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED: "Not an administrator, or App not installed",
  NOT_PUBLIC: "Repository not public",
  ALREADY_REGISTERED: "Already registered",
  OTHER: "Other",
};

export type OwnerProgressStats = {
  registrationStarts: number;
  repositories: number;
  githubRepositories: number;
  gitlabRepositories: number;
  listedIssue: number;
  contributorReviewed: number;
  listedSecondIssue: number;
  refusedAttempts: Record<RegistrationRefusalKind, number>;
};

export function createOwnerProgressReader(
  dependencies: Pick<DashboardQueryDependencies, "sql"> & { now?: () => number } = {},
) {
  const now = dependencies.now ?? Date.now;
  let cached: OwnerProgressStats | undefined;
  let cachedAt = 0;
  let inFlight: Promise<OwnerProgressStats> | undefined;
  return async () => {
    if (inFlight !== undefined) return inFlight;
    if (cached !== undefined && now() - cachedAt < SETTLED_WORK_REFRESH_MINUTES * 60 * 1000) return cached;
    inFlight = (async () => {
      const sql = resolveSql(dependencies);
      const [row] = await sql<{
        repositories: string; github_repositories: string; gitlab_repositories: string;
        listed_issue: string; contributor_reviewed: string; listed_second_issue: string;
        attempts: Partial<Record<RegistrationAttemptKind, string>>;
      }[]>`
        select count(*) as repositories,
          count(*) filter (where provider = 'github') as github_repositories,
          count(*) filter (where provider = 'gitlab') as gitlab_repositories,
          count(*) filter (where first_listed_issue_id is not null) as listed_issue,
          count(*) filter (where contributor_review_received) as contributor_reviewed,
          count(*) filter (where second_issue_listed) as listed_second_issue,
          (select coalesce(json_object_agg(kind, total), '{}'::json)
           from (select kind, sum(attempts)::text as total from registration_attempt_counts group by kind) counts) as attempts
        from registered_repositories
      `;
      const kinds = Object.keys(REGISTRATION_REFUSAL_LABELS) as RegistrationRefusalKind[];
      const refusedAttempts = Object.fromEntries(kinds.map((kind) =>
        [kind, readNumber(row.attempts[kind] ?? 0, `Refused registration attempts: ${kind}`)])) as Record<RegistrationRefusalKind, number>;
      const result = {
        registrationStarts: readNumber(row.attempts.REGISTRATION_START ?? 0, "Registration starts"),
        repositories: readNumber(row.repositories, "Registered repositories"),
        githubRepositories: readNumber(row.github_repositories, "GitHub repositories"),
        gitlabRepositories: readNumber(row.gitlab_repositories, "GitLab repositories"),
        listedIssue: readNumber(row.listed_issue, "Repositories with a listed issue"),
        contributorReviewed: readNumber(row.contributor_reviewed, "Repositories with a reviewed contributor pull request"),
        listedSecondIssue: readNumber(row.listed_second_issue, "Repositories with a second listed issue"),
        refusedAttempts,
      };
      cached = result;
      cachedAt = now();
      return result;
    })();
    try {
      return await inFlight;
    } finally {
      inFlight = undefined;
    }
  };
}

export const getOwnerProgressStats = createOwnerProgressReader();
