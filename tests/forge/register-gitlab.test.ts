import { describe, expect, it } from "vitest";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { GitHubGateway } from "@/lib/github/client";
import { GitLabApiError } from "@/lib/gitlab/client";
import {
  registerRepository,
  type NewRegisteredRepository,
  type RepositoryRegistrationDependencies,
  type RepositoryRegistrationInput,
  type RepositoryRegistrationStore,
} from "@/lib/repositories/register";

/**
 * The GitLab registration path: verified identity required, project lookup
 * through the linked PAT, a project hook installed with the shared webhook
 * secret (issue 547), the hook id stored in the dual-use webhook-id column,
 * the initial import queued through the same reconciliation job the GitHub
 * path uses, the issue-451 compensating cleanup on a failed save, and a
 * permanently NOT_CHECKED claim path (contract item 30). The GitHub path is
 * untouched — its suite stays authoritative for it.
 */

const project = {
  id: 278964,
  name: "gitlab",
  path: "gitlab",
  path_with_namespace: "gitlab-org/gitlab",
  visibility: "public",
  web_url: "https://gitlab.com/gitlab-org/gitlab",
  namespace: { id: 1, name: "GitLab.org", path: "gitlab-org", kind: "group" },
  permissions: { project_access: { access_level: 40 } },
};

const scheme = validDifficultyScheme();
const labelsFixture = [
  ...scheme.openingLabels.map((entry) => entry.label),
  ...scheme.actualLabels.map((entry) => entry.label),
];

function input(overrides: Partial<RepositoryRegistrationInput> = {}): RepositoryRegistrationInput {
  return {
    repositoryUrl: "https://gitlab.com/gitlab-org/gitlab",
    openingName: "size",
    actualName: "delivered",
    openingLabels: scheme.openingLabels,
    actualLabels: scheme.actualLabels,
    provider: "gitlab",
    instanceUrl: "https://gitlab.com",
    project: "gitlab-org/gitlab",
    ...overrides,
  };
}

function fixture(options: {
  linkedIdentity?: { instanceUrl: string; token: string } | null;
  existingProvider?: string | null;
  /** Merged over the served project payload, so a case varies exactly the fields its refusal is about. */
  projectOverrides?: Record<string, unknown>;
  /** The status the instance answers the hook POST with; absent means a created hook (id 4242). */
  hookCreationStatus?: number;
  /** The status the instance answers the hook DELETE with; absent means proven gone. */
  hookDeletionStatus?: number;
  /** "throw" raises a store outage, "null" answers the on-conflict arbiter's decline. */
  storeFailure?: "throw" | "null";
} = {}) {
  const calls: { op: string; args: unknown }[] = [];
  const hookRequests: Request[] = [];
  const scheduledRepositoryIds: string[] = [];
  const abandonedSaves: unknown[] = [];
  const abandonedClears: unknown[] = [];
  const order: string[] = [];
  const store: RepositoryRegistrationStore = {
    async findRepositoryByGitHubId() {
      return null;
    },
    async findRepositoryProviderById() {
      return options.existingProvider ?? null;
    },
    async findRepositoryRegistrationState() {
      return null;
    },
    async createRepository(repository: NewRegisteredRepository) {
      calls.push({ op: "createRepository", args: repository });
      if (options.storeFailure === "throw") {
        throw new Error("save failed: connection refused");
      }
      if (options.storeFailure === "null") {
        return null;
      }
      return {
        id: "repo-row-1",
        githubRepositoryId: repository.githubRepositoryId,
        ownerName: repository.ownerName,
        sponsorId: repository.sponsorId,
        visibility: repository.visibility,
        githubWebhookId: repository.githubWebhookId,
      };
    },
    async saveAbandonedWebhookCleanup(record: Parameters<RepositoryRegistrationStore["saveAbandonedWebhookCleanup"]>[0]) {
      order.push("save");
      abandonedSaves.push(record);
    },
    async listAbandonedWebhookCleanups() {
      return [];
    },
    async clearAbandonedWebhookCleanup(githubRepositoryId: number, provider: "github" | "gitlab", webhookId: number) {
      abandonedClears.push({ githubRepositoryId, provider, webhookId });
    },
    async findGitLabWebhookTargetByOwnerName() {
      return null;
    },
  } as unknown as RepositoryRegistrationStore;

  const gitlabFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // Host-sensitive by construction: a gateway built on any other instance
    // must not be able to satisfy the lookup through this transport.
    if (new URL(request.url).origin !== "https://gitlab.com") {
      return new Response("wrong instance", { status: 404 });
    }
    if (request.url.includes("/hooks")) {
      hookRequests.push(request);
      if (request.method === "DELETE") order.push("delete");
      if (request.method === "POST") {
        if (options.hookCreationStatus !== undefined) {
          return new Response("hook refused", { status: options.hookCreationStatus });
        }
        return new Response(JSON.stringify({ id: 4242 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (options.hookDeletionStatus !== undefined) {
        return new Response("delete refused", { status: options.hookDeletionStatus });
      }
      return new Response(null, { status: 204 });
    }
    if (request.url.includes("/labels")) {
      return new Response(JSON.stringify(labelsFixture.map((name) => ({ name }))), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (request.url.includes("/projects/gitlab-org%2Fgitlab")) {
      return new Response(JSON.stringify({ ...project, ...options.projectOverrides }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("no route", { status: 404 });
  };

  const dependencies: RepositoryRegistrationDependencies = {
    actor: { id: "sponsor-1", role: "MEMBER" },
    github: new GitHubGateway({ accessToken: "gho-unused", fetch: async () => {
      throw new Error("the GitHub gateway must not be called on the GitLab path");
    } }),
    store,
    webhook: { callbackUrl: "https://overflow.example/api/gitlab/webhooks" },
    forgeFetch: gitlabFetch,
    forgeIdentity: options.linkedIdentity === undefined
      ? { instanceUrl: "https://gitlab.com", token: "glpat-live" }
      : options.linkedIdentity,
    async scheduleInitialImport(repositoryId: string) {
      scheduledRepositoryIds.push(repositoryId);
    },
  };
  return { dependencies, calls, hookRequests, scheduledRepositoryIds, abandonedSaves, abandonedClears, order, gitlabFetch };
}

describe("GitLab repository registration", () => {
  it("sends a scoped callback and token matching the persisted credential", async () => {
    const f = fixture();
    f.dependencies.webhook.callbackUrl += "?deployment=test";
    await registerRepository(f.dependencies, input());
    const body = await f.hookRequests[0]!.json() as { url: string; token: string };
    const callback = new URL(body.url);
    expect(callback.searchParams.get("hook")).not.toBeNull();
    expect(callback.searchParams.get("hook")).toMatch(/^[0-9a-f-]{36}$/);
    expect(callback.searchParams.get("deployment")).toBe("test");
    expect(callback.pathname).toBe("/api/gitlab/webhooks");
    expect(Buffer.from(body.token, "base64url")).toHaveLength(32);
    expect(f.calls.find((call) => call.op === "createRepository")!.args).toMatchObject({
      webhookCredential: { id: callback.searchParams.get("hook"), secret: body.token },
    });
  });

  it("installs a project hook, stores its id, and queues the initial import", async () => {
    const f = fixture();
    const result = await registerRepository(f.dependencies, input());

    expect(result.claimPath).toBe("NOT_CHECKED");
    expect(result.githubWebhookId).toBe(4242);
    expect(result.ownerName).toBe("gitlab-org/gitlab");
    expect(result.initialImportScheduled).toBe(true);
    expect(f.scheduledRepositoryIds).toEqual(["repo-row-1"]);

    // The hook POST: the GitLab receiver's URL, the shared secret as the hook
    // token, and exactly the event flags the gateway installs.
    expect(f.hookRequests).toHaveLength(1);
    const hookPost = f.hookRequests[0]!;
    expect(`${hookPost.method} ${new URL(hookPost.url).pathname}`).toBe("POST /api/v4/projects/gitlab-org%2Fgitlab/hooks");
    expect(hookPost.headers.get("authorization")).toBe("Bearer glpat-live");
    const hookBody = JSON.parse(await hookPost.text()) as Record<string, unknown>;
    expect(hookBody).toMatchObject({
      url: expect.stringMatching(/^https:\/\/overflow\.example\/api\/gitlab\/webhooks\?hook=[0-9a-f-]{36}$/),
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      issue_events: true,
      merge_requests_events: true,
      push_events: false,
    });

    const creation = f.calls.find((call) => call.op === "createRepository");
    expect(creation).toBeDefined();
    const args = creation!.args as { githubWebhookId: number | null; provider?: string; instanceUrl?: string; forgeProjectId?: number };
    // The dual use of the webhook-id column (issue 547): the GitLab hook id
    // lives in the same column, with the forge columns carrying the rest.
    expect(args.githubWebhookId).toBe(4242);
    expect(args.provider).toBe("gitlab");
    expect(args.instanceUrl).toBe("https://gitlab.com");
    expect(args.forgeProjectId).toBe(278964);
    expect(f.dependencies.github).toBeInstanceOf(GitHubGateway);
  });

  it("reports an honestly failed initial-import schedule without undoing the registration", async () => {
    const f = fixture();
    f.dependencies.scheduleInitialImport = async () => {
      throw new Error("the queue is unreachable");
    };
    const result = await registerRepository(f.dependencies, input());
    expect(result.githubWebhookId).toBe(4242);
    expect(result.initialImportScheduled).toBe(false);
  });

  it("refuses when the submitter has no verified identity on the instance", async () => {
    const f = fixture({ linkedIdentity: null });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
    expect(f.hookRequests).toEqual([]);
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("refuses when the linked identity is for a different instance", async () => {
    const f = fixture({ linkedIdentity: { instanceUrl: "https://other.example.com", token: "glpat-x" } });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
    expect(f.hookRequests).toEqual([]);
  });

  it("refuses a GitLab submission without the forge fields", async () => {
    const f = fixture();
    await expect(registerRepository(f.dependencies, input({ instanceUrl: undefined }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(registerRepository(f.dependencies, input({ project: undefined }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(f.hookRequests).toEqual([]);
  });

  it("refuses with NOT_FOUND when the project id is unreachable through the linked PAT", async () => {
    const f = fixture();
    // The fixture's transport answers 404 for any project other than the
    // gitlab-org/gitlab path, so a numeric id nothing vouches for refuses.
    await expect(registerRepository(f.dependencies, input({ project: "99999999" }))).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "NOT_FOUND",
    });
    expect(f.hookRequests).toEqual([]);
  });

  it("refuses with NOT_FOUND when the project path names no visible project", async () => {
    const f = fixture();
    // The fixture's transport answers 404 for any path other than
    // gitlab-org/gitlab, so a path nothing vouches for must refuse exactly as
    // the id branch refuses — not with the raw GitLabApiError the route's
    // catch-all would read as an upstream failure.
    await expect(registerRepository(f.dependencies, input({ project: "ghost-org/ghost" }))).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "NOT_FOUND",
      message: "No GitLab project with that path is visible through the linked identity.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("surfaces a non-404 GitLab failure on the path lookup as the upstream failure it is", async () => {
    const f = fixture();
    // Replace the transport so the path-addressed project lookup answers 500.
    const originalFetch = f.dependencies.forgeFetch;
    f.dependencies.forgeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/projects/") && !url.includes("/labels")) {
        return new Response("upstream detonation", { status: 500 });
      }
      return originalFetch!(input, init);
    };
    const error = await registerRepository(f.dependencies, input({ project: "ghost-org/ghost" }))
      .then(() => null, (thrown: unknown) => thrown);
    // The 404 mapping must not swallow real upstream failures: a 500 does not
    // answer "this path names no visible project", so the raw GitLabApiError
    // is rethrown and the route's catch-all answers 502 UPSTREAM_FAILURE.
    expect(error).toBeInstanceOf(GitLabApiError);
    expect((error as GitLabApiError).status).toBe(500);
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("refuses a private project as FORBIDDEN before anything is stored", async () => {
    const f = fixture({ projectOverrides: { visibility: "private" } });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only public GitLab projects can be registered.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
    expect(f.hookRequests).toEqual([]);
  });

  it("refuses an internal project with the same refusal — the gateway maps internal to PRIVATE", async () => {
    const f = fixture({ projectOverrides: { visibility: "internal" } });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only public GitLab projects can be registered.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("refuses a project the linked identity cannot maintain (direct access below Maintainer)", async () => {
    const f = fixture({ projectOverrides: { permissions: { project_access: { access_level: 30 } } } });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "GitLab maintainer permission is required for the submitted project.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("refuses a member below Maintainer on both the project and its group", async () => {
    const f = fixture({
      projectOverrides: {
        permissions: { project_access: { access_level: 30 }, group_access: { access_level: 30 } },
      },
    });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "GitLab maintainer permission is required for the submitted project.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("refuses a project reporting no access at all", async () => {
    const f = fixture({ projectOverrides: { permissions: { project_access: null, group_access: null } } });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "GitLab maintainer permission is required for the submitted project.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("runs the visibility refusal before the conflict checks", async () => {
    // A private project whose forge id a GitHub row already holds answers the
    // visibility refusal, proving the checks sit before the conflict reads —
    // and before anything is stored.
    const f = fixture({ projectOverrides: { visibility: "private" }, existingProvider: "github" });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "Only public GitLab projects can be registered.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("runs the maintainer refusal before the conflict checks", async () => {
    // The maintainer half of the same ordering: a project the linked identity
    // cannot maintain, whose forge id a GitHub row already holds, answers the
    // maintainer refusal — not the cross-forge conflict the id would raise.
    const f = fixture({
      projectOverrides: { permissions: { project_access: { access_level: 30 } } },
      existingProvider: "github",
    });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
      message: "GitLab maintainer permission is required for the submitted project.",
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("registers a public project whose Maintainer right is inherited from the group", async () => {
    // GitLab reports a group Maintainer as project_access null with the
    // Maintainer level on group_access; refusing that identity would be a
    // false refusal of a real maintainer.
    const f = fixture({
      projectOverrides: { permissions: { project_access: null, group_access: { access_level: 40 } } },
    });
    const result = await registerRepository(f.dependencies, input());
    expect(result.ownerName).toBe("gitlab-org/gitlab");
    expect(f.calls.find((call) => call.op === "createRepository")).toBeDefined();
  });

  it("registers a public project where the identity holds direct Owner access", async () => {
    const f = fixture({ projectOverrides: { permissions: { project_access: { access_level: 50 } } } });
    const result = await registerRepository(f.dependencies, input());
    expect(result.ownerName).toBe("gitlab-org/gitlab");
    expect(f.calls.find((call) => call.op === "createRepository")).toBeDefined();
  });

  it("refuses a GitLab registration whose forge id is already held by a GitHub row", async () => {
    // An unregistered GitHub row under the same numeric id would be silently
    // re-pointed by the on-conflict insert, re-folding GitHub-era settlements
    // against a GitLab project. The refusal names the collision.
    const f = fixture({ existingProvider: "github" });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "CONFLICT",
      message: /collides with forge id .* provider 'github'/,
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("rejects a malformed numeric project id before any gateway call", async () => {
    const f = fixture();
    await expect(registerRepository(f.dependencies, input({ project: "0" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(registerRepository(f.dependencies, input({ project: "-4" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(registerRepository(f.dependencies, input({ project: "12abc" }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(f.hookRequests).toEqual([]);
  });

  it("refuses a GitHub registration whose forge id is already held by a GitLab row", async () => {
    // The reverse direction: a GitHub submission may not take over an id a
    // GitLab registration has held, even unregistered — the row's forge
    // history never migrates.
    const f = fixture({ existingProvider: "gitlab" });
    const githubFetch = async (req: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(req, init);
      if (request.url.endsWith("/repos/octo/repo")) {
        return new Response(JSON.stringify({
          id: 278964, name: "repo", full_name: "octo/repo", private: false,
          html_url: "https://github.com/octo/repo", owner: { login: "octo", type: "Organization" },
          permissions: { admin: true },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.url.includes("/labels")) {
        return new Response(JSON.stringify(labelsFixture.map((name) => ({ name }))), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("no route", { status: 404 });
    };
    const dependencies: RepositoryRegistrationDependencies = {
      ...f.dependencies,
      github: new GitHubGateway({ accessToken: "gho-token", fetch: githubFetch }),
    };
    await expect(registerRepository(dependencies, {
      repositoryUrl: "octo/repo",
      openingName: scheme.openingName,
      actualName: scheme.actualName,
      openingLabels: scheme.openingLabels,
      actualLabels: scheme.actualLabels,
    })).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "CONFLICT",
      message: /collides with forge id .* provider 'gitlab'/,
    });
    expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
  });

  it("still registers GitHub submissions exactly as before", async () => {
    const f = fixture({ linkedIdentity: null });
    const githubFetch = async (req: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(req, init);
      if (request.url.endsWith("/repos/octo/repo")) {
        return new Response(JSON.stringify({
          id: 501, name: "repo", full_name: "octo/repo", private: false,
          html_url: "https://github.com/octo/repo", owner: { login: "octo", type: "Organization" },
          permissions: { admin: true },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (request.url.includes("/labels")) {
        return new Response(JSON.stringify(labelsFixture.map((name) => ({ name }))), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (request.method === "POST" && request.url.includes("/hooks")) {
        return new Response(JSON.stringify({ id: 9001 }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (request.url.includes("/contents/.github")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("no route", { status: 404 });
    };
    const githubGateway = new GitHubGateway({ accessToken: "gho-token", fetch: githubFetch });
    const dependencies: RepositoryRegistrationDependencies = {
      ...f.dependencies,
      github: githubGateway,
    };
    const result = await registerRepository(dependencies, {
      repositoryUrl: "octo/repo",
      openingName: "size",
      actualName: "delivered",
      openingLabels: scheme.openingLabels,
      actualLabels: scheme.actualLabels,
    });
    expect(result.githubWebhookId).toBe(9001);
    expect(result.initialImportScheduled).toBe(true);
    expect(f.calls.find((call) => call.op === "createRepository")).toBeDefined();
    const creation = f.calls.find((call) => call.op === "createRepository")!;
    expect((creation.args as { githubWebhookId: number | null }).githubWebhookId).toBe(9001);
  });

  describe("hook creation refusals", () => {
    it.each([
      { status: 401, code: "GITHUB_CREDENTIALS" },
      { status: 403, code: "GITHUB_ACCESS" },
      { status: 404, code: "GITHUB_ACCESS" },
      { status: 429, code: "GITHUB_RATE_LIMITED" },
      { status: 500, code: "UPSTREAM_FAILURE" },
    ])("maps a GitLab $status on hook creation through the catalog as $code", async ({ status, code }) => {
      const f = fixture({ hookCreationStatus: status });
      await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
        name: "RepositoryRegistrationError",
        code,
      });
      expect(f.calls.some((call) => call.op === "createRepository")).toBe(false);
    });
  });

  describe("the compensating cleanup on a failed save (issue 451 pattern)", () => {
    it("records the hook with provider gitlab and the instance URL before deleting, and clears it when proven", async () => {
      const f = fixture({ storeFailure: "throw" });
      // The GitLab transport answers the compensating DELETE with 404 — the
      // hook is proven gone — so the save failure itself surfaces.
      f.dependencies.forgeFetch = async (req, init) => {
        const request = new Request(req, init);
        if (request.method === "DELETE" && request.url.includes("/hooks")) {
          f.order.push("delete");
          return new Response(null, { status: 404 });
        }
        return f.gitlabFetch(req, init);
      };

      await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
        code: "UPSTREAM_FAILURE",
        message: "Unable to save the repository registration.",
      });
      expect(f.abandonedSaves).toEqual([{
        githubRepositoryId: 278964,
        ownerName: "gitlab-org/gitlab",
        webhookId: 4242,
        createdAt: expect.any(String),
        provider: "gitlab",
        instanceUrl: "https://gitlab.com",
      }]);
      // The issue-451 ordering: the record is durable BEFORE the compensating
      // deletion is attempted, so the hook id survives every failure shape.
      expect(f.order.slice(0, 2)).toEqual(["save", "delete"]);
      expect(f.abandonedClears).toEqual([{ githubRepositoryId: 278964, provider: "gitlab", webhookId: 4242 }]);
    });

    it("answers ROLLBACK_INCOMPLETE when the compensating deletion is refused without a 404", async () => {
      const f = fixture({ storeFailure: "throw", hookDeletionStatus: 500 });
      await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
        code: "ROLLBACK_INCOMPLETE",
        message: "The repository registration could not be saved, and the project webhook Overflow created for it "
          + "could not be deleted on GitLab. Nothing was registered; retry the registration, and a later "
          + "successful registration or unregistration removes the abandoned webhook.",
      });
      // The record stays: the drain owns the orphaned hook from here.
      expect(f.abandonedSaves).toHaveLength(1);
      expect(f.abandonedClears).toEqual([]);
    });

    it("abandons the created hook when the store's arbiter declines the save", async () => {
      const f = fixture({ storeFailure: "null", hookDeletionStatus: 404 });
      await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
        code: "CONFLICT",
        message: "This GitLab project is already registered.",
      });
      expect(f.abandonedSaves).toHaveLength(1);
      expect(f.abandonedClears).toEqual([{ githubRepositoryId: 278964, provider: "gitlab", webhookId: 4242 }]);
    });
  });
});
