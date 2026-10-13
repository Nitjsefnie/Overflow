import { describe, expect, it } from "vitest";
import { foldLedger } from "@/lib/domain/ledger";
import { calculateSettlement, type SettlementDecision } from "@/lib/domain/settlement";

describe("foldLedger", () => {
  it("emits equal and opposite entries for a positive settled decision", () => {
    const settlement = calculateSettlement({
      creditorId: "u1",
      debtorId: "u2",
      opening: 8,
      settled: 6,
      reviewIds: ["r1", "r2"],
    });

    expect(foldLedger([settlement])).toEqual([
      { accountId: "u1", counterpartyId: "u2", amount: 4 },
      { accountId: "u2", counterpartyId: "u1", amount: -4 },
    ]);
  });

  it("skips self-work, unsettled, and zero-credit decisions", () => {
    const zeroCredit = calculateSettlement({
      creditorId: "u1",
      debtorId: "u2",
      opening: 8,
      settled: 1,
      reviewIds: ["r1"],
    });

    expect(
      foldLedger([
        { status: "SELF_WORK", credits: 0 },
        { status: "UNSETTLED", credits: 0 },
        zeroCredit,
      ]),
    ).toEqual([]);
  });

  it("does not materialize arbitrary adjustment-shaped values", () => {
    const adjustment = {
      status: "ADJUSTMENT",
      accountId: "u1",
      amount: 100,
    } as unknown as SettlementDecision;

    expect(foldLedger([adjustment])).toEqual([]);
  });
});
