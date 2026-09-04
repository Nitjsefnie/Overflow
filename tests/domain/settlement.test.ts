import { describe, expect, it } from "vitest";
import { calculateSettlement } from "@/lib/domain/settlement";

describe("calculateSettlement", () => {
  it("suppresses self-work before calculating settlement", () => {
    expect(
      calculateSettlement({
        creditorId: "u1",
        debtorId: "u1",
        opening: 8,
        settled: 9,
        reviewIds: ["r1"],
      }),
    ).toEqual({ status: "SELF_WORK", credits: 0 });
  });

  it("uses the settled difficulty and subtracts unique review rounds", () => {
    expect(
      calculateSettlement({
        creditorId: "u1",
        debtorId: "u2",
        opening: 8,
        settled: 6,
        reviewIds: ["r1", "r1", "r2"],
      }),
    ).toMatchObject({
      status: "SETTLED",
      creditorId: "u1",
      debtorId: "u2",
      opening: 8,
      settled: 6,
      reviewRounds: 2,
      credits: 4,
    });
  });

  it("returns unsettled when no creditor can receive the settlement", () => {
    expect(
      calculateSettlement({
        creditorId: null,
        debtorId: "u2",
        opening: 8,
        settled: 6,
        reviewIds: [],
      }),
    ).toEqual({ status: "UNSETTLED", credits: 0 });
  });

  it("returns unsettled when actual difficulty is missing", () => {
    expect(
      calculateSettlement({
        creditorId: "u1",
        debtorId: "u2",
        opening: 8,
        settled: null,
        reviewIds: [],
      }),
    ).toEqual({ status: "UNSETTLED", credits: 0 });
  });

  it("returns unsettled when actual difficulty is ambiguous", () => {
    expect(
      calculateSettlement({
        creditorId: "u1",
        debtorId: "u2",
        opening: 8,
        settled: { kind: "ambiguous" },
        reviewIds: [],
      }),
    ).toEqual({ status: "UNSETTLED", credits: 0 });
  });

  it("floors settlement credits at zero", () => {
    expect(
      calculateSettlement({
        creditorId: "u1",
        debtorId: "u2",
        opening: 8,
        settled: 1,
        reviewIds: ["r1", "r2"],
      }),
    ).toMatchObject({ status: "SETTLED", reviewRounds: 2, credits: 0 });
  });
});
