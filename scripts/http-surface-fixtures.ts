import type { AccountDeleteRouteDependencies } from "../src/app/api/account/route.ts";
import type { AccountExportRouteDependencies } from "../src/app/api/account/export/route.ts";
import type {
  ForgeIdentitiesRouteDependencies,
} from "../src/app/api/forge-identities/route.ts";
import type { LabelsRouteDependencies } from "../src/app/api/repositories/labels/route.ts";
import type {
  RepositoryRouteDependencies,
} from "../src/app/api/repositories/route.ts";
import type {
  ForgeIdentityStore,
  ForgeIdentityView,
} from "../src/lib/forge/identities.ts";
import type { AccountExport, AccountExportRow } from "../src/lib/accounts/export.ts";
import { ACCOUNT_EXPORT_FORMAT_VERSION } from "../src/lib/accounts/export.ts";
import type { SqlClient } from "../src/lib/db/types.ts";
import type {
  RegisteredRepository,
  RepositoryRegistrationGateway,
  RepositoryRegistrationStore,
} from "../src/lib/repositories/register.ts";

/**
 * Typed derivation fixtures for the credential/write routes the HTTP surface
 * snapshot pins (issue 912, task 2). Every stub is typed against the route's
 * or flow's real dependency interface — never a module-level singleton — and
 * answers representative typed values: ISO strings for timestamps, uuid-ish
 * strings for ids, nonempty arrays for lists, and one fixed instant
 * (`fixtureNowMs`) so no recorded shape depends on the wall clock.
 *
 * The stubs sit behind the routes' own factories: a derivation invokes
 * `create…Handler(stubs)` and reads the shape off the success Response the
 * real handler logic answers, so the snapshot pins the handler's field
 * names, not the stubs'.
 */

/** Every derivation stub answers as this account. */
export const fixtureMemberId = "00000000-0000-4000-8000-000000000001";

/** A fixed instant the timestamp-bearing stubs derive from — no wall clock in a snapshot. */
export const fixtureNowMs = Date.parse("2026-01-15T12:00:00.000Z");

const fixtureForgeId = "00000000-0000-4000-8000-000000000020";
const fixtureRepositoryRowId = "00000000-0000-4000-8000-000000000011";
const fixtureGithubUserId = 424242;

/** The 32-byte token-cipher key, base64url-encoded, the forge-link stub verifies under. */
const fixtureTokenEncryptionKey = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");

const fixtureForgeIdentityView: ForgeIdentityView = {
  id: fixtureForgeId,
  provider: "gitlab",
  instanceUrl: "https://gitlab.example",
  forgeLogin: "member",
  verifiedAt: new Date(fixtureNowMs).toISOString(),
  tokenFailedAt: null,
};

const fixtureRepository: RegisteredRepository = {
  id: fixtureRepositoryRowId,
  githubRepositoryId: 502130001,
  ownerName: "octo/overflow",
  sponsorId: fixtureMemberId,
  visibility: "PUBLIC",
  githubWebhookId: 987654321,
};

const fixtureGitHubRepository = {
  owner: "octo",
  name: "overflow",
  ownerType: "ORGANIZATION" as const,
  id: 502130001,
  fullName: "octo/overflow",
  visibility: "PUBLIC" as const,
  url: "https://github.com/octo/overflow",
  canAdminister: true,
};

/** Opening and actual labels the registration fixtures submit and the gateway confirms. */
const fixtureRepositoryLabels = new Set([
  "opening:medium",
  ...Array.from({ length: 10 }, (_, index) => `actual:${index + 1}`),
]);

/**
 * The registration/catalog-change body: a valid scheme under
 * validateDifficultyScheme (opening points 1–10, actual labels covering
 * points 1 through 10 exactly once, all label text unique).
 */
export const fixtureRegistrationInput = {
  repositoryUrl: "octo/overflow",
  openingName: "Opening",
  actualName: "Actual",
  openingLabels: [{ label: "opening:medium", comparisonPoints: 5, reservePoints: 4 }],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `actual:${index + 1}`, points: index + 1 })),
};

function fixtureRegistrationGateway(): RepositoryRegistrationGateway {
  return {
    getRepository: async () => fixtureGitHubRepository,
    getRepositoryById: async () => fixtureGitHubRepository,
    listRepositoryLabels: async () => new Set(fixtureRepositoryLabels),
    createWebhook: async () => ({ id: 987654321 }),
    deleteWebhook: async () => undefined,
    listWorkflowFiles: async () => [],
  };
}

function fixtureRegistrationStore(): RepositoryRegistrationStore {
  return {
    findRepositoryByGitHubId: async () => fixtureRepository,
    // "github" passes every flow's cross-forge guard: POST refuses only a
    // non-github holder, PATCH/DELETE demand the row be github-held.
    findRepositoryProviderById: async () => "github",
    createRepository: async () => fixtureRepository,
    appendDifficultySchemeVersion: async () => ({
      changed: true,
      versionNumber: 2,
      effectiveFrom: new Date(fixtureNowMs).toISOString(),
    }),
    findRepositoryRegistrationStateByOwnerName: async () => ({
      repository: fixtureRepository,
      unregisteredAt: null,
    }),
    findRepositoryRegistrationStateByForgeIdentity: async () => null,
    findRepositoryRegistrationState: async () => null,
    unregisterRepository: async () => ({ kind: "UNREGISTERED", repository: fixtureRepository }),
    findGitLabWebhookTargetByOwnerName: async () => null,
    saveAbandonedWebhookCleanup: async () => undefined,
    listAbandonedWebhookCleanups: async () => [],
    clearAbandonedWebhookCleanup: async () => undefined,
  };
}

/** The POST/PATCH/DELETE /api/repositories route's dependencies. */
export function fixtureRepositoryRouteDependencies(): RepositoryRouteDependencies {
  return {
    getSession: async () => ({ user: { id: fixtureMemberId, role: "MEMBER" } }),
    findAccountByTokenHash: async () => null,
    getCurrentRole: async () => "MEMBER",
    createRegistrationDependencies: async () => ({
      actor: { id: fixtureMemberId, role: "MEMBER" },
      github: fixtureRegistrationGateway(),
      store: fixtureRegistrationStore(),
      webhook: { callbackUrl: "https://overflow.example/api/webhooks/github" },
      scheduleInitialImport: async () => undefined,
    }),
  };
}

/** The GET /api/repositories/labels route's dependencies (the GitHub read arm). */
export function fixtureLabelsRouteDependencies(): LabelsRouteDependencies {
  return {
    getSession: async () => ({ user: { id: fixtureMemberId, role: "MEMBER" } }),
    getGitHubAccessToken: async () => "stored-github-oauth-token",
    createGitHubGateway: () => ({
      listRepositoryLabels: async () => new Set(["opening:medium"]),
    }),
    createForgeIdentityStore: () => ({
      getForgeToken: async () => ({
        token: "gitlab-pat",
        identityId: "00000000-0000-4000-8000-000000000012",
      }),
    }),
  };
}

/** The GET/POST/DELETE /api/forge-identities route's dependencies. */
export function fixtureForgeIdentitiesRouteDependencies(): ForgeIdentitiesRouteDependencies {
  const store: ForgeIdentityStore = {
    listForUser: async () => [fixtureForgeIdentityView],
    markTokenRejected: async () => undefined,
    upsertIdentity: async () => fixtureForgeIdentityView,
    deleteForUser: async () => true,
  };
  return {
    getSession: async () => ({ user: { id: fixtureMemberId, role: "MEMBER" } }),
    getCurrentRole: async () => "MEMBER",
    createIdentityStore: () => store,
    tokenEncryptionKey: fixtureTokenEncryptionKey,
    // The verification probe: /user names the forge user, the token's own
    // record carries read_api, so the link verifies without a second probe.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new Request(input, init).url;
      const payload = url.endsWith("/api/v4/personal_access_tokens/self")
        ? { id: 7, name: "overflow", scopes: ["read_api"] }
        : { id: fixtureGithubUserId, username: "member" };
      return new Response(JSON.stringify(payload), { status: 200 });
    }) as typeof fetch,
  };
}

/** The DELETE /api/account route's dependencies (the DELETED outcome path). */
export function fixtureAccountDeleteRouteDependencies(): AccountDeleteRouteDependencies {
  return {
    getSession: async () => ({
      user: { id: fixtureMemberId, authenticatedAt: Math.floor(fixtureNowMs / 1000) },
    }),
    // The route resolves the client before the optional findIdentity override
    // runs; the override is what answers, so the client is never used — an
    // empty object stands in for it.
    getSql: () => ({}) as SqlClient,
    findIdentity: async () => ({ githubUserId: fixtureGithubUserId, githubLogin: "member" }),
    deleteAccount: async () => ({
      kind: "DELETED",
      githubUserId: fixtureGithubUserId,
      accountId: fixtureMemberId,
      alreadyDeleted: false,
      deletedAt: new Date(fixtureNowMs).toISOString(),
      removedApiTokens: 1,
      scrubbedForgeIdentities: 1,
    }),
    endSession: async () => undefined,
    now: () => fixtureNowMs,
  };
}

function fixtureAccountExportDocument(): AccountExport {
  const iso = new Date(fixtureNowMs).toISOString();
  const row = (): AccountExportRow => ({ id: "00000000-0000-4000-8000-000000000030", createdAt: iso });
  return {
    formatVersion: ACCOUNT_EXPORT_FORMAT_VERSION,
    exportedAt: iso,
    account: {
      id: fixtureMemberId,
      githubUserId: fixtureGithubUserId,
      githubLogin: "member",
      avatarUrl: null,
      role: "MEMBER",
      enforcementState: "ACTIVE",
      confirmedMiscalibrationCount: 0,
      createdAt: iso,
      updatedAt: iso,
      deletedAt: null,
      hasStoredGitHubToken: true,
    },
    apiToken: { createdAt: iso, expiresAt: iso, lastUsedAt: null, confirmedAt: null },
    forgeIdentities: [
      {
        id: fixtureForgeId,
        provider: "gitlab",
        instanceUrl: "https://gitlab.example",
        forgeUserId: fixtureGithubUserId,
        forgeLogin: "member",
        verifiedAt: iso,
        tokenFailedAt: null,
        createdAt: iso,
        hasStoredToken: true,
      },
    ],
    sponsoredRepositories: [
      {
        id: fixtureRepositoryRowId,
        ownerName: "octo/overflow",
        provider: "github",
        instanceUrl: null,
        active: true,
        unregisteredAt: null,
        createdAt: iso,
      },
    ],
    settlements: { asCreditor: [row()], asDebtor: [row()] },
    authoredPullRequests: [row()],
    moderationEvents: { asTarget: [row()], asActor: [row()] },
    calibrationAudits: { asAccount: [row()], asReporter: [row()], asModerator: [row()] },
    selfWorkCalibrations: [row()],
    moderatorRoleChanges: { asTarget: [row()], asActor: [row()] },
    settlementOverrideRequests: { asRequester: [row()], asDecider: [row()] },
    reconciliationRuns: { asRequester: [row()], asGraphqlCostSponsor: [row()] },
    repositoryReconciliationUsage: [row()],
    moderationCreditAdjustments: [row()],
    moderationCreditAdjustmentLines: [row()],
  };
}

/** The POST /api/account/export route's dependencies (the download's document). */
export function fixtureAccountExportRouteDependencies(): AccountExportRouteDependencies {
  return {
    getSession: async () => ({ user: { id: fixtureMemberId } }),
    // The route resolves the client before the optional exportAccount override
    // runs; the override is what answers, so the client is never used — an
    // empty object stands in for it.
    getSql: () => ({}) as SqlClient,
    findIdentity: async () => ({ githubUserId: fixtureGithubUserId, githubLogin: "member" }),
    exportAccount: async () => fixtureAccountExportDocument(),
  };
}
