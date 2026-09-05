import { describe, expect, it } from "vitest";
import {
  SettlementOverrideError,
  SettlementOverrideService,
  type OpenSettlementOverrideRequest,
  type SettlementOverrideRequest,
  type SettlementOverrideStore,
  type SettlementOverrideStoreResult,
} from "@/lib/overrides/service";

const openRequest: SettlementOverrideRequest = {
  id: "request-id",
  issueId: "issue-id",
  requesterId: "member-id",
  reason: "The rationale comment was posted an hour after the merge.",
  state: "OPEN",
  settledPoints: null,
  decidedById: null,
  decisionReason: null,
  createdAt: "2026-09-05T10:00:00.000Z",
  decidedAt: null,
};

type StoreCall = { method: string; input: unknown };

function fakeStore(
  overrides: Partial<SettlementOverrideStore> = {},
): { store: SettlementOverrideStore; calls: StoreCall[] } {
  const calls: StoreCall[] = [];
  const store: SettlementOverrideStore = {
    async createRequest(input) {
      calls.push({ method: "createRequest", input });
      return { kind: "ok", value: openRequest };
    },
    async listOpenRequests() {
      calls.push({ method: "listOpenRequests", input: null });
      return [];
    },
    async listRequestsForSettlement(settlementId, viewerId) {
      calls.push({ method: "listRequestsForSettlement", input: { settlementId, viewerId } });
      return [openRequest];
    },
    async decideRequest(input) {
      calls.push({ method: "decideRequest", input });
      return { kind: "ok", value: { ...openRequest, state: "GRANTED" } };
    },
    ...overrides,
  };
  return { store, calls };
}

describe("settlement override service", () => {
  it("records a member's request with a trimmed reason", async () => {
    const { store, calls } = fakeStore();
    const service = new SettlementOverrideService(store);

    const created = await service.requestOverride(
      { id: "member-id" },
      { settlementId: "settlement-id", reason: "  The rationale landed late.  " },
    );

    expect(created).toEqual(openRequest);
    expect(calls).toEqual([
      {
        method: "createRequest",
        input: {
          requesterId: "member-id",
          settlementId: "settlement-id",
          reason: "The rationale landed late.",
        },
      },
    ]);
  });

  it("refuses a request without a reason", async () => {
    const { store, calls } = fakeStore();
    const service = new SettlementOverrideService(store);

    await expect(
      service.requestOverride({ id: "member-id" }, { settlementId: "settlement-id", reason: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toEqual([]);
  });

  it("reports the store's refusal of a member who is neither creditor nor debtor", async () => {
    const { store } = fakeStore({
      async createRequest(): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>> {
        return { kind: "forbidden" };
      },
    });
    const service = new SettlementOverrideService(store);

    await expect(
      service.requestOverride({ id: "stranger-id" }, { settlementId: "settlement-id", reason: "Wrong." }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("reports a second open request on the same settlement as a conflict", async () => {
    const { store } = fakeStore({
      async createRequest(): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>> {
        return { kind: "conflict" };
      },
    });
    const service = new SettlementOverrideService(store);

    await expect(
      service.requestOverride({ id: "member-id" }, { settlementId: "settlement-id", reason: "Wrong." }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lists open requests only for a moderator", async () => {
    const queued: OpenSettlementOverrideRequest[] = [
      {
        id: "request-id",
        reason: "The rationale landed late.",
        requestedAt: "2026-09-05T10:00:00.000Z",
        requesterLogin: "ada",
        repositoryName: "example/overflow",
        issueNumber: 44,
        issueTitle: "An unsettled issue",
        issueUrl: "https://github.com/example/overflow/issues/44",
        settlement: null,
      },
    ];
    const { store } = fakeStore({
      async listOpenRequests() {
        return queued;
      },
    });
    const service = new SettlementOverrideService(store);

    await expect(service.listOpenRequests({ id: "moderator-id", role: "MODERATOR" })).resolves.toEqual(queued);
    await expect(service.listOpenRequests({ id: "member-id", role: "MEMBER" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("lists a settlement's requests for a party to that settlement", async () => {
    const { store, calls } = fakeStore();
    const service = new SettlementOverrideService(store);

    await expect(service.listRequestsForSettlement({ id: "member-id" }, "settlement-id")).resolves.toEqual([
      openRequest,
    ]);
    expect(calls).toEqual([
      {
        method: "listRequestsForSettlement",
        input: { settlementId: "settlement-id", viewerId: "member-id" },
      },
    ]);
  });

  it("grants a correction with settled points and a reason", async () => {
    const { store, calls } = fakeStore();
    const service = new SettlementOverrideService(store);

    await service.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", {
      decision: "GRANT",
      settledPoints: 6,
      reason: "  The delivered label was applied by the issue owner.  ",
    });

    expect(calls).toEqual([
      {
        method: "decideRequest",
        input: {
          actorId: "moderator-id",
          requestId: "request-id",
          decision: "GRANT",
          settledPoints: 6,
          reason: "The delivered label was applied by the issue owner.",
        },
      },
    ]);
  });

  it("declines a correction with a reason and no points", async () => {
    const { store, calls } = fakeStore();
    const service = new SettlementOverrideService(store);

    await service.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", {
      decision: "DECLINE",
      reason: "The evidence window closed before the label was applied.",
    });

    expect(calls).toEqual([
      {
        method: "decideRequest",
        input: {
          actorId: "moderator-id",
          requestId: "request-id",
          decision: "DECLINE",
          reason: "The evidence window closed before the label was applied.",
        },
      },
    ]);
  });

  it("refuses a decision from a member, a decision without a reason, and points outside the catalog", async () => {
    const { store, calls } = fakeStore();
    const service = new SettlementOverrideService(store);

    await expect(
      service.decideRequest({ id: "member-id", role: "MEMBER" }, "request-id", {
        decision: "GRANT",
        settledPoints: 6,
        reason: "Corrected.",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      service.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", {
        decision: "DECLINE",
        reason: " ",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", {
        decision: "GRANT",
        settledPoints: 11,
        reason: "Corrected.",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", {
        decision: "GRANT",
        settledPoints: 2.5,
        reason: "Corrected.",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(calls).toEqual([]);
  });

  it("reports an already decided request as a conflict and a missing one as not found", async () => {
    const conflicting = new SettlementOverrideService(
      fakeStore({
        async decideRequest(): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>> {
          return { kind: "conflict" };
        },
      }).store,
    );
    const missing = new SettlementOverrideService(
      fakeStore({
        async decideRequest(): Promise<SettlementOverrideStoreResult<SettlementOverrideRequest>> {
          return { kind: "not_found" };
        },
      }).store,
    );
    const decision = { decision: "DECLINE", reason: "Already handled." } as const;

    await expect(
      conflicting.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", decision),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      missing.decideRequest({ id: "moderator-id", role: "MODERATOR" }, "request-id", decision),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws its own error type so routes can map codes to statuses", async () => {
    const service = new SettlementOverrideService(fakeStore().store);

    await expect(
      service.requestOverride({ id: "member-id" }, { settlementId: "settlement-id", reason: "" }),
    ).rejects.toBeInstanceOf(SettlementOverrideError);
  });
});
