import { describe, expect, it } from "vitest";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";

/**
 * Dual-edit tripwire for the fold revision, mirroring the migrations-list
 * discipline in tests/db/schema.test.ts. Every fold suite imports FOLD_REVISION
 * and compares against it, so a revision that drifts leaves all of them green:
 * this file is the only place the literal itself is pinned. The custom failure
 * message carries the bump rule because a bare numeric toBe is defeated by the
 * very reader it exists to stop — they see a number fail, update the number,
 * and move on.
 */
describe("FOLD_REVISION pin", () => {
  it("holds the pinned literal so a fold revision bump cannot land silently", () => {
    expect(
      FOLD_REVISION,
      `FOLD_REVISION no longer matches the pinned literal: the constant in
src/lib/fold/fold-revision.ts changed without this test changing with it. Stop
before touching either number.

The bump rule (from the header comment on FOLD_REVISION): bump the revision only
when a change alters what the fold would write for input that did not change.
Never bump for refactors, comments, or unrelated edits.

Before changing the pin, re-check that the fold's written output for unchanged
input really did change. A bump is not bookkeeping: it arms a full re-derive of
derived rows below the revision — postgres-store rewrites every row whose
fold_revision is below FOLD_REVISION, and the rederivation service drives that
re-derive. The 2→3 bump recovered two previously rejected settlements.

If the bump is deliberate, update the pinned literal in this test in the same
change. If it is not deliberate, restore the constant in
src/lib/fold/fold-revision.ts.`,
    ).toBe(3);
  });
});
