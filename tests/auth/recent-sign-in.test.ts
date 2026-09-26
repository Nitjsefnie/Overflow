import { describe, expect, it } from "vitest";
import { isRecentSignIn } from "@/lib/auth/recent-sign-in";

describe("shared recent GitHub sign-in", () => {
  const now = 1_790_000_000_000;
  it.each([
    ["current", now / 1000, true],
    ["ten minutes old", (now - 600_000) / 1000, true],
    ["one millisecond too old", (now - 600_001) / 1000, false],
    ["within clock skew", (now + 60_000) / 1000, true],
    ["past clock skew", (now + 61_000) / 1000, false],
    ["absent", null, false],
  ])("classifies %s", (_label, authenticatedAt, expected) => {
    expect(isRecentSignIn(authenticatedAt, now)).toBe(expected);
  });
});
