import { describe, expect, it } from "vitest";
import { SESSION_MAX_AGE_SECONDS, isSessionExpired } from "@/lib/auth/session-guard";

/**
 * The absolute session lifetime (issue 1043): a session's use must not extend
 * it past the 30 days the privacy notice states. `isSessionExpired` is the
 * boundary the jwt refresh applies before anything else, so its edges are
 * pinned here — one second inside the window survives, the window's own edge
 * does not, and a token whose sign-in instant is missing or unusable counts as
 * expired (fail-closed: a pre-fix token carries no instant at all, and that is
 * exactly the cookie issue 1043 is about).
 */

const DAY_SECONDS = 24 * 60 * 60;
/** The issue's observed token instant, as good a clock reading as any other. */
const nowSec = 1_791_157_201;

describe("SESSION_MAX_AGE_SECONDS", () => {
  it("is the 30 days the privacy notice states, in seconds", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * DAY_SECONDS);
  });
});

describe("isSessionExpired", () => {
  it("keeps a token whose sign-in is one second inside the 30-day window", () => {
    expect(isSessionExpired(nowSec - (SESSION_MAX_AGE_SECONDS - 1), nowSec)).toBe(false);
  });

  it("keeps a token whose sign-in is 29 days old", () => {
    expect(isSessionExpired(nowSec - 29 * DAY_SECONDS, nowSec)).toBe(false);
  });

  it("expires a token at exactly the 30-day boundary", () => {
    expect(isSessionExpired(nowSec - SESSION_MAX_AGE_SECONDS, nowSec)).toBe(true);
  });

  it("expires a token one second past the boundary", () => {
    expect(isSessionExpired(nowSec - SESSION_MAX_AGE_SECONDS - 1, nowSec)).toBe(true);
  });

  it("keeps a token signed in now", () => {
    expect(isSessionExpired(nowSec, nowSec)).toBe(false);
  });

  it("keeps a token whose sign-in instant lies a second in the future", () => {
    expect(isSessionExpired(nowSec + 1, nowSec)).toBe(false);
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "null", value: null },
    { label: "a string", value: String(nowSec) },
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
    { label: "negative infinity", value: Number.NEGATIVE_INFINITY },
  ])("expires a token whose sign-in instant is $label", ({ value }) => {
    expect(isSessionExpired(value, nowSec)).toBe(true);
  });
});
