import { describe, expect, it } from "vitest";

import { isTrustedProducerRun } from "../../scripts/ledger-relay.ts";

/**
 * The trusted-producer allowlist, extracted verbatim from
 * tests/scripts/ledger-relay.test.ts so that file can stay under its
 * tests-family line ceiling while its mint-body pin gains the issue-1051
 * permissions object.
 */
describe("isTrustedProducerRun", () => {
  // The allowlist of runs whose executed workflow definition is the base
  // branch's. pull_request_target runs the base branch's definition whatever
  // the head branch is called; push, workflow_dispatch and schedule run the
  // definition at the ref they name, which is the protected one only when that
  // ref is main; every other event, and any event not listed, is refused.
  it.each([
    ["pull_request_target", "main", true],
    ["pull_request_target", "feature/some-branch", true],
    ["pull_request_target", "", true],
    ["push", "main", true],
    ["push", "feature/some-branch", false],
    ["push", "", false],
    ["workflow_dispatch", "main", true],
    ["workflow_dispatch", "feature/some-branch", false],
    ["schedule", "main", true],
    ["schedule", "feature/some-branch", false],
    ["pull_request", "main", false],
    ["pull_request", "feature/some-branch", false],
    ["issue_comment", "main", false],
    ["issue_comment", "feature/some-branch", false],
    ["pull_request_review", "main", false],
    ["pull_request_review_comment", "main", false],
    ["merge_group", "main", false],
    ["workflow_run", "main", false],
    ["", "main", false],
    ["", "", false],
    ["some_future_event", "main", false],
    // Near misses: the comparison is exact, never a prefix or a case fold.
    ["Push", "main", false],
    ["push", "Main", false],
    ["push", "refs/heads/main", false],
    ["push", "main ", false],
    ["pull_request_target ", "main", false],
  ])("event %j on head branch %j is trusted: %s", (event, headBranch, expected) => {
    expect(isTrustedProducerRun(event, headBranch)).toBe(expected);
  });
});
