import { describe, expect, it } from "vitest";
import { isParticipationEligibleAt, moderationEventsFromJson, moderationInstantToIso } from "@/lib/fold/moderation-history";
import type { FoldModerationEvent, FoldUser } from "@/lib/fold/repository-fold";

const user: FoldUser = { id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE" };
const lowId = "00000000-0000-4000-8000-000000000001";
const highId = "00000000-0000-4000-8000-000000000002";
function lift(occurredAt: string, id = lowId): FoldModerationEvent {
  return { id, occurredAt, priorState: "RECALIBRATING", newState: "ACTIVE" };
}

describe("moderation history instants", () => {
  it.each(["+16:00", "-16:00", "+23:59"])("rejects offset %s outside PostgreSQL's range", (offset) => {
    expect(moderationInstantToIso("2026-01-01T00:00:00+15:59:59")).toBe("2025-12-31T08:00:01.000000Z");
    expect(moderationInstantToIso("2026-01-01T00:00:00-15:59:59")).toBe("2026-01-01T15:59:59.000000Z");
    expect(() => moderationInstantToIso(`2026-01-01T00:00:00${offset}`)).toThrow("Timestamp was invalid.");
  });

  it("rejects hour 24 in a timestamp rendering", () => {
    expect(() => moderationInstantToIso("2026-01-01T24:00:00Z")).toThrow("Timestamp was invalid.");
  });

  it("rejects a non-leap century while accepting a Gregorian leap century", () => {
    expect(() => moderationInstantToIso("1900-02-29T00:00:00Z")).toThrow("Timestamp was invalid.");
    expect(moderationInstantToIso("2000-02-29T00:00:00Z")).toBe("2000-02-29T00:00:00.000000Z");
  });

  it.each([
    ["extended year", "10000-01-01T00:00:00+00:00", "9999-12-31T23:59:59.999999Z"],
    ["negative year", "0002-01-01T00:00:00+00:00 BC", "-000002-12-31T23:59:59.999999Z"],
  ])("orders the %s boundary by instant rather than canonical string", (_name, occurredAt, before) => {
    const history = { ...user, moderationEvents: [lift(occurredAt)] };
    expect(isParticipationEligibleAt(history, before)).toBe(false);
    expect(isParticipationEligibleAt(history, occurredAt)).toBe(true);
    // Crossing BC/AD also keeps a lift after participation ineligible.
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [lift("0001-01-01T00:00:00Z")] }, "0000-12-31T23:59:59.999999Z")).toBe(false);
  });

  it.each([
    ["1879-12-31T19:03:58.1231-04:56:02", "1880-01-01T00:00:00.123100Z"],
    ["1900-01-01T05:21:10.1231+05:21:10", "1900-01-01T00:00:00.123100Z"],
    ["10000-01-01T00:00:00.1231+00:00", "+010000-01-01T00:00:00.123100Z"],
    ["294000-01-01T00:00:00.1231+00:00", "+294000-01-01T00:00:00.123100Z"],
    ["0002-12-31T19:03:58.1231-04:56:02 BC", "0000-01-01T00:00:00.123100Z"],
    ["0002-01-01T00:00:00.1231+00:00 BC", "-000001-01-01T00:00:00.123100Z"],
    ["10000-02-29T00:00:00.1231+02:00", "+010000-02-28T22:00:00.123100Z"],
    ["9999-12-31T23:59:59.1231-00:00:02", "+010000-01-01T00:00:01.123100Z"],
  ])("normalizes %s exactly", (input, expected) => {
    expect(moderationInstantToIso(input)).toBe(expected);
    expect(moderationInstantToIso(expected)).toBe(expected);
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [lift(input)] }, expected)).toBe(true);
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [lift(input)] }, expected.replace("123100", "123099"))).toBe(false);
  });

  it("distinguishes a one-microsecond lift at a large positive epoch", () => {
    const event = lift("9999-12-31T00:00:00.123101Z");
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [event] }, "9999-12-31T00:00:00.123100Z")).toBe(false);
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [event] }, event.occurredAt)).toBe(true);
  });

  it("orders distinct microseconds chronologically in both UUID assignments", () => {
    for (const [decisionId, liftId] of [[highId, lowId], [lowId, highId]]) {
      const events = [
        lift("2026-10-12T00:00:00.123900Z", liftId),
        { ...lift("2026-10-12T00:00:00.123100Z", decisionId), newState: "RECALIBRATING" as const },
      ];
      expect(isParticipationEligibleAt({ ...user, moderationEvents: events }, "2026-10-12T00:00:01.000Z")).toBe(true);
    }
    expect(isParticipationEligibleAt(user, "invalid")).toBe(false);
    expect(isParticipationEligibleAt(user, "2026-10-12T00:00:00Z")).toBe(true);
    expect(isParticipationEligibleAt({ ...user, enforcementState: "BANNED", moderationEvents: [lift("invalid")] }, "2026-10-12T00:00:00Z")).toBe(false);
    expect(isParticipationEligibleAt({ ...user, enforcementState: "BANNED", moderationEvents: [lift("2026-10-12T00:00:00Z", "")] }, "2026-10-12T00:00:00Z")).toBe(false);
  });

  it("distinguishes a later microsecond from an equal millisecond and uses ids only for exact ties", () => {
    const at = "2026-10-12T00:00:00.123Z";
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [lift("2026-10-12T00:00:00.123900Z")] }, at)).toBe(false);
    for (const occurredAt of [at, "2026-10-12T00:00:00.123000Z"]) {
      expect(isParticipationEligibleAt({ ...user, moderationEvents: [lift(occurredAt)] }, at)).toBe(true);
    }
    const sanction = { ...lift("2026-10-12T02:00:00.123000+02:00", highId), newState: "BANNED" as const };
    const tied = { ...user, moderationEvents: [sanction, lift(at)] };
    expect(isParticipationEligibleAt(tied, at)).toBe(false);
    // Before every event, the earliest (time, id) supplies prior_state.
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [sanction, { ...lift(at), priorState: "ACTIVE" }] }, "2026-10-12T00:00:00.122999Z")).toBe(true);
  });

  it("normalizes PostgreSQL's zero-to-six fractional digits and session offsets to UTC microseconds", () => {
    const cases = [
      ["2026-10-12T00:00:00Z", "2026-10-12T00:00:00.000000Z"],
      ["2026-10-12T00:00:00.1Z", "2026-10-12T00:00:00.100000Z"],
      ["2026-10-12T00:00:00.12Z", "2026-10-12T00:00:00.120000Z"],
      ["2026-10-12T00:00:00.123Z", "2026-10-12T00:00:00.123000Z"],
      ["2026-10-12T00:00:00.1231Z", "2026-10-12T00:00:00.123100Z"],
      ["2026-10-12T00:00:00.12310Z", "2026-10-12T00:00:00.123100Z"],
      ["2026-10-12T00:00:00.123100+00:00", "2026-10-12T00:00:00.123100Z"],
      ["2026-10-12T02:00:00.1231+02:00", "2026-10-12T00:00:00.123100Z"],
      ["2026-10-11T18:30:00.123100-05:30", "2026-10-12T00:00:00.123100Z"],
    ];
    for (const [input, expected] of cases) {
      expect(moderationInstantToIso(input!)).toBe(expected);
      expect(moderationEventsFromJson([lift(input!)])[0]!.occurredAt).toBe(expected);
    }
    expect(moderationInstantToIso(new Date("2026-10-12T00:00:00.123Z"))).toBe("2026-10-12T00:00:00.123000Z");
    expect(moderationEventsFromJson([])).toEqual([]);
    for (const invalid of [null, {}, [null], ["event"], [{ ...lift("invalid"), id: 1 }], [{ ...lift("invalid"), priorState: "INVALID" }], [{ ...lift("invalid"), newState: "INVALID" }], [{ ...lift("invalid"), occurredAt: null }]]) {
      expect(() => moderationEventsFromJson(invalid)).toThrow("Moderation history was invalid.");
    }
    for (const invalid of ["invalid", new Date(NaN)]) {
      expect(() => moderationEventsFromJson([{ ...lift("unused"), occurredAt: invalid }])).toThrow("Timestamp was invalid.");
    }
  });

  it("retains microseconds before the Unix epoch as well as after it", () => {
    const event = lift("1969-12-31T23:59:59.999900Z");
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [event] }, "1969-12-31T23:59:59.999100Z")).toBe(false);
    expect(isParticipationEligibleAt({ ...user, moderationEvents: [event] }, event.occurredAt)).toBe(true);
  });
});
