import { describe, expect, it } from "vitest";
import {
  parseGitHubWebhookDelivery,
  parseGitHubWebhookDeliveryDetailed,
  type GitHubWebhookParseResult,
} from "@/lib/github/webhook-schema";

const issue = {
  id: 201, number: 11, state: "closed", updated_at: "2026-09-08T10:00:00Z",
  title: "Changed title", body: null, html_url: "https://github.com/octo/example/issues/11",
};

describe("webhook issue views", () => {
  it.each(["issues", "issue_comment"])("retains validated raw fields for %s", (event) => {
    expect(parse(event, issue)).toMatchObject({
      subject: { kind: "ISSUE", id: 201, number: 11 },
      issue: { state: "CLOSED", updatedAt: "2026-09-08T10:00:00Z", title: "Changed title",
        body: "", url: "https://github.com/octo/example/issues/11" },
    });
  });

  it.each([
    { state: "merged" }, { state: undefined }, { updated_at: undefined },
    { updated_at: "yesterday" }, { updated_at: "2026-02-30T10:00:00Z" },
    { updated_at: "2026-09-08T10:00:00" }, { title: 4 }, { title: undefined },
    { body: {} }, { body: undefined }, { html_url: "not a URL" }, { html_url: undefined },
  ])("rejects malformed issue fields %j", (changes) => {
    expect(parse("issues", { ...issue, ...changes })).toBeNull();
  });

  it.each(["issues", "issue_comment"])("drops %s PR envelopes without enqueueing a subject", (event) => {
    // A PR envelope's issue-surface id is not the PR database id, so there is
    // no subject this parser may enqueue for it; the PR's own lifecycle events
    // carry the true id.
    expect(parse(event, { ...issue, pull_request: { url: "https://api.github.com/repos/octo/example/pulls/11" } })).toBeNull();
  });

  it.each(["issues", "issue_comment"])("drops a %s PR envelope even when its issue view is malformed", (event) => {
    // The pull_request field decides the drop before the view is read, so a
    // malformed view must not resurrect the envelope as a bare subject.
    expect(parse(event, {
      ...issue, title: undefined,
      pull_request: { url: "https://api.github.com/repos/octo/example/pulls/11" },
    })).toBeNull();
  });
});

describe("webhook delivery classification", () => {
  it.each(["issues", "issue_comment"])("classifies a PR-carrying %s envelope as ignored, not invalid", (event) => {
    // The pull_request field is a deliberate drop, not a malformed payload:
    // the route must answer 2xx so GitHub's delivery log does not turn red on
    // traffic Overflow chooses to ignore.
    expect(parseDetailed(event, { ...issue, pull_request: { url: "https://api.github.com/repos/octo/example/pulls/11" } })).toEqual({ status: "ignored" });
  });

  it.each(["issues", "issue_comment"])("classifies a PR-carrying %s envelope as ignored even when its issue view is malformed", (event) => {
    // The pull_request guard is checked before the issue view is read, so a
    // malformed view must not reclassify a deliberate drop as a rejection.
    expect(parseDetailed(event, {
      ...issue, title: undefined,
      pull_request: { url: "https://api.github.com/repos/octo/example/pulls/11" },
    })).toEqual({ status: "ignored" });
  });

  it("classifies a recognized-but-unmaterialized pull_request action as ignored, not invalid", () => {
    // ready_for_review arrives on a webhook subscribed event-grained to
    // pull_request, which cannot unsubscribe per-action. It is a deliberate
    // drop, not malformed traffic: the parser must answer ignored so the route
    // returns 2xx and GitHub's delivery log does not turn red on valid
    // deliveries Overflow chooses not to materialize.
    expect(parseGitHubWebhookDeliveryDetailed("pull_request", "delivery", {
      action: "ready_for_review",
      repository: { id: 42, full_name: "octo/example" },
      pull_request: { id: 201, number: 11 },
    })).toEqual({ status: "ignored" });
  });

  it("classifies a subject-less ready_for_review envelope as ignored, not invalid", () => {
    // The unmaterialized-action guard fires before subject parsing, so the
    // envelope's missing pull_request subject cannot reclassify the
    // deliberate drop as a rejection.
    expect(parseGitHubWebhookDeliveryDetailed("pull_request", "delivery", {
      action: "ready_for_review",
      repository: { id: 42, full_name: "octo/example" },
    })).toEqual({ status: "ignored" });
  });

  it.each([
    { label: "a PR field that is not an object", action: "edited", issue: { ...issue, pull_request: "not-an-object" } },
    { label: "a malformed action", issue: { ...issue }, action: "  " },
    { label: "a missing action", issue: { ...issue } },
    { label: "an unsupported event", event: "fork", action: "edited", issue: { ...issue } },
    { label: "a malformed subject", action: "edited", issue: { ...issue, id: 0 } },
    { label: "a malformed issue view on a PR-free envelope", action: "edited", issue: { ...issue, updated_at: "yesterday" } },
  ])("classifies $label as invalid", ({ event = "issues", issue: issueValue, action }) => {
    // Built directly (not via parseDetailed) so each row's action and issue
    // reach the parser unwrapped — a doubly-wrapped issue would fail the
    // subject branch and make every row green for the wrong reason. Rows
    // without an action omit the key outright: a destructuring default would
    // resurrect it as "edited" and the row would assert nothing.
    expect(parseGitHubWebhookDeliveryDetailed(event, "delivery", {
      ...(action === undefined ? {} : { action }),
      repository: { id: 42, full_name: "octo/example" }, issue: issueValue,
    })).toEqual({ status: "invalid" });
  });

  it("preserves the wrapper contract: ok yields the delivery, ignored and invalid yield null", () => {
    const ok = parseDetailed("issues", issue);
    expect(ok.status).toBe("ok");
    if (ok.status !== "ok") return;
    expect(parseGitHubWebhookDelivery("issues", "delivery", {
      action: "edited", repository: { id: 42, full_name: "octo/example" }, issue,
    })).toEqual(ok.delivery);
    expect(parseGitHubWebhookDelivery("issues", "delivery", {
      action: "edited", repository: { id: 42, full_name: "octo/example" },
      issue: { ...issue, pull_request: { url: "https://api.github.com/repos/octo/example/pulls/11" } },
    })).toBeNull();
    expect(parseGitHubWebhookDelivery("issues", "delivery", {
      action: "  ", repository: { id: 42, full_name: "octo/example" }, issue,
    })).toBeNull();
  });
});

function parseDetailed(event: string, value: unknown): GitHubWebhookParseResult {
  return parseGitHubWebhookDeliveryDetailed(event, "delivery", {
    action: event === "issues" ? "edited" : "created",
    repository: { id: 42, full_name: "octo/example" }, issue: value,
  });
}

function parse(event: string, value: unknown) {
  return parseGitHubWebhookDelivery(event, "delivery", {
    action: event === "issues" ? "edited" : "created",
    repository: { id: 42, full_name: "octo/example" }, issue: value,
  });
}
