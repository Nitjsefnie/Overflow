import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UnwritableClosureQueues } from "@/lib/dashboard/queries";
import type { OpenSettlementOverrideRequest } from "@/lib/overrides/service";
import { trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

const { readSession, readRole, listUnwritableClosures, listOpenRequests } = vi.hoisted(() => ({
  readSession: vi.fn(),
  readRole: vi.fn(),
  listUnwritableClosures: vi.fn(),
  listOpenRequests: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: readSession }));
vi.mock("@/lib/moderation/current-role", () => ({ getCurrentUserRole: readRole }));
vi.mock("@/lib/dashboard/queries", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/dashboard/queries")>()),
  listUnwritableClosures,
}));
vi.mock("@/lib/overrides/postgres-store", () => ({
  PostgresSettlementOverrideStore: class {
    listOpenRequests = listOpenRequests;
  },
}));

const moderatorId = "00000000-0000-4000-8000-000000000004";
const settlementId = "00000000-0000-4000-8000-000000000011";
const recordedAt = "2026-09-28T10:00:00.000Z";

const unwritableQueues = {
  queue: [{
    id: "00000000-0000-4000-8000-000000000010",
    kind: "SETTLEMENT_EVIDENCE_REJECTED",
    reason: "The closing evidence was rejected.",
    recordedAt,
    repositoryName: "Nitjsefnie/Overflow",
    issueNumber: 780,
    issueTitle: "MCP queues",
    issueUrl: "https://github.com/Nitjsefnie/Overflow/issues/780",
    pullRequest: null,
    settlementId,
    settlementParties: { creditorLogin: "creditor", debtorLogin: "debtor" },
    calibrationId: null,
    calibrationOwnerLogin: null,
    viewerCanRequestCorrection: true,
    latestCorrection: { state: "OPEN", requestedAt: recordedAt },
  }],
  history: [],
} satisfies UnwritableClosureQueues;

const openCorrections = [{
  id: "00000000-0000-4000-8000-000000000012",
  reason: "The evidence is wrong.",
  requestedAt: recordedAt,
  requesterLogin: "creditor",
  repositoryName: "Nitjsefnie/Overflow",
  issueNumber: 780,
  issueTitle: "MCP queues",
  issueUrl: "https://github.com/Nitjsefnie/Overflow/issues/780",
  settlement: null,
  calibration: null,
}] satisfies OpenSettlementOverrideRequest[];

useTrustedOrigin();

beforeEach(() => {
  vi.resetModules();
  readSession.mockReset().mockResolvedValue({ user: { id: moderatorId } });
  readRole.mockReset().mockResolvedValue("MODERATOR");
  listUnwritableClosures.mockReset().mockResolvedValue(unwritableQueues);
  listOpenRequests.mockReset().mockResolvedValue(openCorrections);
});

afterAll(() => { vi.resetModules(); });

function toolCall(name: string): Request {
  return new Request(`${trustedOrigin}/api/mcp`, {
    method: "POST",
    headers: { origin: trustedOrigin, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }),
  });
}

describe("production MCP queue wiring", () => {
  it("serves unwritable_closures from the production dashboard query", async () => {
    const { POST } = await import("@/app/api/mcp/route");

    const response = await POST(toolCall("unwritable_closures"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(unwritableQueues) }] },
    });
    expect(listUnwritableClosures).toHaveBeenCalledExactlyOnceWith(moderatorId);
  });

  it("serves correction_list from the production override store", async () => {
    const { POST } = await import("@/app/api/mcp/route");

    const response = await POST(toolCall("correction_list"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { content: [{ type: "text", text: JSON.stringify(openCorrections) }] },
    });
    expect(listOpenRequests).toHaveBeenCalledOnce();
  });
});
