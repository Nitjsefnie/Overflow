import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { encryptToken } from "@/lib/security/token-cipher";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type { GitHubIssue } from "@/lib/github/types";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 23).toString("base64url");

// The acceptance timeline for issue 180. Closure A's evidence window closes
// before the repository registers, under catalog v1; the sponsor then appends
// v2, repricing one actual label, beginning to govern a day after registration;
// closure B merges later still. On every re-derivation closure A must keep
// resolving at its v1 figure, and v2 must govern only the later closure. The
// append and closure B are timed relative to the registration instant, because
// a real catalog change always begins governing after the version before it.
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

const closureAIssueId = 8_900_101;
const closureBIssueId = 8_900_201;

describe("changing a repository's difficulty catalog", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "catalog_change",
      user: "catalog_change",
      password: "catalog_change",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("keeps a settled figure while a later catalog governs later closures", async () => {
    let externalId = 8_900_000;
    const sponsorGitHubUserId = externalId++;
    const contributorGitHubUserId = externalId++;
    const sponsorLogin = "catalog-sponsor";
    const contributorLogin = "catalog-contributor";
    const sponsorId = await insertUser(sponsorGitHubUserId, sponsorLogin, true);
    await insertUser(contributorGitHubUserId, contributorLogin, false);

    const store = new PostgresRepositoryStore(sql, tokenEncryptionKey);
    const repositoryGitHubId = externalId++;
    const created = await store.createRepository({
      githubRepositoryId: repositoryGitHubId,
      ownerName: `catalog/repo-${repositoryGitHubId}`,
      visibility: "PUBLIC",
      githubWebhookId: externalId++,
      sponsorId,
      difficultyScheme: catalogV1(),
    });
    expect(created).not.toBeNull();
    const repositoryId = created!.id;
    const ownerName = `catalog/repo-${repositoryGitHubId}`;

    // Registration is the instant catalog v1 begins governing, so the append
    // and closure B are timed forward from it, as the real API's now()-based
    // appends always are.
    const [registered] = await sql<{ created_at: Date | string }[]>`
      select created_at from registered_repositories where id = ${repositoryId}
    `;
    const registeredAtMs = new Date(registered!.created_at).getTime();
    const v2EffectiveFrom = new Date(registeredAtMs + DAY_MS);
    const closureB = closureIssue(closureBTimeline(registeredAtMs), ownerName, repositoryGitHubId, contributorGitHubUserId, sponsorLogin, contributorLogin);

    const gateway = (issues: GitHubIssue[]): ReconciliationGateway => ({
      getRepositoryById: verifiedRepository(ownerName),
      getIssue: async () => null,
      getPullRequestClosingIssues: async () => [],
      listIssues: async () => issues,
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "catalog-change diff",
    });

    const foldStore = new PostgresFoldStore(sql, tokenEncryptionKey);
    await foldStore.beginRun(repositoryId);
    const firstSummary = await reconcileRepository(
      { store: foldStore, github: gateway([closureIssue(closureATimeline(), ownerName, repositoryGitHubId, contributorGitHubUserId, sponsorLogin, contributorLogin)]) },
      repositoryId,
    );
    expect(firstSummary.skipped).toBe(false);

    const [settledBefore] = await sql<SettlementReading[]>`
      select s.settled_points, i.settled_label, s.status
      from settlements s
      join issues i on i.id = s.issue_id
      where i.github_issue_id = ${closureAIssueId}
    `;
    expect(settledBefore).toMatchObject({ settled_points: 6, settled_label: "delivered/6", status: "SETTLED" });

    // The sponsor changes the catalog: v2 reprices delivered/6 to seven points
    // and delivered/7 to six. The append sits between the two runs, so an
    // in-place update of the stored catalog — the defect this issue records —
    // would re-price closure A on the second pass.
    const appendResult = await store.appendDifficultySchemeVersion({
      githubRepositoryId: repositoryGitHubId,
      sponsorId,
      scheme: catalogV2(),
      effectiveFrom: v2EffectiveFrom,
    });
    expect(appendResult).toMatchObject({ changed: true, versionNumber: 2 });

    // Second reconciliation: closure A is re-derived from the store's snapshot,
    // so the catalog in force when its evidence window closed must still price
    // it, while closure B — whose window closes after the change — is priced by
    // the catalog then in force.
    await foldStore.beginRun(repositoryId);
    const secondSummary = await reconcileRepository(
      {
        store: foldStore,
        github: gateway([
          closureIssue(closureATimeline(), ownerName, repositoryGitHubId, contributorGitHubUserId, sponsorLogin, contributorLogin),
          closureB,
        ]),
      },
      repositoryId,
    );
    expect(secondSummary.skipped).toBe(false);

    const [settledAfter] = await sql<SettlementReading[]>`
      select s.settled_points, i.settled_label, s.status
      from settlements s
      join issues i on i.id = s.issue_id
      where i.github_issue_id = ${closureAIssueId}
    `;
    expect(settledAfter).toMatchObject({ settled_points: 6, settled_label: "delivered/6", status: "SETTLED" });

    const [settledLater] = await sql<SettlementReading[]>`
      select s.settled_points, i.settled_label, s.status
      from settlements s
      join issues i on i.id = s.issue_id
      where i.github_issue_id = ${closureBIssueId}
    `;
    expect(settledLater).toMatchObject({ settled_points: 7, settled_label: "delivered/6", status: "SETTLED" });

    // The current catalog (what the dashboard reads) is v2, and the version
    // history holds both, in order.
    const [current] = await sql<{ scheme: unknown }[]>`
      select difficulty_scheme as scheme from registered_repositories where id = ${repositoryId}
    `;
    expect(current?.scheme).toEqual(catalogV2());

    const versions = await sql<VersionReading[]>`
      select version_number, scheme, effective_from
      from repository_difficulty_scheme_versions
      where github_repository_id = ${repositoryGitHubId}
      order by version_number
    `;
    expect(versions.map((version) => version.scheme)).toEqual([catalogV1(), catalogV2()]);
    expect(Number(versions[1]?.effective_from)).toBe(v2EffectiveFrom.getTime());
  });
});

type SettlementReading = {
  settled_points: number | string;
  settled_label: string | null;
  status: string;
};

type VersionReading = {
  version_number: number | string;
  scheme: unknown;
  effective_from: Date | string;
};

function verifiedRepository(ownerName: string) {
  const [owner = "", name = ""] = ownerName.split("/");
  return async (githubRepositoryId: number) => ({
    id: githubRepositoryId,
    owner,
    name,
    ownerType: "USER" as const,
    fullName: ownerName,
    visibility: "PUBLIC" as const,
    url: `https://github.com/${ownerName}`,
    canAdminister: true,
  });
}

function catalogV1(): DifficultyScheme {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function catalogV2(): DifficultyScheme {
  const scheme = catalogV1();
  return {
    ...scheme,
    openingLabels: [...scheme.openingLabels, { label: "XL", comparisonPoints: 10, reservePoints: 10 }],
    actualLabels: scheme.actualLabels.map((label) => {
      if (label.label === "delivered/6") return { ...label, points: 7 };
      if (label.label === "delivered/7") return { ...label, points: 6 };
      return label;
    }),
  };
}

async function insertUser(githubUserId: number, githubLogin: string, withToken: boolean): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (
      ${githubUserId},
      ${githubLogin},
      ${withToken ? Buffer.from(encryptToken("catalog-token", tokenEncryptionKey), "utf8") : null}
    )
    returning id
  `;
  return row!.id;
}

// Closure A's evidence window closes before the repository registers, so it
// exercises the pre-registration fallback to the earliest catalog version.
function closureATimeline() {
  return {
    githubIssueId: closureAIssueId,
    issueNumber: 1,
    pullRequestId: 8_900_301,
    pullRequestNumber: 11,
    created: "2026-08-01T09:00:00.000Z",
    openingLabelApplied: "2026-08-01T09:30:00.000Z",
    assigned: "2026-08-01T10:00:00.000Z",
    finalCommit: "2026-08-02T10:00:00.000Z",
    actualLabelApplied: "2026-08-02T10:30:00.000Z",
    rationale: "2026-08-02T11:00:00.000Z",
    merged: "2026-08-02T12:00:00.000Z",
    closed: "2026-08-02T12:05:00.000Z",
    openingLabel: "M",
  };
}

// Closure B merges a day after catalog v2 begins governing, so v2 prices it.
function closureBTimeline(registeredAtMs: number) {
  return {
    githubIssueId: closureBIssueId,
    issueNumber: 2,
    pullRequestId: 8_900_302,
    pullRequestNumber: 12,
    created: iso(registeredAtMs + 2 * DAY_MS),
    openingLabelApplied: iso(registeredAtMs + 2 * DAY_MS + 30 * MINUTE_MS),
    assigned: iso(registeredAtMs + 2 * DAY_MS + 60 * MINUTE_MS),
    finalCommit: iso(registeredAtMs + 3 * DAY_MS),
    actualLabelApplied: iso(registeredAtMs + 3 * DAY_MS + 30 * MINUTE_MS),
    rationale: iso(registeredAtMs + 3 * DAY_MS + 60 * MINUTE_MS),
    merged: iso(registeredAtMs + 3 * DAY_MS + 2 * 60 * MINUTE_MS),
    closed: iso(registeredAtMs + 3 * DAY_MS + 2 * 60 * MINUTE_MS + 5 * MINUTE_MS),
    openingLabel: "S",
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function closureIssue(
  timeline: ReturnType<typeof closureATimeline>,
  ownerName: string,
  repositoryGitHubId: number,
  contributorGitHubUserId: number,
  sponsorLogin: string,
  contributorLogin: string,
): GitHubIssue {
  return {
    id: timeline.githubIssueId,
    number: timeline.issueNumber,
    title: `Catalog closure ${timeline.issueNumber}`,
    body: "Catalog change closure",
    url: `https://github.com/${ownerName}/issues/${timeline.issueNumber}`,
    state: "CLOSED",
    stateReason: "COMPLETED",
    createdAt: timeline.created,
    updatedAt: timeline.closed,
    closedAt: timeline.closed,
    authorLogin: sponsorLogin,
    authorGitHubUserId: null,
    labels: [timeline.openingLabel, "delivered/6"],
    claimAssigneeGitHubLogin: contributorLogin,
    claimAssigneeGitHubUserId: null,
    history: [
      {
        kind: "LABELED",
        id: `opening-${timeline.githubIssueId}`,
        actorLogin: sponsorLogin,
        actorGitHubUserId: null,
        label: timeline.openingLabel,
        createdAt: timeline.openingLabelApplied,
      },
      {
        kind: "ASSIGNED",
        id: `assigned-${timeline.githubIssueId}`,
        actorLogin: sponsorLogin,
        actorGitHubUserId: null,
        assigneeLogin: contributorLogin,
        createdAt: timeline.assigned,
      },
      {
        kind: "LABELED",
        id: `actual-${timeline.githubIssueId}`,
        actorLogin: sponsorLogin,
        actorGitHubUserId: null,
        label: "delivered/6",
        createdAt: timeline.actualLabelApplied,
      },
    ],
    comments: [
      {
        id: `rationale-${timeline.githubIssueId}`,
        databaseId: timeline.githubIssueId + 20_000_000,
        authorLogin: sponsorLogin,
        authorGitHubUserId: null,
        body: "Settled as delivered/6 after reviewing the final diff.",
        createdAt: timeline.rationale,
        lastEditedAt: null,
      },
    ],
    closingPullRequests: [
      {
        id: timeline.pullRequestId,
        number: timeline.pullRequestNumber,
        title: `Catalog closure pull request ${timeline.issueNumber}`,
        body: "Catalog change closure",
        url: `https://github.com/${ownerName}/pull/${timeline.pullRequestNumber}`,
        state: "MERGED",
        mergedAt: timeline.merged,
        mergeCommitOid: timeline.pullRequestId.toString(16).padStart(40, "0"),
        finalCommitAt: timeline.finalCommit,
        authorLogin: contributorLogin,
        authorGitHubUserId: contributorGitHubUserId,
        repositoryGitHubId,
        repositoryNameWithOwner: ownerName,
      },
    ],
  };
}
