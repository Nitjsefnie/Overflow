import type { Sql } from "postgres";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { validDifficultyScheme } from "./difficulty-scheme";

/**
 * One registered repository holding exactly one row in each derived table: a
 * settlement, a self-work calibration and an unwritable closure, each on its own
 * issue, all written through the real materializer so every row carries the
 * revision stamp a fold would have given it.
 *
 * Shared because more than one suite needs derived rows whose provenance is the
 * materializer's rather than a hand-written insert's. Every external identifier
 * is drawn from one counter, so repeated calls against the same database do not
 * collide on the unique GitHub ids.
 */
let externalId = 1_000_000;

export async function materializeRepositoryFixture(sql: Sql) {
  const sponsorGitHubId = externalId++;
  const contributorGitHubId = externalId++;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${sponsorGitHubId}, ${`sponsor-${sponsorGitHubId}`}) returning id
  `;
  const [contributor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${contributorGitHubId}, ${`contributor-${contributorGitHubId}`}) returning id
  `;
  const repositoryGitHubId = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${repositoryGitHubId}, ${`owner/repo-${repositoryGitHubId}`}, ${sponsor.id}, 'PUBLIC',
      ${externalId++}, ${sql.json(validDifficultyScheme())}
    ) returning id
  `;
  const issueIds = [externalId++, externalId++, externalId++];
  const pullRequestIds = [externalId++, externalId++];
  const mergedAt = "2026-09-01T12:00:00.000Z";
  const mergeCommitOid = "a".repeat(40);
  const proofSha256 = repositoryGitHubId.toString(16).padStart(64, "0");
  const settledEvidence = {
    settledLabel: "delivered/6", settledPoints: 6,
    settledLabelEventId: "actual", settledLabelActorLogin: `sponsor-${sponsorGitHubId}`,
    settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
    settledRationaleCommentId: "rationale", settledRationaleActorLogin: `sponsor-${sponsorGitHubId}`,
    settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
  };
  // A literal materializer input keeps this suite focused on storing the fold's
  // output. Each derived kind has its own issue, as it would in a real fold.
  const fold: FoldResult = {
    issues: issueIds.map((githubIssueId, index) => ({
      githubIssueId, number: index + 1, title: "Revision fixture", body: "", url: "https://example.test/issue",
      state: "CLOSED", openingLabel: "M", openingComparisonPoints: 5, openingReservePoints: 5,
      ownerGitHubLogin: `sponsor-${sponsorGitHubId}`, openingSourceEventId: `opening-${githubIssueId}`,
      openingSourceActorLogin: `sponsor-${sponsorGitHubId}`, openingSourceAt: "2026-09-01T08:00:00.000Z",
      claimAssigneeGitHubLogin: null, ...settledEvidence,
    })),
    pullRequests: pullRequestIds.map((githubPullRequestId, index) => ({
      githubPullRequestId, number: index + 11, title: "Revision fixture", body: "", url: "https://example.test/pr",
      state: "MERGED", mergedAt, mergeCommitOid, finalCommitAt: "2026-09-01T10:00:00.000Z",
      authorId: index === 0 ? contributor.id : sponsor.id,
      authorGitHubLogin: index === 0 ? `contributor-${contributorGitHubId}` : `sponsor-${sponsorGitHubId}`,
      authorGitHubUserId: index === 0 ? contributorGitHubId : sponsorGitHubId,
      proofSha256, githubIssueIds: [issueIds[index]], reviewRounds: [],
    })),
    settlements: [{
      githubIssueId: issueIds[0], githubPullRequestId: pullRequestIds[0], creditorId: contributor.id,
      creditorGitHubLogin: `contributor-${contributorGitHubId}`, creditorGitHubUserId: contributorGitHubId,
      debtorId: sponsor.id, openingComparisonPoints: 5, ...settledEvidence,
      mergeCommitOid, mergedAt, reviewRounds: 0, credits: 6, proofSha256, status: "SETTLED",
    }],
    selfWorkCalibrations: [{
      githubIssueId: issueIds[1], githubPullRequestId: pullRequestIds[1], userId: sponsor.id,
      openingComparisonPoints: 5, actualLabel: settledEvidence.settledLabel, actualPoints: 6,
      actualLabelEventId: settledEvidence.settledLabelEventId,
      actualLabelActorLogin: settledEvidence.settledLabelActorLogin,
      actualLabelAppliedAt: settledEvidence.settledLabelAppliedAt,
      rationaleCommentId: settledEvidence.settledRationaleCommentId,
      rationaleActorLogin: settledEvidence.settledRationaleActorLogin,
      rationaleCommentedAt: settledEvidence.settledRationaleCommentedAt, mergeCommitOid, mergedAt,
    }],
    unwritableClosures: [{
      githubIssueId: issueIds[2], githubPullRequestId: null, kind: "NO_CLOSING_PULL_REQUEST",
      reason: "No closing pull request.",
    }],
    policyViolations: [], ledgerEntries: [],
  };
  const store = new PostgresFoldStore(sql);
  const repositoryId = repository.id;
  const runId = await store.beginRun(repositoryId);
  const deltas = await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold }));
  return { repositoryId, store, fold, runId, deltas };
}
