import { describe, expect, it, vi } from "vitest";
import { foreignOrigin, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

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

function jsonRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://overflow.test/api/overrides", {
    method: "POST",
    headers: { origin: trustedOrigin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const foreignTextRequest = (body: unknown): Request =>
  jsonRequest(body, { origin: foreignOrigin, "content-type": "text/plain" });

const trustedTextRequest = (body: unknown): Request =>
  jsonRequest(body, { "content-type": "text/plain" });

useTrustedOrigin();

describe("settlement override request API", () => {
  it("records a member's request against a settlement", async () => {
    const requestOverride = vi.fn().mockResolvedValue(recorded);
    const handler = createSettlementOverridePostHandler({
      getSession: async () => ({ user: { id: memberId } }),
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
      { settlementId, reason: "The rationale comment was late." },
    );
  });

  it("refuses an unauthenticated request before parsing it", async () => {
    const requestOverride = vi.fn();
    const handler = createSettlementOverridePostHandler({
      getSession: async () => null,
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
    const getSession = vi.fn();
    const getCurrentRole = vi.fn();
    const createService = vi.fn();
    const handler = createSettlementOverridePostHandler({ getSession, getCurrentRole, createService });

    const response = await handler(foreignTextRequest({ settlementId, reason: "Forged." }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getCurrentRole).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });

  it("refuses a trusted-origin request that is not JSON", async () => {
    const getSession = vi.fn();
    const getCurrentRole = vi.fn();
    const createService = vi.fn();
    const handler = createSettlementOverridePostHandler({ getSession, getCurrentRole, createService });

    const response = await handler(trustedTextRequest({ settlementId, reason: "Wrong type." }));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getCurrentRole).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });
});

describe("settlement override decision API", () => {
  const context = { params: Promise.resolve({ id: requestId }) };

  it("grants a correction with points and a reason", async () => {
    const decideRequest = vi.fn().mockResolvedValue({ ...recorded, state: "GRANTED", settledPoints: 6 });
    const handler = createSettlementOverridePatchHandler({
      getSession: async () => ({ user: { id: moderatorId } }),
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
      getCurrentRole: async () => "MODERATOR",
      createService: async () => ({
        decideRequest: vi.fn().mockRejectedValue(
          new SettlementOverrideError("NOT_FOUND", "The settlement correction request was not found."),
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
    const getSession = vi.fn();
    const getCurrentRole = vi.fn();
    const createService = vi.fn();
    const handler = createSettlementOverridePatchHandler({ getSession, getCurrentRole, createService });

    const response = await handler(
      foreignTextRequest({ action: "grant", settledPoints: 6, reason: "Forged." }),
      context,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(getCurrentRole).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });

  it("refuses a trusted-origin decision that is not JSON", async () => {
    const getSession = vi.fn();
    const getCurrentRole = vi.fn();
    const createService = vi.fn();
    const handler = createSettlementOverridePatchHandler({ getSession, getCurrentRole, createService });

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
    expect(getSession).not.toHaveBeenCalled();
    expect(getCurrentRole).not.toHaveBeenCalled();
    expect(createService).not.toHaveBeenCalled();
  });
});
