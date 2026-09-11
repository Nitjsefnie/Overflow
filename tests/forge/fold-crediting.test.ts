import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimForgeIdentity, claimGitHubIdentity, PostgresFoldStore } from "@/lib/fold/postgres-store";
import { sponsorGateway } from "@/lib/fold/reconcile-as-sponsor";
import { foldRepository, type FoldForgeIdentity, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const TEST_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
const INSTANCE = "https://gitlab.example.com";
const FORGE_USER_ID = 4242;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "forge_crediting_test",
    user: "forge_crediting_test",
    password: "forge_crediting_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

let externalId = 2_000_000;

type Scenario = {
  store: PostgresFoldStore;
  repositoryId: string;
  sponsorId: string;
  linkedUserId: string;
  forgeUserId: number;
  snapshot: RepositoryFoldSnapshot;
};

/**
 * A GitLab repository whose single merged MR is authored by the forge user
 * FORGE_USER_ID, with the linked identity (or not) in the snapshot. The fold
 * fixture mirrors the GitHub one: an issue with settled evidence, a closing
 * MR carrying its diff, and the repository's forge columns set.
 */
async function createGitLabScenario(
  options: { linked?: boolean; instanceUrl?: string } = {},
): Promise<Scenario> {
  const instanceUrl = options.instanceUrl ?? INSTANCE;
  const sponsorGithubId = externalId++;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${sponsorGithubId}, ${`sponsor-${sponsorGithubId}`}) returning id
  `;
  const linkedGithubId = externalId++;
  const [linked] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${linkedGithubId}, ${`linked-${linkedGithubId}`}) returning id
  `;
  const repositoryGithubId = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
      difficulty_scheme, provider, instance_url, forge_project_id
    ) values (
      ${repositoryGithubId}, ${`gitlab-group/repo-${repositoryGithubId}`}, ${sponsor.id}, 'PUBLIC',
      ${externalId++}, ${sql.json(validDifficultyScheme())}, 'gitlab', ${instanceUrl}, ${repositoryGithubId}
    ) returning id
  `;

  const identities: FoldForgeIdentity[] = options.linked === false
    ? []
    : [{
        forgeUserId: FORGE_USER_ID,
        user: {
          id: linked.id,
          githubUserId: linkedGithubId,
          githubLogin: `linked-${linkedGithubId}`,
          enforcementState: "ACTIVE",
        },
      }];

  const githubIssueId = externalId++;
  const githubPullRequestId = externalId++;
  const mergeCommitOid = "b".repeat(40);
  const proofSha256 = repositoryGithubId.toString(16).padStart(64, "0");

  const snapshot: RepositoryFoldSnapshot = {
    repository: {
      id: repository.id,
      githubRepositoryId: repositoryGithubId,
      ownerName: `gitlab-group/repo-${repositoryGithubId}`,
      active: true,
      registeredAt: "2026-09-01T00:00:00.000Z",
      sponsor: {
        id: sponsor.id,
        githubUserId: sponsorGithubId,
        githubLogin: `sponsor-${sponsorGithubId}`,
        enforcementState: "ACTIVE",
      },
      difficultyScheme: validDifficultyScheme(),
      difficultySchemeVersions: [],
      provider: "gitlab",
      instanceUrl,
    },
    users: [],
    forgeIdentities: identities,
    issues: [{
      id: githubIssueId,
      number: 12,
      title: "GitLab fixture",
      body: "",
      url: "https://gitlab.example.test/issue",
      state: "CLOSED",
      stateReason: null,
      updatedAt: "2026-09-11T12:05:00.000Z",
      createdAt: "2026-09-11T08:00:00.000Z",
      closedAt: "2026-09-11T12:00:00.000Z",
      authorLogin: "gitlabber",
      authorGitHubUserId: null,
      labels: ["S", "delivered/6"],
      history: [
        {
          kind: "LABELED" as const,
          id: `opening-${githubIssueId}`,
          actorLogin: `sponsor-${sponsorGithubId}`,
          actorGitHubUserId: sponsorGithubId,
          label: "S",
          createdAt: "2026-09-11T08:10:00.000Z",
        },
        {
          kind: "LABELED" as const,
          id: `actual-${githubIssueId}`,
          actorLogin: `sponsor-${sponsorGithubId}`,
          actorGitHubUserId: sponsorGithubId,
          label: "delivered/6",
          createdAt: "2026-09-11T11:30:00.000Z",
        },
      ],
      comments: [{
        id: `rationale-${githubIssueId}`,
        databaseId: 9001,
        authorLogin: `sponsor-${sponsorGithubId}`,
        authorGitHubUserId: sponsorGithubId,
        body: "delivered/6 — landed within the window.",
        createdAt: "2026-09-11T11:45:00.000Z",
        lastEditedAt: null,
      }],
      closingPullRequests: [{
        id: githubPullRequestId,
        number: 17,
        title: "Fix the ledger",
        body: "",
        url: "https://gitlab.example.test/mr",
        state: "MERGED",
        mergedAt: "2026-09-11T12:00:00.000Z",
        mergeCommitOid,
        finalCommitAt: "2026-09-11T11:45:00.000Z",
        authorLogin: "gitlabber",
        authorGitHubUserId: FORGE_USER_ID,
        repositoryGitHubId: repositoryGithubId,
        repositoryNameWithOwner: `gitlab-group/repo-${repositoryGithubId}`,
        reviews: [],
        rawDiff: `diff --git a/x b/x\n${"x".repeat(64)}`,
      }],
    }],
  };

  return {
    store: new PostgresFoldStore(),
    repositoryId: repository.id,
    sponsorId: sponsor.id,
    linkedUserId: linked.id,
    forgeUserId: FORGE_USER_ID,
    snapshot,
  };
}

function foldOf(scenario: Scenario) {
  return foldRepository(scenario.snapshot);
}

async function publish(scenario: Scenario, fold: ReturnType<typeof foldRepository>) {
  const runId = await scenario.store.beginRun(scenario.repositoryId);
  return scenario.store.withRepositoryReconciliation(scenario.repositoryId, () =>
    scenario.store.materialize({ repositoryId: scenario.repositoryId, runId, fold }));
}

async function settlementRows(repositoryId: string) {
  return sql`
    select status, creditor_id::text as creditor_id, provider, instance_url,
           creditor_github_user_id::text as creditor_github_user_id
    from settlements
    where issue_id in (select id from issues where repository_id = ${repositoryId})
  `;
}

describe("fold crediting by the exact forge triple", () => {
  it("resolves a linked GitLab author and stores the settlement with its forge columns", async () => {
    const scenario = await createGitLabScenario({ linked: true });
    const fold = foldOf(scenario);
    expect(fold.settlements).toHaveLength(1);
    expect(fold.settlements[0]).toMatchObject({
      status: "SETTLED",
      creditorId: scenario.linkedUserId,
      provider: "gitlab",
      instanceUrl: INSTANCE,
    });
    await publish(scenario, fold);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "SETTLED",
        creditor_id: scenario.linkedUserId,
        provider: "gitlab",
        instance_url: INSTANCE,
      }),
    ]);
  });

  it("leaves an unlinked GitLab author UNCLAIMED with the forge id recorded", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    const fold = foldOf(scenario);
    expect(fold.settlements[0]).toMatchObject({
      status: "UNCLAIMED",
      creditorId: null,
      creditorGitHubUserId: FORGE_USER_ID,
      provider: "gitlab",
    });
    await publish(scenario, fold);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_github_user_id: String(FORGE_USER_ID) }),
    ]);
  });

  it("resolves by the triple, not the login: a renamed login still credits", async () => {
    const scenario = await createGitLabScenario({ linked: true });
    scenario.snapshot.forgeIdentities![0]!.user.githubLogin = "renamed-away";
    expect(foldOf(scenario).settlements[0]).toMatchObject({
      status: "SETTLED",
      creditorId: scenario.linkedUserId,
    });
  });

  it("scopes the snapshot's identities to the repository's own instance at the store", async () => {
    // The instance dimension of the triple is enforced where identities are
    // gathered: the store's lookup joins provider AND instance_url, so a
    // forge id linked on one instance is invisible to another instance's
    // repository. Dropping instance_url from that join is the mutant this
    // case kills.
    const scenarioA = await createGitLabScenario({ linked: true });
    const scenarioB = await createGitLabScenario({ linked: false, instanceUrl: "https://other.example.com" });
    // The link flow's row: the identity on instance A, linked to A's contributor.
    await sql`
      insert into user_forge_identities
        (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
      values
        (${scenarioA.linkedUserId}, 'gitlab', ${INSTANCE}, ${FORGE_USER_ID}, 'linked-a', ${"v1.test.envelope"}, now())
    `;
    const store = new PostgresFoldStore();
    const onA = await store.findForgeIdentitiesByForgeUserIds(scenarioA.repositoryId, [FORGE_USER_ID]);
    const onB = await store.findForgeIdentitiesByForgeUserIds(scenarioB.repositoryId, [FORGE_USER_ID]);
    expect(onA).toHaveLength(1);
    expect(onA[0]!.user.id).toBe(scenarioA.linkedUserId);
    expect(onB).toEqual([]);
  });

  it("keeps a GitLab closed issue without a closing MR in the gate, never skipped as not-planned", async () => {
    // Contract item 16: GitLab issues carry no state_reason, so the
    // NOT_PLANNED skip cannot fire for them — a closed issue with no closing
    // MR emits its closure row for a moderator, exactly as GitHub's do.
    const scenario = await createGitLabScenario({ linked: true });
    const issue = scenario.snapshot.issues[0]!;
    (scenario.snapshot.issues[0] as unknown as { closingPullRequests: unknown[] }).closingPullRequests = [];
    const fold = foldOf(scenario);
    expect(fold.issues.map((entry) => entry.githubIssueId)).toContain(issue.id);
    expect(fold.unwritableClosures).toEqual([
      expect.objectContaining({ githubIssueId: issue.id, kind: "NO_CLOSING_PULL_REQUEST" }),
    ]);
  });

  it("never resolves on a login match alone", async () => {
    // The login is display and diagnostics. A snapshot entry whose user
    // carries the MR author's login but a different forge id must not resolve.
    const scenario = await createGitLabScenario({ linked: true });
    scenario.snapshot.forgeIdentities = [{
      forgeUserId: FORGE_USER_ID + 1,
      user: {
        id: scenario.linkedUserId,
        githubUserId: 999,
        githubLogin: "gitlabber",
        enforcementState: "ACTIVE",
      },
    }];
    expect(foldOf(scenario).settlements[0]).toMatchObject({ status: "UNCLAIMED", creditorId: null });
  });

  it("replays moderation history for the participation gate, not the current state", async () => {
    // Banned BEFORE the merge, unbanned after: the at-merge replay sees the
    // ban and leaves the settlement UNCLAIMED; reading the current state
    // would wrongly credit. The projection the store supplies is what makes
    // the replay possible.
    const scenario = await createGitLabScenario({ linked: true, instanceUrl: "https://moderation-491.example.com" });
    const store = new PostgresFoldStore();
    const [actor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (950001, 'moderator-491') returning id
    `;
    await sql`
      insert into user_forge_identities
        (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
      values
        (${scenario.linkedUserId}, 'gitlab', 'https://moderation-491.example.com', ${FORGE_USER_ID}, 'linked-491', ${"v1.test.envelope"}, now())
    `;
    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
      values
        (${scenario.linkedUserId}, ${actor.id}, 'ACTIVE', 'BANNED', 'banned before the merge', '2026-09-11T09:00:00Z'),
        (${scenario.linkedUserId}, ${actor.id}, 'BANNED', 'ACTIVE', 'unbanned after the merge', '2026-09-12T09:00:00Z')
    `;
    const identities = await store.findForgeIdentitiesByForgeUserIds(scenario.repositoryId, [FORGE_USER_ID]);
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user.moderationEvents).toHaveLength(2);
    scenario.snapshot.forgeIdentities = identities;
    // The at-merge replay sees the ban: the author fails the participation
    // gate and the fold emits no settlement for the issue at all.
    expect(foldOf(scenario).settlements).toEqual([]);
  });

  it("does not resolve a GitHub author through a GitLab identity", async () => {
    // Even with a mis-scoped snapshot carrying the identity, a GitHub
    // repository's author never resolves through the forge map — dropping the
    // provider branch is what this case kills.
    const scenario = await createGitLabScenario({ linked: true });
    const githubSnapshot: RepositoryFoldSnapshot = {
      ...scenario.snapshot,
      repository: { ...scenario.snapshot.repository, provider: undefined, instanceUrl: null },
    };
    expect(foldRepository(githubSnapshot).settlements[0]).toMatchObject({
      status: "UNCLAIMED",
      creditorId: null,
    });
  });
});

describe("claimForgeIdentity — linking claims past GitLab work", () => {
  it("flips past UNCLAIMED settlements to SETTLED for the linked triple", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    await publish(scenario, foldOf(scenario));
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED" }),
    ]);

    await claimForgeIdentity(sql, {
      userId: scenario.linkedUserId,
      instanceUrl: INSTANCE,
      forgeUserId: FORGE_USER_ID,
    });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "SETTLED", creditor_id: scenario.linkedUserId }),
    ]);
  });

  it("never claims across instances or forges", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    await publish(scenario, foldOf(scenario));
    // Same forge id, other instance: nothing to claim, nothing to move.
    await claimForgeIdentity(sql, {
      userId: scenario.linkedUserId,
      instanceUrl: "https://other.example.com",
      forgeUserId: FORGE_USER_ID,
    });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);
  });

  it("keeps the participation gate: an ineligible contributor's settlement stays UNCLAIMED", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    await publish(scenario, foldOf(scenario));
    // The linked account is banned, so participation_eligible_at fails at
    // merge time and the claim's own guards leave the settlement untouched.
    await sql`update users set enforcement_state = 'BANNED' where id = ${scenario.linkedUserId}`;
    await claimForgeIdentity(sql, {
      userId: scenario.linkedUserId,
      instanceUrl: INSTANCE,
      forgeUserId: FORGE_USER_ID,
    });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);
  });
});

describe("linking claims past GitLab work (decision 3 retroactivity)", () => {
  it("claims an UNCLAIMED GitLab settlement when the identity is linked", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    await publish(scenario, foldOf(scenario));
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);

    // The link flow's claim: verified triple in, past work flipped.
    await claimForgeIdentity(sql, {
      userId: scenario.linkedUserId,
      instanceUrl: INSTANCE,
      forgeUserId: FORGE_USER_ID,
    });
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({
        status: "SETTLED",
        creditor_id: scenario.linkedUserId,
      }),
    ]);
  });

  it("moves a self-work GitLab settlement into its calibration and deletes the row", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    // Self-work: the debtor IS the linking contributor. Seed a second
    // settlement whose debtor is the linked user, via the same fold publish
    // plus a raw copy with the debtor re-pointed.
    await publish(scenario, foldOf(scenario));
    // Self-work: the debtor IS the linking contributor. The existing row is
    // re-pointed to the contributor as its debtor, keeping its identity.
    await sql`
      update settlements
      set debtor_id = ${scenario.linkedUserId}, creditor_id = null
      where issue_id in (select id from issues where repository_id = ${scenario.repositoryId})
    `;

    await claimForgeIdentity(sql, {
      userId: scenario.linkedUserId,
      instanceUrl: INSTANCE,
      forgeUserId: FORGE_USER_ID,
    });
    // The self-work arm consumes the row: the calibration stands and the
    // settlement row is gone.
    expect(await settlementRows(scenario.repositoryId)).toEqual([]);
    const calibrations = await sql`
      select user_id::text as user_id, actual_points from self_work_calibrations
      where user_id = ${scenario.linkedUserId}
    `;
    expect(calibrations).toEqual([
      expect.objectContaining({ user_id: scenario.linkedUserId, actual_points: 6 }),
    ]);
  });

  it("a GitHub identity claim never touches GitLab settlements", async () => {
    const scenario = await createGitLabScenario({ linked: false });
    await publish(scenario, foldOf(scenario));
    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (960001, 'github-claimer') returning id
    `;
    // A GitHub sign-in whose numeric id collides with the GitLab forge id:
    // without the provider scope this would steal the GitLab settlement.
    await claimGitHubIdentity(sql, contributor.id, FORGE_USER_ID);
    expect(await settlementRows(scenario.repositoryId)).toEqual([
      expect.objectContaining({ status: "UNCLAIMED", creditor_id: null }),
    ]);
  });

  it("a GitLab identity claim never touches GitHub settlements", async () => {
    // A GitHub-shaped settlement (provider 'github', no instance) whose
    // creditor_github_user_id equals the forge id stays untouched.
    const sponsorGithubId = externalId++;
    const [sponsor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${sponsorGithubId}, ${`sponsor-${sponsorGithubId}`}) returning id
    `;
    const contributorGithubId = externalId++;
    const [contributor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${contributorGithubId}, ${`contributor-${contributorGithubId}`}) returning id
    `;
    const repositoryGithubId = externalId++;
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
      ) values (
        ${repositoryGithubId}, ${`octo/repo-${repositoryGithubId}`}, ${sponsor.id}, 'PUBLIC',
        ${externalId++}, ${sql.json(validDifficultyScheme())}
      ) returning id
    `;
    const githubIssueId = externalId++;
    const githubPullRequestId = externalId++;
    await sql`
      insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state, owner_github_login, opening_label, opening_comparison_points, opening_reserve_points, opening_source_event_id, opening_source_actor_login, opening_source_at)
      values (${githubIssueId}, ${repository.id}, 1, 't', '', 'u', 'CLOSED', ${`sponsor-${sponsorGithubId}`}, 'S', 2, 2, ${`opening-${githubIssueId}`}, ${`sponsor-${sponsorGithubId}`}, '2026-09-11T08:00:00Z')
    `;
    await sql`
      insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, author_id, author_github_login, author_github_user_id, state, merged_at, merge_commit_oid, final_commit_at, proof_sha256)
      values (${githubPullRequestId}, ${repository.id}, (select id from issues where github_issue_id = ${githubIssueId}), 11, 'u', 't', '', null, 'contributor', ${contributorGithubId}, 'MERGED', '2026-09-11T12:00:00Z', ${"f".repeat(40)}, '2026-09-11T11:00:00Z', ${"a".repeat(64)})
    `;
    // 003 re-pointed the settlements FK at the pull_request_issues bridge, so
    // the raw seed writes its bridge row exactly as the fold's link step does.
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      select pull_requests.id, issues.id, repositories.id
      from pull_requests, issues, registered_repositories as repositories
      where pull_requests.github_pull_request_id = ${githubPullRequestId}
        and issues.github_issue_id = ${githubIssueId}
        and repositories.github_repository_id = ${repositoryGithubId}
    `;
    await sql`
      insert into settlements (pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id, opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, fold_revision, provider, instance_url)
      values (
        (select id from pull_requests where github_pull_request_id = ${githubPullRequestId}),
        (select id from issues where github_issue_id = ${githubIssueId}),
        null, 'contributor', ${contributorGithubId}, ${sponsor.id}, 2, 6, 0, 6, ${"b".repeat(64)}, 'UNCLAIMED', 3,
        'github', null
      )
    `;
    const [seeded] = await sql<{ id: string; status: string }[]>`
      select status from settlements
      where provider = 'github' and creditor_github_user_id = ${contributorGithubId}
    `;
    expect(seeded).toMatchObject({ status: "UNCLAIMED" });

    await claimForgeIdentity(sql, {
      userId: contributor.id,
      instanceUrl: INSTANCE,
      forgeUserId: contributorGithubId,
    });
    // The GitLab claim matches only provider 'gitlab' rows on its instance:
    // the GitHub settlement's provider/instance never match.
    const [after] = await sql<{ status: string; creditor_id: string | null }[]>`
      select status, creditor_id::text as creditor_id from settlements
      where provider = 'github' and creditor_github_user_id = ${contributorGithubId}
    `;
    expect(after).toEqual({ status: "UNCLAIMED", creditor_id: null });
  });
});

describe("sponsor gateway resolution", () => {
  type RepoRow = RepositoryFoldSnapshot["repository"];

  function repositoryRow(overrides: Partial<RepoRow> = {}): RepoRow {
    return {
      id: "repo-1",
      githubRepositoryId: 1,
      ownerName: "g/p",
      active: true,
      registeredAt: "2026-09-01T00:00:00.000Z",
      sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "s", enforcementState: "ACTIVE" },
      difficultyScheme: validDifficultyScheme(),
      difficultySchemeVersions: [],
      provider: "gitlab",
      instanceUrl: INSTANCE,
      ...overrides,
    };
  }

  function storeFor(row: RepoRow, credentialReads: string[] = []): Parameters<typeof sponsorGateway>[0] {
    return {
      async getRepository() {
        return row;
      },
      async getGitHubAccessToken(sponsorId: string) {
        credentialReads.push(sponsorId);
        return `gho-${sponsorId}`;
      },
    } as unknown as Parameters<typeof sponsorGateway>[0];
  }

  it("fails closed for a GitLab repository when no resolver is wired", async () => {
    let githubFactoryRan = false;
    const gateway = sponsorGateway(
      storeFor(repositoryRow()),
      "repo-1",
      () => {
        githubFactoryRan = true;
        throw new Error("factory ran");
      },
    );
    await expect(gateway.listIssues({ owner: "g", name: "p" })).rejects.toThrow(/fail-closed/);
    expect(githubFactoryRan).toBe(false);
  });

  it("fails closed when no verified identity is linked, before any credential read", async () => {
    const credentialReads: string[] = [];
    const gateway = sponsorGateway(
      storeFor(repositoryRow(), credentialReads),
      "repo-1",
      () => {
        throw new Error("factory ran");
      },
      async () => null,
    );
    await expect(gateway.listIssues({ owner: "g", name: "p" })).rejects.toThrow(/No verified GitLab identity/);
    expect(credentialReads).toEqual([]);
  });

  it("resolves GitHub repositories through the injected factory, exactly as before", async () => {
    const credentialReads: string[] = [];
    const gateway = sponsorGateway(
      storeFor(repositoryRow({ provider: "github", instanceUrl: null }), credentialReads),
      "repo-2",
      (accessToken: string) => {
        throw new Error(`factory ran with ${accessToken}`);
      },
    );
    await expect(gateway.listIssues({ owner: "o", name: "r" })).rejects.toThrow("factory ran with gho-sponsor-1");
    expect(credentialReads).toEqual(["sponsor-1"]);
  });
});
