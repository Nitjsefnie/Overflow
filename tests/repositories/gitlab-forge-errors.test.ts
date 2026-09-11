import { describe, expect, it } from "vitest";
import { GitLabApiError } from "@/lib/gitlab/client";
import { RepositoryRegistrationError } from "@/lib/repositories/register";
import { gitlabWebhookError } from "@/lib/repositories/gitlab-forge-errors";

/**
 * The GitLab webhook steps map onto the registration error catalog's existing
 * codes — the route's status mapping already answers them — with GitLab-named
 * messages. Every message names the step that failed and the remedy.
 */

describe("GitLab webhook errors through the registration catalog", () => {
  it.each([
    {
      status: 401,
      code: "GITHUB_CREDENTIALS",
      fragment: "GitLab rejected the linked identity's token (HTTP 401) while trying to create the project webhook.",
      remedy: "Relink your GitLab identity on the Ledger page, then retry registration.",
    },
    {
      status: 403,
      code: "GITHUB_ACCESS",
      fragment: "GitLab refused to create the project webhook (HTTP 403).",
      remedy: "then retry registration.",
    },
    {
      status: 404,
      code: "GITHUB_ACCESS",
      fragment: "GitLab answered 404 for the request to create the project webhook.",
      remedy: "then retry registration.",
    },
    {
      status: 429,
      code: "GITHUB_RATE_LIMITED",
      fragment: "GitLab rate-limited the request to create the project webhook (HTTP 429).",
      remedy: "Please retry registration later.",
    },
  ])("maps a GitLab $status on hook creation to $code", ({ status, code, fragment, remedy }) => {
    const error = gitlabWebhookError(new GitLabApiError(status), "create the project webhook", "registration");
    expect(error).toBeInstanceOf(RepositoryRegistrationError);
    expect(error.code).toBe(code);
    expect(error.message).toContain(fragment);
    expect(error.message).toContain(remedy);
  });

  it("maps a transport failure on hook creation to UPSTREAM_FAILURE", () => {
    const error = gitlabWebhookError(new GitLabApiError(0, "connection refused"), "create the project webhook", "registration");
    expect(error.code).toBe("UPSTREAM_FAILURE");
    expect(error.message).toBe("Unable to create the project webhook on GitLab.");
  });

  it("maps an unknown error to UPSTREAM_FAILURE", () => {
    expect(gitlabWebhookError(new Error("anything"), "create the project webhook", "registration").code).toBe("UPSTREAM_FAILURE");
  });

  it("carries the unregistration remedy for the delete step", () => {
    const error = gitlabWebhookError(new GitLabApiError(401), "delete the project webhook", "unregistration");
    expect(error.message).toContain("while trying to delete the project webhook.");
    expect(error.message).toContain("then retry unregistration.");
  });
});
