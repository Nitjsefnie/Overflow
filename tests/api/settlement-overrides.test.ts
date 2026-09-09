import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  expectNoDependencyCall,
  guardedRequests,
  requestHost,
  unusedDependencies,
  useTrustedOrigin,
} from "../support/trusted-origin";

const { productionAuth, productionRole } = vi.hoisted(() => ({
  productionAuth: vi.fn(),
  productionRole: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: productionAuth }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: productionRole }));

import { createSettlementOverridePostHandler } from "@/app/api/overrides/route";
import { createSettlementOverridePatchHandler } from "@/app/api/overrides/[id]/route";
import { SettlementOverrideError, type SettlementOverrideRequest } from "@/lib/overrides/service";

const memberId = "00000000-0000-4000-8000-000000000001";
const moderatorId = "00000000-0000-4000-8000-000000000002";
const settlementId = "00000000-0000-4000-8000-000000000003";
const calibrationId = "00000000-0000-4000-8000-000000000006";
const requestId = "00000000-0000-4000-8000-000000000004";

const recorded: SettlementOverrideRequest = {
  id: requestId,
  issueId: "00000000-0000-4000-8000-000000000005",
  requesterId: memberId,
  reason: "The rationale comment was late.",
  state: "OPEN",
  settledPoints: null,
  decidedById: null,
  decisionReason: null,
  createdAt: "2026-09-05T10:00:00.000Z",
  decidedAt: null,
};

const { json: jsonRequest, foreignText: foreignTextRequest, trustedText: trustedTextRequest } =
  guardedRequests("/api/overrides");

useTrustedOrigin();

function memberPostHandler(): {
  handler: ReturnType<typeof createSettlementOverridePostHandler>;
  requestOverride: ReturnType<typeof vi.fn>;
} {
  const requestOverride = vi.fn();
  return {
    handler: createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      createService: async () => ({ requestOverride }),
    }),
    requestOverride,
  };
}

async function expectInvalidRequest(response: Response): Promise<void> {
  expect(response.status).toBe(422);
  await expect(response.json()).resolves.toEqual({
    error: { code: "INVALID_REQUEST", message: "Invalid settlement correction request." },
  });
}

describe("settlement override request API", () => {
  it("records a member's request against a settlement", async () => {
    const requestOverride = vi.fn().mockResolvedValue(recorded);
    const handler = createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(
      jsonRequest({ settlementId, reason: "The rationale comment was late." }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ request: recorded });
    expect(requestOverride).toHaveBeenCalledWith(
      { id: memberId },
      {
        target: { kind: "settlement", settlementId },
        reason: "The rationale comment was late.",
      },
    );
  });

  it("records a member's request against a self-work calibration", async () => {
    const requestOverride = vi.fn().mockResolvedValue(recorded);
    const handler = createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(
      jsonRequest({ calibrationId, reason: "The delivered label undercounts my own work." }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ request: recorded });
    expect(requestOverride).toHaveBeenCalledWith(
      { id: memberId },
      {
        target: { kind: "calibration", calibrationId },
        reason: "The delivered label undercounts my own work.",
      },
    );
  });

  // A request corrects exactly one priced outcome, so a body that names both
  // rows, neither, or anything beyond one of them has no target to carry.
  it("rejects a body naming both a settlement and a calibration", async () => {
    const { handler, requestOverride } = memberPostHandler();

    const response = await handler(
      jsonRequest({ settlementId, calibrationId, reason: "Both at once." }),
    );

    await expectInvalidRequest(response);
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("rejects a body naming neither a settlement nor a calibration", async () => {
    const { handler, requestOverride } = memberPostHandler();

    const response = await handler(jsonRequest({ reason: "Neither one." }));

    await expectInvalidRequest(response);
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("rejects a body carrying a key the route does not define", async () => {
    const { handler, requestOverride } = memberPostHandler();

    const response = await handler(
      jsonRequest({ settlementId, reason: "An extra key rode along.", settledPoints: 9 }),
    );

    await expectInvalidRequest(response);
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated request before parsing it", async () => {
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      getSession: async () => null,
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(jsonRequest({ settlementId, reason: "Wrong." }));

    expect(response.status).toBe(401);
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("refuses a session whose account no longer exists in the database", async () => {
    const getCurrentRole = vi.fn().mockResolvedValue(null);
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole,
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(jsonRequest({ settlementId, reason: "Wrong." }));

    expect(response.status).toBe(403);
    expect(getCurrentRole).toHaveBeenCalledWith(memberId);
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("rejects a malformed payload with a structured 422", async () => {
    const handler = createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      createService: async () => ({ requestOverride: vi.fn() }),
    });

    const response = await handler(jsonRequest({ settlementId, reason: "" }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid settlement correction request." },
    });
  });

  it("maps a service refusal onto its status code", async () => {
    const handler = createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MEMBER",
      createService: async () => ({
        requestOverride: vi.fn().mockRejectedValue(
          new SettlementOverrideError("CONFLICT", "Already open."),
        ),
      }),
    });

    const response = await handler(jsonRequest({ settlementId, reason: "Wrong." }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "CONFLICT", message: "Already open." },
    });
  });

  // A forged request must cost the server nothing: no session read, no role
  // lookup, no service.
  it("refuses a foreign-origin request before reading the session or the role", async () => {
    const dependencies = unusedDependencies();
    const handler = createSettlementOverridePostHandler(dependencies);

    const response = await handler(foreignTextRequest({ settlementId, reason: "Forged." }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin request that is not JSON", async () => {
    const dependencies = unusedDependencies();
    const handler = createSettlementOverridePostHandler(dependencies);

    const response = await handler(trustedTextRequest({ settlementId, reason: "Wrong type." }));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expectNoDependencyCall(dependencies);
  });
});

describe("settlement override decision API", () => {
  const context = { params: Promise.resolve({ id: requestId }) };

  it("grants a correction with points and a reason", async () => {
    const decideRequest = vi.fn().mockResolvedValue({ ...recorded, state: "GRANTED", settledPoints: 6 });
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      jsonRequest({ action: "grant", settledPoints: 6, reason: "The work was delivered." }),
      { params: Promise.resolve({ id: requestId }) },
    );

    expect(response.status).toBe(200);
    expect(decideRequest).toHaveBeenCalledWith({ id: moderatorId, role: "MODERATOR" }, requestId, {
      decision: "GRANT",
      settledPoints: 6,
      reason: "The work was delivered.",
    });
  });

  it("declines a correction with a reason", async () => {
    const decideRequest = vi.fn().mockResolvedValue({ ...recorded, state: "DECLINED" });
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      jsonRequest({ action: "decline", reason: "The settlement is right." }),
      { params: Promise.resolve({ id: requestId }) },
    );

    expect(response.status).toBe(200);
    expect(decideRequest).toHaveBeenCalledWith({ id: moderatorId, role: "MODERATOR" }, requestId, {
      decision: "DECLINE",
      reason: "The settlement is right.",
    });
  });

  it("re-reads the role from the database, so a session issued before a revocation cannot decide", async () => {
    const getCurrentRole = vi.fn().mockResolvedValue("MEMBER");
    const decideRequest = vi.fn();
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId, role: "MODERATOR" } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole,
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      jsonRequest({ action: "decline", reason: "No longer allowed." }),
      context,
    );

    expect(response.status).toBe(403);
    expect(getCurrentRole).toHaveBeenCalledWith(moderatorId);
    expect(decideRequest).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
  });

  it("rejects a grant without points, a decision without a reason, and an unknown action", async () => {
    const decideRequest = vi.fn();
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({ decideRequest }),
    });

    for (const payload of [
      { action: "grant", reason: "No points given." },
      { action: "decline", reason: "  " },
      { action: "reconsider", reason: "Not an action." },
      { action: "grant", settledPoints: 11, reason: "Outside the catalog." },
    ]) {
      const response = await handler(jsonRequest(payload), { params: Promise.resolve({ id: requestId }) });
      expect(response.status).toBe(422);
    }
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it("rejects an identifier that is not a request identifier", async () => {
    const decideRequest = vi.fn();
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      jsonRequest({ action: "decline", reason: "Nope." }),
      { params: Promise.resolve({ id: "not-a-uuid" }) },
    );

    expect(response.status).toBe(422);
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it("maps a missing request onto a 404", async () => {
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({
        decideRequest: vi.fn().mockRejectedValue(
          new SettlementOverrideError(
            "NOT_FOUND",
            "No settlement, calibration or correction request was found under that identifier.",
          ),
        ),
      }),
    });

    const response = await handler(
      jsonRequest({ action: "decline", reason: "Nope." }),
      { params: Promise.resolve({ id: requestId }) },
    );

    expect(response.status).toBe(404);
  });

  it("refuses a foreign-origin decision before reading the session or the role", async () => {
    const dependencies = unusedDependencies();
    const handler = createSettlementOverridePatchHandler(dependencies);

    const response = await handler(
      foreignTextRequest({ action: "grant", settledPoints: 6, reason: "Forged." }),
      context,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin decision that is not JSON", async () => {
    const dependencies = unusedDependencies();
    const handler = createSettlementOverridePatchHandler(dependencies);

    const response = await handler(
      trustedTextRequest({ action: "decline", reason: "Wrong type." }),
      context,
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expectNoDependencyCall(dependencies);
  });
});

// The same bearer-credential contract the shared moderator gate describe in
// tests/api/moderation.test.ts pins for the moderation families, pinned here
// for both settlement-override verbs: a member-owned token requests a
// correction, a moderator-owned token decides one, and both answer a demoted
// owner with the refusal their own gate already gives a demoted session.
describe("the settlement override gates' bearer credentials", () => {
  const ownerId = "00000000-0000-4000-8000-000000000007";
  const apiCredential = `ovf_${"override-gate".padEnd(43, "_")}`;
  const apiCredentialHash = createHash("sha256").update(apiCredential).digest();
  const tokenRejectionMessage = "The supplied API token was not accepted.";

  /** The request shape a programmatic token client produces: no Origin header. */
  function tokenRequest(body: unknown, method = "POST"): Request {
    return new Request(new URL("/api/overrides", requestHost), {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiCredential}`,
      },
      body: JSON.stringify(body),
    });
  }

  function tokenDependencies(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return {
      getSession: vi.fn(),
      findAccountByTokenHash: vi.fn().mockResolvedValue({ id: ownerId }),
      getCurrentRole: vi.fn().mockResolvedValue("MEMBER"),
      ...overrides,
    };
  }

  it("records a member-owned token's correction request as its owner", async () => {
    const deps = tokenDependencies();
    const requestOverride = vi.fn().mockResolvedValue(recorded);
    const handler = createSettlementOverridePostHandler({
      ...deps,
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(tokenRequest({ settlementId, reason: "The rationale comment was late." }));

    expect(response.status).toBe(200);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.findAccountByTokenHash).toHaveBeenCalledExactlyOnceWith(apiCredentialHash);
    expect(deps.getCurrentRole).toHaveBeenCalledExactlyOnceWith(ownerId);
    expect(requestOverride).toHaveBeenCalledWith(
      { id: ownerId },
      {
        target: { kind: "settlement", settlementId },
        reason: "The rationale comment was late.",
      },
    );
  });

  it("answers a demoted member owner's token with the member refusal", async () => {
    const deps = tokenDependencies({ getCurrentRole: vi.fn().mockResolvedValue(null) });
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      ...deps,
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(tokenRequest({ settlementId, reason: "Wrong." }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "A member account is required." },
    });
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("answers an unknown token with the credential rejection", async () => {
    const deps = tokenDependencies({ findAccountByTokenHash: vi.fn().mockResolvedValue(null) });
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      ...deps,
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(tokenRequest({ settlementId, reason: "Wrong." }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: tokenRejectionMessage },
    });
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("rejects a malformed bearer before any lookup", async () => {
    const deps = tokenDependencies();
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      ...deps,
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(
      new Request(new URL("/api/overrides", requestHost), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer deliberately-malformed-credential",
        },
        body: JSON.stringify({ settlementId, reason: "Wrong." }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: tokenRejectionMessage },
    });
    expect(deps.findAccountByTokenHash).not.toHaveBeenCalled();
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("answers a token-store outage on the request path with the request path's 502", async () => {
    const deps = tokenDependencies({
      findAccountByTokenHash: vi.fn().mockRejectedValue(new Error("token store outage")),
    });
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      ...deps,
      createService: async () => ({ requestOverride }),
    });

    const response = await handler(tokenRequest({ settlementId, reason: "Wrong." }));

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UPSTREAM_FAILURE",
        message: "Unable to authorize the settlement correction request.",
      },
    });
    expect(requestOverride).not.toHaveBeenCalled();
  });

  it("decides a moderator-owned token's correction as its owner", async () => {
    const deps = tokenDependencies({ getCurrentRole: vi.fn().mockResolvedValue("MODERATOR") });
    const decideRequest = vi.fn().mockResolvedValue({ ...recorded, state: "GRANTED", settledPoints: 6 });
    const handler = createSettlementOverridePatchHandler({
      ...deps,
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      tokenRequest({ action: "grant", settledPoints: 6, reason: "The work was delivered." }, "PATCH"),
      { params: Promise.resolve({ id: requestId }) },
    );

    expect(response.status).toBe(200);
    expect(deps.getSession).not.toHaveBeenCalled();
    expect(decideRequest).toHaveBeenCalledWith({ id: ownerId, role: "MODERATOR" }, requestId, {
      decision: "GRANT",
      settledPoints: 6,
      reason: "The work was delivered.",
    });
  });

  it("answers a demoted moderator owner's token with the moderator refusal", async () => {
    const deps = tokenDependencies({ getCurrentRole: vi.fn().mockResolvedValue("MEMBER") });
    const decideRequest = vi.fn();
    const handler = createSettlementOverridePatchHandler({
      ...deps,
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      tokenRequest({ action: "decline", reason: "No longer allowed." }, "PATCH"),
      { params: Promise.resolve({ id: requestId }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "Moderator authorization is required." },
    });
    expect(decideRequest).not.toHaveBeenCalled();
  });

  it("answers a token-store outage on the decision path with the shared gate's 502", async () => {
    const deps = tokenDependencies({
      getCurrentRole: vi.fn().mockResolvedValue("MODERATOR"),
      findAccountByTokenHash: vi.fn().mockRejectedValue(new Error("token store outage")),
    });
    const decideRequest = vi.fn();
    const handler = createSettlementOverridePatchHandler({
      ...deps,
      createService: async () => ({ decideRequest }),
    });

    const response = await handler(
      tokenRequest({ action: "decline", reason: "Nope." }, "PATCH"),
      { params: Promise.resolve({ id: requestId }) },
    );

    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UPSTREAM_FAILURE",
        message: "Unable to authorize the moderator request.",
      },
    });
    expect(decideRequest).not.toHaveBeenCalled();
  });
});
