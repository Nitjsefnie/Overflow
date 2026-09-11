import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimForgeIdentity, PostgresFoldStore } from "@/lib/fold/postgres-store";
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
