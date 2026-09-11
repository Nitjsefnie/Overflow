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
 * through the linked PAT, no webhook creation, claimPath permanently
 * NOT_CHECKED (contract item 30), and the forge columns stored for the first
 * time. The GitHub path is untouched — its suite stays authoritative for it.
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
} = {}) {
  const calls: { op: string; args: unknown }[] = [];
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
      return {
        id: "repo-row-1",
        githubRepositoryId: repository.githubRepositoryId,
        ownerName: repository.ownerName,
        sponsorId: repository.sponsorId,
        visibility: repository.visibility,
        githubWebhookId: repository.githubWebhookId,
      };
    },
  } as unknown as RepositoryRegistrationStore;

  const gitlabFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    // Host-sensitive by construction: a gateway built on any other instance
    // must not be able to satisfy the lookup through this transport.
    if (new URL(request.url).origin !== "https://gitlab.com") {
      return new Response("wrong instance", { status: 404 });
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
    webhook: { callbackUrl: "https://overflow.example/api/github/webhooks", secret: "s3cret" },
    forgeFetch: gitlabFetch,
    forgeIdentity: options.linkedIdentity === undefined
      ? { instanceUrl: "https://gitlab.com", token: "glpat-live" }
      : options.linkedIdentity,
  };
  return { dependencies, calls, gitlabFetch };
}

describe("GitLab repository registration", () => {
  it("registers without a webhook, storing the forge columns and NOT_CHECKED claim path", async () => {
    const f = fixture();
    const result = await registerRepository(f.dependencies, input());

    expect(result.claimPath).toBe("NOT_CHECKED");
    expect(result.githubWebhookId).toBeNull();
    expect(result.ownerName).toBe("gitlab-org/gitlab");
    const creation = f.calls.find((call) => call.op === "createRepository");
    expect(creation).toBeDefined();
    const args = creation!.args as { githubWebhookId: number | null; provider?: string; instanceUrl?: string; forgeProjectId?: number };
    expect(args.githubWebhookId).toBeNull();
    expect(args.provider).toBe("gitlab");
    expect(args.instanceUrl).toBe("https://gitlab.com");
    expect(args.forgeProjectId).toBe(278964);
    // A GitLabGateway was built with the linked PAT: prove it by the requests
    // it made being the project lookup and the labels read, nothing GitHub.
    expect(f.dependencies.github).toBeInstanceOf(GitHubGateway);
    expect(f.dependencies.github).toBeDefined();
    expect(f.calls.every((call) => call.op !== "createWebhook")).toBe(true);
  });

  it("refuses when the submitter has no verified identity on the instance", async () => {
    const f = fixture({ linkedIdentity: null });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
  });

  it("refuses when the linked identity is for a different instance", async () => {
    const f = fixture({ linkedIdentity: { instanceUrl: "https://other.example.com", token: "glpat-x" } });
    await expect(registerRepository(f.dependencies, input())).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "FORBIDDEN",
    });
  });

  it("refuses a GitLab submission without the forge fields", async () => {
    const f = fixture();
    await expect(registerRepository(f.dependencies, input({ instanceUrl: undefined }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(registerRepository(f.dependencies, input({ project: undefined }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("refuses with NOT_FOUND when the project id is unreachable through the linked PAT", async () => {
    const f = fixture();
    // The fixture's transport answers 404 for any project other than the
    // gitlab-org/gitlab path, so a numeric id nothing vouches for refuses.
    await expect(registerRepository(f.dependencies, input({ project: "99999999" }))).rejects.toMatchObject({
      name: "RepositoryRegistrationError",
      code: "NOT_FOUND",
    });
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
    expect(f.calls.find((call) => call.op === "createRepository")).toBeDefined();
    const creation = f.calls.find((call) => call.op === "createRepository")!;
    expect((creation.args as { githubWebhookId: number | null }).githubWebhookId).toBe(9001);
  });
});
