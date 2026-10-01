import { describe, expect, it } from "vitest";
import {
  SESSION_RECOVERY_REASONS,
  toSessionRecoveryReason,
} from "@/lib/auth/session-recovery-reasons";

/**
 * The two halves of the member-page gate's contract with `/session`: the gate
 * writes one of these literals into the query string
 * (`src/lib/dashboard/session.ts`) and the recovery page reads it back through
 * this coercion (`src/app/session/page.tsx`). They share the declaration rather
 * than each spelling a word out, so the coercion is the only thing standing
 * between whatever the query string carried and the copy the visitor reads.
 *
 * It therefore accepts the declared literals and nothing else. A near-miss
 * arrives exactly the way an unknown one does — from a URL — and is read back as
 * the same state as a missing reason, so the case that matters is the one where a
 * value that is not a declared literal comes back as one. The gate's own redirect
 * targets are covered by `tests/dashboard/session.test.ts` and the rendered copy
 * by `tests/components/session-recovery.test.tsx`; neither can tell a rejected
 * literal from a falsy one, because both render the same fallback.
 */

describe("the session recovery reasons the gate declares", () => {
  it("declares exactly the two reasons, each named by its own literal", () => {
    expect({ ...SESSION_RECOVERY_REASONS }).toEqual({
      unavailable: "unavailable",
      stale: "stale",
    });
  });

  it("hands back the same literal it was given, for every reason it declares", () => {
    for (const reason of Object.values(SESSION_RECOVERY_REASONS)) {
      expect(toSessionRecoveryReason(reason)).toBe(reason);
    }
  });
});

describe("toSessionRecoveryReason", () => {
  it.each([
    { label: "a literal in the other case", value: "Unavailable" },
    { label: "a literal in upper case", value: "UNAVAILABLE" },
    { label: "a literal with trailing whitespace", value: "unavailable " },
    { label: "a literal with leading whitespace", value: " stale" },
    { label: "a literal with a newline appended", value: "stale\n" },
    { label: "a longer word that starts with a literal", value: "unavailability" },
    { label: "a longer word that starts with the other literal", value: "staleness" },
    { label: "a word no gate writes", value: "banana" },
    { label: "the empty string", value: "" },
    { label: "a reason with a separator", value: "reason=stale" },
    { label: "a reason as a number", value: 42 },
    { label: "a reason as a boolean", value: true },
    { label: "a reason as null", value: null },
    { label: "a reason as undefined", value: undefined },
    { label: "a reason as an object", value: { reason: "stale" } },
    { label: "a reason as an array", value: ["stale"] },
  ])("rejects $label", ({ value }) => {
    expect(toSessionRecoveryReason(value)).toBeUndefined();
  });
});
