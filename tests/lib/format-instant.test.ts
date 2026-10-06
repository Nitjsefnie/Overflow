import { describe, expect, it } from "vitest";
import { formatInstant, parseDateTimeLocalAsUtc } from "@/lib/format-instant";

describe("formatInstant", () => {
  it("renders a known UTC instant as YYYY-MM-DD HH:MM UTC", () => {
    expect(formatInstant("2026-10-05T14:30:00Z")).toBe("2026-10-05 14:30 UTC");
  });

  it("renders the UTC calendar date, not the runtime zone's, across a date boundary", () => {
    // 00:30Z is 2026-10-04 20:30 in America/New_York (a day behind UTC) and
    // 2026-10-05 02:30 in Europe/Berlin (the same day). Either way the UTC
    // date must win; the suite is also run under both zones as evidence.
    expect(formatInstant("2026-10-05T00:30:00Z")).toBe("2026-10-05 00:30 UTC");
  });

  it("names the zone in every output", () => {
    for (const instant of ["2026-01-01T00:00:00Z", "2026-06-15T23:59:00Z", "1999-12-31T23:59:59Z"]) {
      expect(formatInstant(instant).endsWith(" UTC")).toBe(true);
    }
  });

  it("renders the same instant identically from a string and a Date", () => {
    const instant = "2026-10-05T14:30:00Z";
    expect(formatInstant(new Date(instant))).toBe(formatInstant(instant));
  });

  it.each([
    ["not-a-date"],
    [""],
    ["2026-13-01T00:00:00Z"],
  ])("throws TypeError for the invalid instant %j", (invalid) => {
    expect(() => formatInstant(invalid)).toThrow(TypeError);
  });

  it("throws TypeError for an invalid Date", () => {
    expect(() => formatInstant(new Date("garbage"))).toThrow(TypeError);
  });
});

describe("parseDateTimeLocalAsUtc", () => {
  it("interprets a minute-precision datetime-local value as UTC", () => {
    expect(parseDateTimeLocalAsUtc("2026-10-05T00:00")).toBe("2026-10-05T00:00:00.000Z");
  });

  it("interprets a second-precision datetime-local value as UTC", () => {
    expect(parseDateTimeLocalAsUtc("2026-10-05T00:00:30")).toBe("2026-10-05T00:00:30.000Z");
  });

  it("accepts a fractional-second form and appends the UTC designator", () => {
    expect(parseDateTimeLocalAsUtc("2026-01-15T12:34:56.789")).toBe("2026-01-15T12:34:56.789Z");
  });

  it.each([
    ["not-a-date"],
    [""],
    ["2026-10-05"],
    ["2026-10-05 00:00"],
    ["2026-10-05T00:00:00.000123456"],
  ])("returns null for the value that does not parse (%j)", (garbage) => {
    expect(parseDateTimeLocalAsUtc(garbage)).toBe(null);
  });

  it("returns null for a value that already carries the UTC designator", () => {
    expect(parseDateTimeLocalAsUtc("2026-10-05T00:00:00Z")).toBe(null);
    expect(parseDateTimeLocalAsUtc("2026-10-05T00:00Z")).toBe(null);
  });

  it("returns null for a value carrying a numeric offset", () => {
    expect(parseDateTimeLocalAsUtc("2026-10-05T00:00:00+02:00")).toBe(null);
    expect(parseDateTimeLocalAsUtc("2026-10-05T00:00-05:00")).toBe(null);
  });

  it.each([
    ["2026-13-01T00:00"],
    ["2026-02-30T00:00"],
    ["2026-10-05T24:00"],
    ["2026-10-05T00:60"],
    ["2026-10-05T00:00:60"],
  ])("returns null for an out-of-range component instead of rolling over (%j)", (outOfRange) => {
    expect(parseDateTimeLocalAsUtc(outOfRange)).toBe(null);
  });
});
