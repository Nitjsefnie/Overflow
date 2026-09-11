import { describe, expect, it, vi } from "vitest";
import { GitLabGateway } from "@/lib/gitlab/client";
import {
  deleteGitLabWebhookForUnregistration,
  type GitLabWebhookUnregistrationDependencies,
} from "@/lib/repositories/gitlab-unregister";

/**
 * The GitLab hook deletion an unregistration performs (issue 547, behavior
 * 3), against a store seam: forge-first (the deletion happens before any row
 * could be touched — the module holds no row-writing method at all), a GitLab
 * 404 reads as already absent, and every refusal leaves the row untouched by
 * throwing through the registration error catalog.
 */

type Target = {
  sponsorId: string;
  githubWebhookId: number | null;
  instanceUrl: string | null;
};

function fixture(options: {
  target?: Target | null;
  token?: string | null;
  deleteStatus?: number;
} = {}) {
  const requests: Request[] = [];
  const store = {
    findGitLabWebhookTargetByOwnerName: vi.fn().mockResolvedValue(
      options.target === undefined
        ? { sponsorId: "sponsor-1", githubWebhookId: 9001, instanceUrl: "https://gitlab.example.com" }
        : options.target,
    ),
    getForgeToken: vi.fn().mockResolvedValue(options.token !== undefined ? options.token : "glpat-live"),
  };
  const dependencies: GitLabWebhookUnregistrationDependencies = {
    store,
    createGateway: (instanceUrl, token) => new GitLabGateway({ instanceUrl, token, fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "DELETE") {
        return new Response(null, { status: options.deleteStatus ?? 204 });
      }
      return new Response("no route", { status: 404 });
    } }),
  };
  return { dependencies, store, requests };
}

const input = { ownerName: "gl-group/project", sponsorId: "sponsor-1" };

describe("the GitLab webhook deletion an unregistration performs", () => {
  it("deletes the hook through the sponsor's identity for the stored instance", async () => {
    const f = fixture();
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).resolves.toEqual({ kind: "DELETED" });
    expect(f.store.getForgeToken).toHaveBeenCalledWith("sponsor-1", "https://gitlab.example.com");
    expect(f.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "DELETE /api/v4/projects/gl-group%2Fproject/hooks/9001",
    ]);
    expect(f.requests[0]!.headers.get("authorization")).toBe("Bearer glpat-live");
  });

  it("reads a GitLab 404 as already absent, continuing with no deletion", async () => {
    const f = fixture({ deleteStatus: 404 });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).resolves.toEqual({ kind: "ALREADY_ABSENT" });
  });

  it("treats a pre-547 row without a hook id as already absent and reads no credential", async () => {
    const f = fixture({ target: { sponsorId: "sponsor-1", githubWebhookId: null, instanceUrl: "https://gitlab.example.com" } });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).resolves.toEqual({ kind: "ALREADY_ABSENT" });
    expect(f.store.getForgeToken).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it("refuses NOT_FOUND when no GitLab registration holds the path", async () => {
    const f = fixture({ target: null });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "NOT_FOUND",
      message: "No registration holds the GitLab path gl-group/project, so there is nothing to unregister.",
    });
    expect(f.store.getForgeToken).not.toHaveBeenCalled();
  });

  it("refuses FORBIDDEN for a foreign sponsor", async () => {
    const f = fixture({ target: { sponsorId: "someone-else", githubWebhookId: 9001, instanceUrl: "https://gitlab.example.com" } });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
    expect(f.store.getForgeToken).not.toHaveBeenCalled();
  });

  it("refuses with the credentials refusal when no identity is linked on the instance", async () => {
    const f = fixture({ token: null });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "GITHUB_CREDENTIALS",
      message: "A verified GitLab identity linked to this instance is required to unregister a GitLab repository. "
        + "Relink your GitLab identity on the Ledger page, then retry unregistration.",
    });
    expect(f.requests).toEqual([]);
  });

  it.each([
    { status: 403, code: "GITHUB_ACCESS", fragment: "then retry unregistration." },
    { status: 429, code: "GITHUB_RATE_LIMITED", fragment: "Please retry unregistration later." },
    { status: 500, code: "UPSTREAM_FAILURE", fragment: "Unable to delete the project webhook on GitLab." },
  ])("maps a GitLab $status on deletion through the catalog as $code", async ({ status, code, fragment }) => {
    const f = fixture({ deleteStatus: status });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, input)).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code,
      message: expect.stringContaining(fragment),
    });
  });

  it("refuses UPSTREAM_FAILURE for a stored path that cannot be a path with namespace", async () => {
    const f = fixture({ target: { sponsorId: "sponsor-1", githubWebhookId: 9001, instanceUrl: "https://gitlab.example.com" } });
    await expect(deleteGitLabWebhookForUnregistration(f.dependencies, {
      ownerName: "lone-segment", sponsorId: "sponsor-1",
    })).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "UPSTREAM_FAILURE",
      message: "The GitLab registration's stored path is not a path with namespace, so its project hook cannot be addressed.",
    });
    expect(f.requests).toEqual([]);
  });
});
