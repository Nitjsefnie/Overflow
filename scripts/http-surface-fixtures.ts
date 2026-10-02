import type { AccountDeleteRouteDependencies } from "../src/app/api/account/route.ts";
import type { AccountExportRouteDependencies } from "../src/app/api/account/export/route.ts";
import type {
  ModerationCreditRouteDependencies,
  ModerationRouteDependencies,
} from "../src/app/api/moderation/route.ts";
import type { ModerationAuditsRouteDependencies } from "../src/app/api/moderation/audits/route.ts";
import type { ModerationUnwritableClosuresRouteDependencies } from "../src/app/api/moderation/unwritable-closures/route.ts";
import type {
  RederivationRouteDependencies,
  RederivationRouteService,
} from "../src/app/api/moderation/rederivation/route.ts";
import type {
  ModeratorRouteDependencies,
  ModeratorRouteService,
} from "../src/app/api/moderation/moderators/route.ts";
import type {
  SettlementOverrideDecisionDependencies,
} from "../src/app/api/overrides/[id]/route.ts";
import type {
  SettlementOverrideListRouteDependencies,
  SettlementOverrideRouteDependencies,
} from "../src/app/api/overrides/route.ts";
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
import type {
  CalibrationCohortSnapshot,
  CalibrationComparison,
  CalibrationPair,
} from "../src/lib/calibration/statistics.ts";
import type { SqlClient } from "../src/lib/db/types.ts";
import type {
  OpenAuditProjection,
  UnwritableClosureProjection,
} from "../src/lib/dashboard/queries.ts";
import type {
  OutstandingRederivationRequest,
  RederivationOverview,
} from "../src/lib/moderation/rederivation-service.ts";
import type {
  AccountAudit,
  CalibrationCohortPreview,
  ModeratorRoleChange,
  ModeratorSummary,
  RecalibrationClosure,
} from "../src/lib/moderation/service.ts";
import type {
  OpenSettlementOverrideRequest,
  SettlementOverrideEvidence,
  SettlementOverrideRequest,
} from "../src/lib/overrides/service.ts";
import type {
  RegisteredRepository,
  RepositoryRegistrationGateway,
  RepositoryRegistrationStore,
} from "../src/lib/repositories/register.ts";

/**
 * Typed derivation fixtures for the routes the HTTP surface snapshot pins
 * (issue 912). Every stub is typed against the route's or flow's real
 * dependency interface — never a module-level singleton — and answers
 * representative typed values: ISO strings for timestamps, uuid-ish strings
 * for ids, nonempty arrays for lists, and one fixed instant (`fixtureNowMs`)
 * so no recorded shape depends on the wall clock.
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

// ---------------------------------------------------------------------------
// The moderation and override routes (issue 912, task 3). The moderator gate
// (requiredModeratorSession) re-reads the role from the injected
// getCurrentRole, so every moderation stub answers MODERATOR there — a
// MEMBER answer is answered 403 before any handler logic runs.
// ---------------------------------------------------------------------------

/** The account every audit, closure and correction fixture is about. */
export const fixtureTargetId = "00000000-0000-4000-8000-000000000040";
/** The audit id the PATCH /api/moderation/<id> derivation names in its path. */
export const fixtureAuditId = "00000000-0000-4000-8000-000000000041";
const fixtureSettlementRowId = "00000000-0000-4000-8000-000000000042";
/** The override request id the PATCH /api/overrides/<id> derivation names. */
export const fixtureOverrideRequestId = "00000000-0000-4000-8000-000000000043";
const fixtureAdjustmentId = "00000000-0000-4000-8000-000000000044";
const fixtureCreditLineSettlementId = "00000000-0000-4000-8000-000000000045";

/** The fixed instant every moderation timestamp derives from. */
const fixtureIso = new Date(fixtureNowMs).toISOString();

/**
 * The calibration comparison the moderation fixtures serve: twelve self-work
 * pairs settling 0.75 above their opening against ten outsider settlements 0.9
 * below theirs, so the difference between the means is +1.65 — the
 * under-credited-outsiders case the recalibration figure acts on. The sums and
 * figure below carry the same arithmetic: gapPerPair 1.65, totalAmount 17
 * (16.5 rounded half away from zero).
 */
const fixtureComparison: CalibrationComparison = {
  selfWork: { count: 12, meanDelta: 0.75, medianDelta: 1 },
  outsider: { count: 10, meanDelta: -0.9, medianDelta: -1 },
  differenceBetweenMeans: 1.65,
};

const fixtureCalibrationPair: CalibrationPair = {
  githubRepositoryId: 502130001,
  githubIssueId: 293100003,
  githubPullRequestId: 293200003,
  mergedAt: fixtureIso,
  proofSha256: "e".repeat(64),
  offeredDifficulty: 5,
  settledDifficulty: 6,
};

/** The stored cohort snapshot a SUBSTANTIATED audit carries. */
const fixtureCohortSnapshot: CalibrationCohortSnapshot = {
  targetAccountId: fixtureTargetId,
  repositoryId: null,
  sampleStartedAt: fixtureIso,
  sampleEndedAt: fixtureIso,
  selfWorkPairs: [fixtureCalibrationPair],
  outsiderSettlementPairs: [fixtureCalibrationPair],
  comparison: fixtureComparison,
};

const fixtureAccountAudit: AccountAudit = {
  id: fixtureAuditId,
  targetAccountId: fixtureTargetId,
  repositoryId: null,
  state: "OPEN",
  // Opening an audit on a participation-eligible account moves it ACTIVE -> UNDER_AUDIT.
  priorState: "ACTIVE",
  targetState: "UNDER_AUDIT",
  confirmedPatternCount: 12,
  cohort: fixtureCohortSnapshot,
};

const fixtureCohortPreview: CalibrationCohortPreview = {
  targetAccountId: fixtureTargetId,
  repositoryId: null,
  sampleStartedAt: fixtureIso,
  sampleEndedAt: fixtureIso,
  comparison: fixtureComparison,
  meetsMinimumSampleSize: true,
};

const fixtureRecalibrationClosure: RecalibrationClosure = {
  targetAccountId: fixtureTargetId,
  priorState: "RECALIBRATING",
  targetState: "ACTIVE",
  confirmedPatternCount: 12,
  reactivatedRepositoryCount: 3,
};

const fixtureCreditAdjustmentLines = [
  { settlementId: fixtureCreditLineSettlementId, creditorId: fixtureMemberId, amount: 17 },
];

/** The applied adjustment: its lines mirror the figure the snapshot supports. */
const fixtureCreditAdjustment = {
  id: fixtureAdjustmentId,
  moderationEventId: "00000000-0000-4000-8000-000000000046",
  calibrationAuditId: fixtureAuditId,
  targetAccountId: fixtureTargetId,
  gapPerPair: 1.65,
  pairCount: 10,
  totalAmount: 17,
  reversalOf: null,
  reason: "Compensating the under-credited outsiders.",
  createdAt: fixtureIso,
  lines: fixtureCreditAdjustmentLines,
};

/** The mirroring adjustment a reversal answers: negative lines naming the original. */
const fixtureCreditReversal = {
  ...fixtureCreditAdjustment,
  id: "00000000-0000-4000-8000-000000000047",
  reversalOf: fixtureAdjustmentId,
  reason: "The adjustment mispriced the cohort.",
  lines: [{ settlementId: fixtureCreditLineSettlementId, creditorId: fixtureMemberId, amount: -17 }],
};

const fixtureRecalibrationCreditPreview = {
  audit: { id: fixtureAuditId, decidedAt: fixtureIso },
  actionability: { actionable: true, reason: "SELF_WORK_UNDERCREDITED_OUTSIDERS" as const },
  totals: { selfSum: 9, selfCount: 12, outSum: -9, outCount: 10 },
  figure: { gapPerPair: 1.65, pairCount: 10, totalAmount: 17 },
  lines: fixtureCreditAdjustmentLines,
  adjustments: [fixtureCreditAdjustment],
};

const fixtureOpenAudit: OpenAuditProjection = {
  id: fixtureAuditId,
  targetAccountId: fixtureTargetId,
  targetLogin: "target",
  reporterLogin: "reporter",
  repositoryName: "octo/overflow",
  openedAt: fixtureIso,
  settledSampleSize: 12,
  differenceBetweenMeans: 1.65,
  state: "OPEN",
  priorEnforcementState: "ACTIVE",
  sampleStartedAt: fixtureIso,
  sampleEndedAt: fixtureIso,
  // cohortDefinition and cohortStatistics stay absent: their JSON content is
  // arbitrary (unknown), so a representative value would pin nothing honest —
  // the projection's optional fields omit them, and a later field arrives
  // additively through the updater.
};

const fixtureUnwritableClosure: UnwritableClosureProjection = {
  id: "00000000-0000-4000-8000-000000000048",
  kind: "SETTLEMENT_EVIDENCE_REJECTED",
  reason: "The merged pull request was never linked to the settled issue.",
  recordedAt: fixtureIso,
  repositoryName: "octo/overflow",
  issueNumber: 912,
  issueTitle: "HTTP response-shape snapshot",
  issueUrl: "https://github.com/Nitjsefnie/Overflow/issues/912",
  pullRequest: {
    number: 920,
    title: "HTTP response-shape snapshot",
    url: "https://github.com/Nitjsefnie/Overflow/pull/920",
  },
  settlementId: fixtureSettlementRowId,
  settlementParties: { creditorLogin: null, debtorLogin: "member" },
  calibrationId: null,
  calibrationOwnerLogin: null,
  viewerCanRequestCorrection: true,
  latestCorrection: { state: "OPEN", requestedAt: fixtureIso },
};

const fixtureRederivationOverview: RederivationOverview = {
  foldRevision: 4,
  repositories: [
    {
      repositoryId: fixtureTargetId,
      ownerName: "octo/overflow",
      rowsAtCurrentRevision: 40,
      rowsBelowCurrentRevision: 2,
      rederivationRequestedAt: fixtureIso,
    },
  ],
};

const fixtureOutstandingRederivationRequest: OutstandingRederivationRequest = {
  repositoryId: fixtureTargetId,
  ownerName: "octo/overflow",
  rederivationRequestedAt: fixtureIso,
};

const fixtureModeratorSummary: ModeratorSummary = {
  accountId: fixtureMemberId,
  githubLogin: "member",
  isConfigured: true,
};

const fixtureModeratorRoleChange: ModeratorRoleChange = {
  targetAccountId: fixtureTargetId,
  targetGitHubLogin: "target",
  role: "MODERATOR",
  actorId: fixtureMemberId,
  changedAt: fixtureIso,
};

const fixtureOpenOverrideRequest: SettlementOverrideRequest = {
  id: fixtureOverrideRequestId,
  issueId: fixtureTargetId,
  requesterId: fixtureMemberId,
  reason: "The settled difficulty reads high.",
  state: "OPEN",
  settledPoints: null,
  decidedById: null,
  decisionReason: null,
  createdAt: fixtureIso,
  decidedAt: null,
};

const fixtureGrantedOverrideRequest: SettlementOverrideRequest = {
  ...fixtureOpenOverrideRequest,
  state: "GRANTED",
  settledPoints: 4,
  decidedById: fixtureMemberId,
  decisionReason: "The opening label underpriced the work.",
  decidedAt: fixtureIso,
};

const fixtureOpenOverrideListEntry: OpenSettlementOverrideRequest = {
  id: fixtureOverrideRequestId,
  reason: "The settled difficulty reads high.",
  requestedAt: fixtureIso,
  requesterLogin: "member",
  repositoryName: "octo/overflow",
  issueNumber: 912,
  issueTitle: "HTTP response-shape snapshot",
  issueUrl: "https://github.com/Nitjsefnie/Overflow/issues/912",
  settlement: {
    settlementId: fixtureSettlementRowId,
    status: "SETTLED",
    openingComparisonPoints: 5,
    settledLabel: "opening:medium",
    settledPoints: 3,
    reviewRounds: 1,
    credits: 3,
    pullRequestNumber: 920,
    pullRequestTitle: "HTTP response-shape snapshot",
    pullRequestUrl: "https://github.com/Nitjsefnie/Overflow/pull/920",
  } satisfies SettlementOverrideEvidence,
  calibration: null,
};

/** The moderator gate behind every moderation and override route. */
const fixtureModeratorGate = {
  getSession: async () => ({ user: { id: fixtureMemberId, role: "MODERATOR" as const } }),
  findAccountByTokenHash: async () => null,
  getCurrentRole: async () => "MODERATOR" as const,
};

/**
 * The bodies the mutation derivations submit. Every identifier and timestamp
 * must satisfy the routes' schemas (a schema-invalid body is answered 422
 * before any handler logic runs), so they reuse the fixture identifiers the
 * stubs answer with.
 */

/** The POST /api/moderation body: an audit against the sample window. */
export const fixtureOpenAuditInput = {
  targetAccountId: fixtureTargetId,
  sampleStartedAt: fixtureIso,
  sampleEndedAt: fixtureIso,
  reason: "A calibration audit against the sample window.",
};

/** The PATCH /api/moderation/<id> body: the audit is substantiated. */
export const fixtureAuditActionInput = {
  action: "substantiate",
  reason: "The stored snapshot confirms the gap.",
};

/** The PATCH /api/moderation body: the recalibration closes. */
export const fixtureCloseRecalibrationInput = {
  targetAccountId: fixtureTargetId,
  plan: "Return the account to active after the review.",
};

/** The POST /api/moderation/recalibration/adjustment body. */
export const fixtureAdjustmentInput = {
  targetAccountId: fixtureTargetId,
  reason: "Compensating the under-credited outsiders.",
};

/** The POST /api/moderation/adjustments/reversal body. */
export const fixtureReversalInput = {
  adjustmentId: fixtureAdjustmentId,
  reason: "The adjustment mispriced the cohort.",
};

/** The POST /api/moderation/rederivation body. */
export const fixtureRederivationInput = { repositoryId: fixtureTargetId };

/** The POST /api/overrides body: a settlement correction request. */
export const fixtureOverrideInput = {
  settlementId: fixtureSettlementRowId,
  reason: "The settled difficulty reads high.",
};

/** The PATCH /api/overrides/<id> body: the grant decision. */
export const fixtureOverrideDecisionInput = {
  action: "grant",
  settledPoints: 4,
  reason: "The opening label underpriced the work.",
};

/** The GET /api/moderation/audits route's dependencies. */
export function fixtureModerationAuditsRouteDependencies(): ModerationAuditsRouteDependencies {
  return {
    ...fixtureModeratorGate,
    listOpenAudits: async () => [fixtureOpenAudit],
  };
}

/** The GET /api/moderation/unwritable-closures route's dependencies. */
export function fixtureModerationUnwritableClosuresRouteDependencies(): ModerationUnwritableClosuresRouteDependencies {
  return {
    ...fixtureModeratorGate,
    listUnwritableClosures: async () => ({
      queue: [fixtureUnwritableClosure],
      history: [fixtureUnwritableClosure],
    }),
  };
}

/** The POST/PATCH /api/moderation and GET /api/moderation/cohort dependencies. */
export function fixtureModerationRouteDependencies(): ModerationRouteDependencies {
  return {
    ...fixtureModeratorGate,
    createService: async () => ({
      previewCalibrationCohort: async () => fixtureCohortPreview,
      openAccountAudit: async () => fixtureAccountAudit,
      dismissAccountAudit: async () => ({ ...fixtureAccountAudit, state: "DISMISSED" }),
      substantiateAccountAudit: async () => ({ ...fixtureAccountAudit, state: "SUBSTANTIATED" }),
      closeRecalibration: async () => fixtureRecalibrationClosure,
    }),
  };
}

/** The recalibration preview and credit-adjustment routes' dependencies. */
export function fixtureModerationCreditRouteDependencies(): ModerationCreditRouteDependencies {
  return {
    ...fixtureModeratorGate,
    createService: async () => ({
      previewRecalibration: async () => fixtureRecalibrationCreditPreview,
      applyRecalibrationCreditAdjustment: async () => fixtureCreditAdjustment,
      reverseModerationCreditAdjustment: async () => fixtureCreditReversal,
    }),
  };
}

/** The GET/POST /api/moderation/rederivation route's dependencies. */
export function fixtureRederivationRouteDependencies(): RederivationRouteDependencies {
  const service: RederivationRouteService = {
    listRederivationStatus: async () => fixtureRederivationOverview,
    requestRederivation: async () => fixtureOutstandingRederivationRequest,
  };
  return {
    ...fixtureModeratorGate,
    createService: async () => service,
  };
}

/** The GET/POST /api/moderation/moderators route's dependencies. */
export function fixtureModeratorRouteDependencies(): ModeratorRouteDependencies {
  const service: ModeratorRouteService = {
    listModerators: async () => [fixtureModeratorSummary],
    setModeratorRole: async () => fixtureModeratorRoleChange,
  };
  return {
    ...fixtureModeratorGate,
    createService: async () => service,
  };
}

/** The POST /api/overrides route's dependencies. */
export function fixtureOverrideRouteDependencies(): SettlementOverrideRouteDependencies {
  return {
    getSession: async () => ({ user: { id: fixtureMemberId, role: "MODERATOR" as const } }),
    findAccountByTokenHash: async () => null,
    // The POST gate demands a member, not a moderator; the role is unused.
    getCurrentRole: async () => "MEMBER" as const,
    createService: async () => ({
      requestOverride: async () => fixtureOpenOverrideRequest,
    }),
  };
}

/** The GET /api/overrides route's dependencies. */
export function fixtureOverrideListRouteDependencies(): SettlementOverrideListRouteDependencies {
  return {
    ...fixtureModeratorGate,
    listOpenRequests: async () => [fixtureOpenOverrideListEntry],
  };
}

/** The PATCH /api/overrides/<id> route's dependencies (the GRANT decision). */
export function fixtureOverrideDecisionRouteDependencies(): SettlementOverrideDecisionDependencies {
  return {
    ...fixtureModeratorGate,
    createService: async () => ({
      decideRequest: async () => fixtureGrantedOverrideRequest,
    }),
  };
}
