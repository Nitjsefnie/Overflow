import { inspect } from "node:util";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { requestHost, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

// Keep the production session read DB-free; every handler here is driven
// through its factory with stubbed gate dependencies.
vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));

import { createModeratorPostHandler } from "@/app/api/moderation/moderators/route";
import { hashApiToken } from "@/lib/security/api-token";
import {
  createModerationClosePatchHandler,
  createModerationPostHandler,
} from "@/app/api/moderation/route";
import { createModerationAuditPatchHandler } from "@/app/api/moderation/[id]/route";
import { createModerationReversalPatchHandler } from "@/app/api/moderation/reversal/route";
import { createModerationAdjustmentPostHandler } from "@/app/api/moderation/recalibration/adjustment/route";
import { createModerationReversalPostHandler } from "@/app/api/moderation/adjustments/reversal/route";
import { createRederivationPostHandler } from "@/app/api/moderation/rederivation/route";
import { createSanctionContestDecisionPostHandler } from "@/app/api/moderation/contests/route";
import { createSettlementOverridePatchHandler } from "@/app/api/overrides/[id]/route";
import { ModerationServiceError } from "@/lib/moderation/service";
import { SanctionContestError } from "@/lib/moderation/sanction-contest-service";
import { SettlementOverrideError } from "@/lib/overrides/service";
import type { PrivilegedAction } from "@/lib/security/privileged-action-log";

// Bind the route graph to this file's mocks and release it afterward.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

useTrustedOrigin();

const moderatorId = "00000000-0000-4000-8000-0000000000d1";
const tokenId = "00000000-0000-4000-8000-0000000000e1";
const targetAccountId = "00000000-0000-4000-8000-0000000000a1";
const auditId = "00000000-0000-4000-8000-0000000000a2";
const adjustmentId = "00000000-0000-4000-8000-0000000000a3";
const reversalId = "00000000-0000-4000-8000-0000000000a4";
const repositoryId = "00000000-0000-4000-8000-0000000000a5";
const overrideRequestId = "00000000-0000-4000-8000-0000000000a6";
const issueId = "00000000-0000-4000-8000-0000000000a7";
const contestRequestId = "00000000-0000-4000-8000-0000000000a8";
const clientAddress = "203.0.113.7";

// Distinctive values that must never reach a journal line. The digest is the
// production hash function's output, not a hand-rolled re-derivation of it.
const bearerToken = `ovf_${"P".repeat(20)}rivilegedBearer${"z".repeat(8)}`;
const bearerHashHex = hashApiToken(bearerToken)!.toString("hex");
const cookieValue = "privileged-cookie-secret-4c19e2";
const secrets = [bearerToken, bearerHashHex, cookieValue];

type Credential = "session cookie" | "bearer token";

type RouteCase = {
  action: PrivilegedAction;
  method: "POST" | "PATCH";
  path: string;
  body: unknown;
  params?: Record<string, string>;
  /** The service method the mutation calls, and what it resolves to. */
  serviceMethod: string;
  result: unknown;
  /** A failure the route maps onto an error response. */
  failure: Error;
  /**
   * The service method takes an `onCommitted` callback: the stub must invoke it
   * while resolving, the way the real service does the moment its queue write
   * commits, for the route's journal line to be written at all.
   */
  mutationTakesOnCommitted?: boolean;
  subject: Record<string, string>;
  /** The route's handler factory; `never` admits every factory's own dependency and context types. */
  handler: (dependencies: never) => (request: Request, context: never) => Promise<Response>;
};

const routeCases: RouteCase[] = [
  {
    action: "moderator-role.grant",
    method: "POST",
    path: "/api/moderation/moderators",
    body: { targetAccountId, moderator: true },
    serviceMethod: "setModeratorRole",
    result: { targetAccountId, targetGitHubLogin: "someone", role: "MODERATOR", actorId: moderatorId, changedAt: "x" },
    failure: new ModerationServiceError("CONFLICT", "Already a moderator."),
    subject: { targetAccountId },
    handler: createModeratorPostHandler,
  },
  {
    action: "moderator-role.revoke",
    method: "POST",
    path: "/api/moderation/moderators",
    body: { targetAccountId, moderator: false },
    serviceMethod: "setModeratorRole",
    result: { targetAccountId, targetGitHubLogin: "someone", role: "MEMBER", actorId: moderatorId, changedAt: "x" },
    failure: new ModerationServiceError("CONFLICT", "Not a moderator."),
    subject: { targetAccountId },
    handler: createModeratorPostHandler,
  },
  {
    action: "audit.open",
    method: "POST",
    path: "/api/moderation",
    body: {
      targetAccountId,
      sampleStartedAt: "2026-09-01T00:00:00.000Z",
      sampleEndedAt: "2026-09-09T00:00:00.000Z",
      reason: "A settle-to-claim pattern worth a review.",
    },
    serviceMethod: "openAccountAudit",
    result: { id: auditId, targetAccountId, repositoryId: null, state: "OPEN" },
    failure: new ModerationServiceError("INSUFFICIENT_SAMPLES", "Too few samples."),
    subject: { auditId, targetAccountId },
    handler: createModerationPostHandler,
  },
  {
    action: "audit.dismiss",
    method: "PATCH",
    path: `/api/moderation/${auditId}`,
    params: { id: auditId },
    body: { action: "dismiss", reason: "The pattern had an innocent cause." },
    serviceMethod: "dismissAccountAudit",
    result: { id: auditId, targetAccountId, repositoryId: null, state: "DISMISSED" },
    failure: new ModerationServiceError("CONFLICT", "Already decided."),
    subject: { auditId, targetAccountId },
    handler: createModerationAuditPatchHandler,
  },
  {
    action: "audit.substantiate",
    method: "PATCH",
    path: `/api/moderation/${auditId}`,
    params: { id: auditId },
    body: { action: "substantiate", reason: "The pattern was confirmed." },
    serviceMethod: "substantiateAccountAudit",
    result: { id: auditId, targetAccountId, repositoryId: null, state: "SUBSTANTIATED" },
    failure: new ModerationServiceError("NOT_FOUND", "No such audit."),
    subject: { auditId, targetAccountId },
    handler: createModerationAuditPatchHandler,
  },
  {
    action: "recalibration.close",
    method: "PATCH",
    path: "/api/moderation",
    body: { targetAccountId, plan: "Recalibration complete; restore the account." },
    serviceMethod: "closeRecalibration",
    result: { targetAccountId, priorState: "RECALIBRATING", targetState: "ACTIVE" },
    failure: new ModerationServiceError("CONFLICT", "Not recalibrating."),
    subject: { targetAccountId },
    handler: createModerationClosePatchHandler,
  },
  {
    action: "ban.reverse",
    method: "PATCH",
    path: "/api/moderation/reversal",
    body: { targetAccountId, reason: "The flagged pattern was re-reviewed and does not hold." },
    serviceMethod: "reverseBan",
    result: {
      targetAccountId,
      priorState: "BANNED",
      targetState: "ACTIVE",
      confirmedPatternCount: 3,
      reactivatedRepositories: [repositoryId],
    },
    failure: new ModerationServiceError("CONFLICT", "Not banned."),
    subject: { targetAccountId },
    handler: createModerationReversalPatchHandler,
  },
  {
    action: "credit-adjustment.create",
    method: "POST",
    path: "/api/moderation/recalibration/adjustment",
    body: { targetAccountId, reason: "Compensate the affected creditors." },
    serviceMethod: "applyRecalibrationCreditAdjustment",
    result: { id: adjustmentId, targetAccountId, reversalOf: null },
    failure: new ModerationServiceError("CONFLICT", "Already applied."),
    subject: { adjustmentId, targetAccountId },
    handler: createModerationAdjustmentPostHandler,
  },
  {
    action: "credit-adjustment.reverse",
    method: "POST",
    path: "/api/moderation/adjustments/reversal",
    body: { adjustmentId, reason: "The adjustment was applied in error." },
    serviceMethod: "reverseModerationCreditAdjustment",
    result: { id: reversalId, targetAccountId, reversalOf: adjustmentId },
    failure: new ModerationServiceError("CONFLICT", "Already reversed."),
    subject: { adjustmentId, reversalId, targetAccountId },
    handler: createModerationReversalPostHandler,
  },
  {
    action: "repository.rederivation-request",
    method: "POST",
    path: "/api/moderation/rederivation",
    body: { repositoryId },
    serviceMethod: "requestRederivation",
    result: { repositoryId, ownerName: "owner", rederivationRequestedAt: "2026-09-26T00:00:00.000Z" },
    failure: new ModerationServiceError("NOT_FOUND", "No such repository."),
    mutationTakesOnCommitted: true,
    subject: { repositoryId },
    handler: createRederivationPostHandler,
  },
  {
    action: "settlement-override.grant",
    method: "PATCH",
    path: `/api/overrides/${overrideRequestId}`,
    params: { id: overrideRequestId },
    body: { action: "grant", settledPoints: 4, reason: "The settlement was mispriced." },
    serviceMethod: "decideRequest",
    result: { id: overrideRequestId, issueId, state: "GRANTED" },
    failure: new SettlementOverrideError("CONFLICT", "Already decided."),
    subject: { overrideRequestId, issueId },
    handler: createSettlementOverridePatchHandler,
  },
  {
    action: "settlement-override.decline",
    method: "PATCH",
    path: `/api/overrides/${overrideRequestId}`,
    params: { id: overrideRequestId },
    body: { action: "decline", reason: "The settlement stands." },
    serviceMethod: "decideRequest",
    result: { id: overrideRequestId, issueId, state: "DECLINED" },
    failure: new SettlementOverrideError("NOT_FOUND", "No such request."),
    subject: { overrideRequestId, issueId },
    handler: createSettlementOverridePatchHandler,
  },
  {
    action: "sanction.contest.decide",
    method: "POST",
    path: "/api/moderation/contests",
    body: { requestId: contestRequestId, decision: "GRANTED", reason: "The audit overcounted the review rounds." },
    serviceMethod: "decideContest",
    result: {
      request: {
        id: contestRequestId,
        accountId: targetAccountId,
        state: "DECIDED",
        decision: "GRANTED",
      },
      effect: "lifted",
    },
    failure: new SanctionContestError("CONFLICT", "Already decided."),
    subject: { requestId: contestRequestId, accountId: targetAccountId },
    handler: createSanctionContestDecisionPostHandler,
  },
];

function routeRequest(
  routeCase: RouteCase,
  credential: Credential,
  extraHeaders: Record<string, string> = {},
  realIp: string | null = clientAddress,
): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (realIp !== null) {
    headers["x-real-ip"] = realIp;
  }
  if (credential === "bearer token") {
    headers.authorization = `Bearer ${bearerToken}`;
  } else {
    headers.origin = trustedOrigin;
    headers.cookie = `authjs.session-token=${cookieValue}`;
  }
  return new Request(new URL(routeCase.path, requestHost), {
    method: routeCase.method,
    headers,
    body: JSON.stringify(routeCase.body),
  });
}

function routeDependencies(
  routeCase: RouteCase,
  options: { role?: "MODERATOR" | "MEMBER"; fails?: boolean } = {},
): { dependencies: Record<string, Mock>; mutation: Mock } {
  const mutation = options.fails
    ? vi.fn().mockRejectedValue(routeCase.failure)
    : routeCase.mutationTakesOnCommitted
      ? vi.fn(async (...args: unknown[]) => {
          // The real service invokes this the instant the queue write commits,
          // before anything that can still fail; the journal line depends on it.
          (args[2] as (() => void) | undefined)?.();
          return routeCase.result;
        })
      : vi.fn().mockResolvedValue(routeCase.result);
  const dependencies = {
    getSession: vi.fn().mockResolvedValue({ user: { id: moderatorId } }),
    findAccountByTokenHash: vi.fn().mockResolvedValue({ id: moderatorId, tokenId }),
    getCurrentRole: vi.fn().mockResolvedValue(options.role ?? "MODERATOR"),
    createService: vi.fn().mockResolvedValue({ [routeCase.serviceMethod]: mutation }),
  };
  return { dependencies, mutation };
}

async function drive(routeCase: RouteCase, dependencies: Record<string, Mock>, request: Request): Promise<Response> {
  const handler = routeCase.handler(dependencies as never);
  const context = routeCase.params === undefined ? undefined : { params: Promise.resolve(routeCase.params) };
  return handler(request, context as never);
}

let consoleInfo: MockInstance<typeof console.info>;
const consoleSpies: MockInstance[] = [];

beforeEach(() => {
  consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
  consoleSpies.push(consoleInfo);
  for (const method of ["log", "warn", "error", "debug"] as const) {
    consoleSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
  }
});

afterEach(() => {
  for (const spy of consoleSpies.splice(0)) {
    spy.mockRestore();
  }
});

function privilegedLines(): unknown[][] {
  return consoleInfo.mock.calls.filter(([message]) => message === "Privileged action");
}

describe.each(routeCases)("privileged action journal: $action", (routeCase) => {
  it.each([
    ["session cookie", { kind: "session" }],
    ["bearer token", { kind: "token", tokenId }],
  ] as const)("logs one line after the mutation succeeds over a %s", async (credential, reference) => {
    const { dependencies, mutation } = routeDependencies(routeCase);

    const response = await drive(routeCase, dependencies, routeRequest(routeCase, credential));

    expect(response.status).toBeLessThan(300);
    expect(privilegedLines()).toEqual([
      [
        "Privileged action",
        {
          action: routeCase.action,
          actorId: moderatorId,
          credential: reference,
          clientAddress,
          clientAddressVerified: false,
          subject: routeCase.subject,
        },
      ],
    ]);
    // Logged after the mutation resolved, never ahead of it.
    expect(mutation.mock.invocationCallOrder[0]).toBeLessThan(consoleInfo.mock.invocationCallOrder[0]!);
  });

  it("logs a null client address when only X-Forwarded-For is present", async () => {
    const { dependencies } = routeDependencies(routeCase);
    const request = routeRequest(routeCase, "bearer token", { "x-forwarded-for": clientAddress }, null);

    await drive(routeCase, dependencies, request);

    expect(privilegedLines()).toHaveLength(1);
    expect(privilegedLines()[0]?.[1]).toMatchObject({ clientAddress: null });
  });

  it("logs nothing when the gate refuses a non-moderator", async () => {
    const { dependencies, mutation } = routeDependencies(routeCase, { role: "MEMBER" });

    const response = await drive(routeCase, dependencies, routeRequest(routeCase, "session cookie"));

    expect(response.status).toBe(403);
    expect(mutation).not.toHaveBeenCalled();
    expect(privilegedLines()).toEqual([]);
  });

  it("logs nothing when the mutation itself fails", async () => {
    // The rejecting stub never invokes its `onCommitted` callback, so this
    // models a PRE-commit failure; a committed request always gets its line
    // from the callback, however the service answers afterwards.
    const { dependencies, mutation } = routeDependencies(routeCase, { fails: true });

    const response = await drive(routeCase, dependencies, routeRequest(routeCase, "bearer token"));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(privilegedLines()).toEqual([]);
  });

  it.each(["session cookie", "bearer token"] as const)(
    "writes no bearer token, token hash or cookie value to any console line over a %s",
    async (credential) => {
      const { dependencies } = routeDependencies(routeCase);
      // A bearer request that also carries the browser's cookie: whichever
      // credential the gate chose, neither secret may surface.
      const extra: Record<string, string> =
        credential === "bearer token" ? { cookie: `authjs.session-token=${cookieValue}` } : {};

      await drive(routeCase, dependencies, routeRequest(routeCase, credential, extra));

      expect(privilegedLines()).toHaveLength(1);
      for (const spy of consoleSpies) {
        for (const call of spy.mock.calls) {
          for (const argument of call) {
            const rendered = [inspect(argument, { depth: null }), JSON.stringify(argument) ?? ""];
            for (const text of rendered) {
              for (const secret of secrets) {
                expect(text).not.toContain(secret);
              }
            }
          }
        }
      }
    },
  );
});

describe("privileged client-address verification: POST /api/moderation/moderators", () => {
  // The journal's client address comes from X-Real-IP, which the app listens
  // behind nginx for — but the listener is loopback, so any local process can
  // reach it and set the header. Verification therefore needs the shared
  // proxy secret only nginx (and the operator) hold; without it the address
  // is still recorded, marked unverified.
  const moderatorGrant = routeCases.find(
    (routeCase): routeCase is RouteCase => routeCase.action === "moderator-role.grant",
  )!;

  const proxySecret = "overflow-1044-proxy-secret";
  const spoofedAddress = "203.0.113.77";
  const secretHeaderName = "x-privileged-proxy-secret";

  let savedSecret: string | undefined;
  let hadSecret = false;

  function setProxySecret(value: string | undefined): void {
    if (!hadSecret) {
      hadSecret = "PRIVILEGED_PROXY_SECRET" in process.env;
      savedSecret = process.env.PRIVILEGED_PROXY_SECRET;
    }
    if (value === undefined) {
      delete process.env.PRIVILEGED_PROXY_SECRET;
    } else {
      process.env.PRIVILEGED_PROXY_SECRET = value;
    }
  }

  afterEach(() => {
    if (hadSecret) {
      process.env.PRIVILEGED_PROXY_SECRET = savedSecret;
    } else {
      delete process.env.PRIVILEGED_PROXY_SECRET;
    }
    hadSecret = false;
    savedSecret = undefined;
  });

  async function grantWith(extraHeaders: Record<string, string>, realIp: string | null): Promise<void> {
    const { dependencies } = routeDependencies(moderatorGrant);
    const response = await drive(moderatorGrant, dependencies, routeRequest(moderatorGrant, "bearer token", extraHeaders, realIp));
    expect(response.status).toBeLessThan(300);
  }

  it("records a spoofed X-Real-IP unverified when no secret header is sent and no secret is configured", async () => {
    setProxySecret(undefined);

    await grantWith({}, spoofedAddress);

    expect(privilegedLines()).toEqual([
      [
        "Privileged action",
        {
          action: "moderator-role.grant",
          actorId: moderatorId,
          credential: { kind: "token", tokenId },
          clientAddress: spoofedAddress,
          clientAddressVerified: false,
          subject: { targetAccountId },
        },
      ],
    ]);
  });

  it("verifies the address when the secret header carries the configured secret", async () => {
    setProxySecret(proxySecret);

    await grantWith({ [secretHeaderName]: proxySecret }, spoofedAddress);

    expect(privilegedLines()).toEqual([
      [
        "Privileged action",
        {
          action: "moderator-role.grant",
          actorId: moderatorId,
          credential: { kind: "token", tokenId },
          clientAddress: spoofedAddress,
          clientAddressVerified: true,
          subject: { targetAccountId },
        },
      ],
    ]);
  });

  it("records the address unverified when the secret header is present but wrong", async () => {
    setProxySecret(proxySecret);

    await grantWith({ [secretHeaderName]: "not-the-configured-secret" }, spoofedAddress);

    expect(privilegedLines()).toEqual([
      [
        "Privileged action",
        {
          action: "moderator-role.grant",
          actorId: moderatorId,
          credential: { kind: "token", tokenId },
          clientAddress: spoofedAddress,
          clientAddressVerified: false,
          subject: { targetAccountId },
        },
      ],
    ]);
  });

  it("marks the address unverified when a secret header arrives while no secret is configured (fail-safe)", async () => {
    setProxySecret(undefined);

    await grantWith({ [secretHeaderName]: proxySecret }, spoofedAddress);

    expect(privilegedLines()).toEqual([
      [
        "Privileged action",
        {
          action: "moderator-role.grant",
          actorId: moderatorId,
          credential: { kind: "token", tokenId },
          clientAddress: spoofedAddress,
          clientAddressVerified: false,
          subject: { targetAccountId },
        },
      ],
    ]);
  });

  it.each([null, "not-an-address", "203.0.113.77, 198.51.100.4"] as const)(
    "records a %j X-Real-IP as a null address, unverified, even with a valid secret",
    async (realIp) => {
      setProxySecret(proxySecret);

      await grantWith({ [secretHeaderName]: proxySecret }, realIp);

      expect(privilegedLines()).toEqual([
        [
          "Privileged action",
          {
            action: "moderator-role.grant",
            actorId: moderatorId,
            credential: { kind: "token", tokenId },
            clientAddress: null,
            clientAddressVerified: false,
            subject: { targetAccountId },
          },
        ],
      ]);
    },
  );
});
