import { describe, expect, it } from "vitest";
import {
  parseGitLabWebhookDelivery,
  parseGitLabWebhookDeliveryDetailed,
} from "@/lib/gitlab/webhook-schema";

/**
 * The GitLab issue payload maps into the delivery vocabulary the shared
 * processor already speaks: subject ISSUE, the raw issue view, and a delivery
 * id namespaced with `gitlab:` so it can never collide with a GitHub delivery
 * guid. The repository is resolved by forge identity — provider + instance +
 * project id — never by the numeric id alone. A merge request payload maps
 * the same way onto a PULL_REQUEST subject with no issue view, so an MR
 * approval, merge or edit that moves no issue still invalidates the MR's own
 * subject instead of waiting for the periodic sweep.
 */

const project = {
  id: 278964,
  name: "GitLab",
  path_with_namespace: "gitlab-org/gitlab",
  web_url: "https://gitlab.com/gitlab-org/gitlab",
};

const issueAttributes = {
  id: 301,
  iid: 23,
  title: "Broken widget",
  description: "The widget is broken",
  state: "opened",
  updated_at: "2026-09-08T10:00:00.000Z",
  url: "https://gitlab.com/gitlab-org/gitlab/-/issues/23",
  action: "update",
};

function payload(overrides: Record<string, unknown> = {}, attributeOverrides: Record<string, unknown> = {}) {
  return {
    object_kind: "issue",
    event_type: "issue",
    project,
    object_attributes: { ...issueAttributes, ...attributeOverrides },
    changes: {},
    ...overrides,
  };
}

function parse(payloadValue: unknown, deliveryUuid = "uuid-1") {
  return parseGitLabWebhookDelivery("Issue Hook", deliveryUuid, payloadValue);
}

describe("GitLab webhook issue delivery", () => {
  it("maps an issue payload onto the shared delivery vocabulary with the forge identity", () => {
    expect(parse(payload())).toEqual({
      deliveryId: "gitlab:uuid-1",
      event: "issues",
      action: "edited",
      repositoryGitHubId: 278964,
      repositoryFullName: "gitlab-org/gitlab",
      subject: { kind: "ISSUE", id: 301, number: 23 },
      issue: {
        state: "OPEN",
        updatedAt: "2026-09-08T10:00:00.000Z",
        title: "Broken widget",
        body: "The widget is broken",
        url: "https://gitlab.com/gitlab-org/gitlab/-/issues/23",
      },
      forge: { provider: "gitlab", instanceUrl: "https://gitlab.com" },
    });
  });

  it.each([
    { action: "open", github: "opened" },
    { action: "close", github: "closed" },
    { action: "reopen", github: "reopened" },
    { action: "update", github: "edited" },
  ])("maps the GitLab issue action $action onto $github", ({ action, github }) => {
    const delivery = parse(payload({}, { action, state: action === "close" ? "closed" : "opened" }));
    expect(delivery?.action).toBe(github);
    expect(delivery?.issue?.state).toBe(action === "close" ? "CLOSED" : "OPEN");
  });

  it("normalizes a web_url with a path, upper-case host or trailing elements to the instance base", () => {
    const delivery = parse(payload({
      project: { ...project, web_url: "https://GitLab.Example.COM:8443/group/proj" },
    }));
    expect(delivery?.forge?.instanceUrl).toBe("https://gitlab.example.com:8443");
  });

  it("keeps a null description as an empty body", () => {
    const delivery = parse(payload({}, { description: null }));
    expect(delivery?.issue?.body).toBe("");
  });

  it.each([
    { name: "no object_kind", body: { project, object_attributes: issueAttributes } },
    { name: "unknown object_kind", body: payload({ object_kind: "push" }) },
    { name: "no project", body: { object_kind: "issue", object_attributes: issueAttributes } },
    { name: "project without id", body: { ...payload(), project: { ...project, id: 0 } } },
    { name: "project without path", body: { ...payload(), project: { ...project, path_with_namespace: "" } } },
    { name: "missing web_url", body: { ...payload(), project: { id: 1, path_with_namespace: "g/p" } } },
    { name: "unparsable web_url", body: { ...payload(), project: { ...project, web_url: "not a url" } } },
    { name: "no object_attributes", body: { object_kind: "issue", project } },
    { name: "subject id zero", body: payload({}, { id: 0 }) },
    { name: "subject iid non-integer", body: payload({}, { iid: 2.5 }) },
    { name: "unaccepted state", body: payload({}, { state: "merged" }) },
    { name: "unparsable updated_at", body: payload({}, { updated_at: "yesterday" }) },
    { name: "offset-naive updated_at", body: payload({}, { updated_at: "2026-09-08T10:00:00" }) },
    { name: "missing title", body: payload({}, { title: undefined }) },
    { name: "non-string description", body: payload({}, { description: 4 }) },
    { name: "unparsable url", body: payload({}, { url: "ftp://gitlab.com/x" }) },
    { name: "missing url", body: payload({}, { url: undefined }) },
    { name: "unknown action", body: payload({}, { action: "sparkle" }) },
    { name: "empty action", body: payload({}, { action: "  " }) },
  ])("rejects $name", ({ body }) => {
    expect(parse(body)).toBeNull();
  });

  it("rejects a missing delivery uuid", () => {
    expect(parseGitLabWebhookDelivery("Issue Hook", null, payload())).toBeNull();
    expect(parseGitLabWebhookDelivery("Issue Hook", "   ", payload())).toBeNull();
  });
});

const mergeRequestAttributes = {
  id: 401,
  iid: 7,
  title: "Fix widget",
  description: null,
  state: "merged",
  updated_at: "2026-09-08T11:00:00.000Z",
  url: "https://gitlab.com/gitlab-org/gitlab/-/merge_requests/7",
  action: "merge",
};

function mergeRequestPayload(attributeOverrides: Record<string, unknown> = {}) {
  return {
    object_kind: "merge_request",
    event_type: "merge_request",
    project,
    object_attributes: { ...mergeRequestAttributes, ...attributeOverrides },
    changes: {},
  };
}

function parseMergeRequest(payloadValue: unknown, deliveryUuid = "uuid-mr") {
  return parseGitLabWebhookDeliveryDetailed("Merge Request Hook", deliveryUuid, payloadValue);
}

describe("GitLab webhook merge request delivery", () => {
  it("maps a merge request payload onto a PULL_REQUEST subject with no issue view", () => {
    // Strict equality: the delivery must carry no `issue` key at all, since the
    // processor applies the issue view only for ISSUE subjects.
    expect(parseMergeRequest(mergeRequestPayload())).toStrictEqual({
      status: "ok",
      delivery: {
        deliveryId: "gitlab:uuid-mr",
        event: "pull_request",
        action: "closed",
        repositoryGitHubId: 278964,
        repositoryFullName: "gitlab-org/gitlab",
        subject: { kind: "PULL_REQUEST", id: 401, number: 7 },
        forge: { provider: "gitlab", instanceUrl: "https://gitlab.com" },
      },
    });
  });

  it.each([
    { action: "open", event: "pull_request", github: "opened" },
    { action: "reopen", event: "pull_request", github: "reopened" },
    { action: "update", event: "pull_request", github: "edited" },
    { action: "close", event: "pull_request", github: "closed" },
    { action: "merge", event: "pull_request", github: "closed" },
    { action: "approved", event: "pull_request_review", github: "submitted" },
    { action: "approval", event: "pull_request_review", github: "submitted" },
    { action: "unapproved", event: "pull_request_review", github: "dismissed" },
    { action: "unapproval", event: "pull_request_review", github: "dismissed" },
  ])("maps the GitLab merge request action $action onto $event/$github", ({ action, event, github }) => {
    const result = parseMergeRequest(mergeRequestPayload({ action }));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.delivery.event).toBe(event);
    expect(result.delivery.action).toBe(github);
    // The subject id is the MR's global id and the number its iid: that is the
    // pair the GitLab gateway records in closingPullRequests, and the fold
    // matches dirty PULL_REQUEST subjects against the PR's id.
    expect(result.delivery.subject).toEqual({ kind: "PULL_REQUEST", id: 401, number: 7 });
    expect("issue" in result.delivery).toBe(false);
  });

  it.each([
    { name: "an unknown action", body: mergeRequestPayload({ action: "sparkle" }) },
    { name: "an empty action", body: mergeRequestPayload({ action: "  " }) },
    { name: "a missing iid", body: mergeRequestPayload({ iid: undefined }) },
    { name: "a non-integer iid", body: mergeRequestPayload({ iid: 2.5 }) },
    { name: "a subject id of zero", body: mergeRequestPayload({ id: 0 }) },
    { name: "no object_attributes", body: { object_kind: "merge_request", project } },
    { name: "no project", body: { object_kind: "merge_request", object_attributes: mergeRequestAttributes } },
    { name: "an unparsable project web_url", body: { ...mergeRequestPayload(), project: { ...project, web_url: "not a url" } } },
  ])("classifies a merge request payload with $name as invalid", ({ body }) => {
    expect(parseMergeRequest(body)).toEqual({ status: "invalid" });
  });

  it("classifies a missing delivery uuid as invalid", () => {
    expect(parseMergeRequest(mergeRequestPayload(), "   ")).toEqual({ status: "invalid" });
  });
});

describe("GitLab webhook delivery classification", () => {
  it("classifies an unrecognised object_kind as invalid", () => {
    expect(parseGitLabWebhookDeliveryDetailed("Push Hook", "uuid-3", payload({ object_kind: "push" }))).toEqual({
      status: "invalid",
    });
  });

  it("classifies a missing event header or uuid as invalid", () => {
    expect(parseGitLabWebhookDeliveryDetailed(null, "uuid-4", payload())).toEqual({ status: "invalid" });
    expect(parseGitLabWebhookDeliveryDetailed("", "uuid-4", payload())).toEqual({ status: "invalid" });
    expect(parseGitLabWebhookDeliveryDetailed("Issue Hook", null, payload())).toEqual({ status: "invalid" });
  });
});
