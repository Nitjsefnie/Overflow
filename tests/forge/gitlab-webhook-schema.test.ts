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
 * project id — never by the numeric id alone.
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

describe("GitLab webhook delivery classification", () => {
  it("classifies a merge_request payload as deliberately ignored, not invalid", () => {
    // The hook is installed with merge request events too, but MR evidence is
    // read fresh per issue reconciliation; a merge that closes an issue moves
    // the issue itself, whose delivery does the invalidating. The route must
    // answer 2xx so the instance's delivery log stays green on this traffic.
    expect(parseGitLabWebhookDeliveryDetailed("Merge Request Hook", "uuid-2", payload({
      object_kind: "merge_request",
      object_attributes: { ...issueAttributes, action: "merge" },
    }))).toEqual({ status: "ignored" });
  });

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
