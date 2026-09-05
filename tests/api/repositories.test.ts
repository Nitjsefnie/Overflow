import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import type { RepositoryRegistrationDependencies } from "@/lib/repositories/register";
import { createRepositoryPostHandler } from "@/app/api/repositories/route";

describe("POST /api/repositories", () => {
  it("returns a structured 400 when the request does not contain exactly one repository configuration", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest({ repositories: ["octo/overflow"] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_REQUEST",
        message: "Invalid repository registration request.",
      },
    });
  });

  it("returns a structured 401 without a session", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => null,
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it("requires a session before validating a submitted repository payload", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => null,
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest({ repositories: ["octo/overflow"] }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it("returns a structured 403 for a signed-in user without GitHub administrator permission", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "member-id", role: "MEMBER" } }),
      createRegistrationDependencies: async (session) =>
        successfulDependencies(session.user, { canAdminister: false }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "GitHub administrator permission is required for the submitted repository.",
      },
    });
  });

  it("returns a structured 409 when the submitted repository is already registered", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async (session) =>
        successfulDependencies(session.user, { existingRepository: true }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: "CONFLICT", message: "This GitHub repository is already registered." },
    });
  });

  it("returns a structured 502 without exposing a GitHub failure", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async (session) =>
        successfulDependencies(session.user, { webhookFailure: true }),
    });

    const response = await handler(jsonRequest(validInput()));
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: {
        code: "UPSTREAM_FAILURE",
        message: "Unable to create the repository webhook on GitHub.",
      },
    });
    expect(JSON.stringify(body)).not.toContain("access-token-should-not-leak");
  });

  it("returns actionable JSON with HTTP 403 when GitHub denies organization webhook access", async () => {
    const dependencies = successfulDependencies();
    const requests: string[] = [];
    dependencies.github = new GitHubGateway({
      accessToken: "access-token-should-not-leak",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
        if (url.pathname.endsWith("/hooks")) {
          return new Response("private-body access-token-should-not-leak", {
            status: 403,
            headers: { "x-private": "private-header" },
          });
        }
        if (url.pathname.endsWith("/labels")) {
          return Response.json([...validInput().openingLabels, ...validInput().actualLabels].map(({ label }) => ({ name: label })));
        }
        return Response.json({
          id: 42,
          name: "overflow",
          full_name: "Actual-Org/overflow",
          private: false,
          html_url: "https://github.com/Actual-Org/overflow",
          owner: { login: "Actual-Org", type: "Organization" },
          permissions: { admin: true },
        });
      },
    });
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ error: {
      code: "GITHUB_ACCESS",
      message: "GitHub refused to create the repository webhook (HTTP 403). This can happen when the Overflow OAuth application is not approved for that organization. Ask an organization owner to approve it at https://github.com/organizations/Actual-Org/settings/oauth_application_policy. Review Overflow's authorization at https://github.com/settings/applications, then retry registration.",
    } });
    expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
    expect(requests).toEqual([
      "GET /repos/octo/overflow",
      "GET /repos/octo/overflow/labels",
      "POST /repos/octo/overflow/hooks",
    ]);
  });

  it.each([
    [403, "GitHub refused to retrieve the submitted GitHub repository (HTTP 403)."],
    [404, "GitHub answered 404 for the request to retrieve the submitted GitHub repository. GitHub returns 404 rather than 403 when it will not reveal a resource, so the usual cause is missing authorization. The repository may also have been renamed, moved or deleted."],
  ] as const)("returns actionable HTTP 403 for a lookup HTTP %s failure", async (status, observation) => {
    const dependencies = successfulDependencies();
    dependencies.github = failingGitHubGateway("lookup", status);
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: {
      code: "GITHUB_ACCESS",
      message: `${observation} This may be caused by missing authorization for the Overflow OAuth application. For an organization-owned repository, an organization owner may additionally need to approve the Overflow application under the organization's third-party application access policy. Review Overflow's authorization at https://github.com/settings/applications, then retry registration.`,
    } });
  });

  describe.each([
    ["lookup", "retrieve the submitted GitHub repository"],
    ["labels", "configure difficulty labels"],
    ["webhook", "create the repository webhook"],
  ] as const)("%s rate-limit responses", (step, description) => {
    it.each([
      [403, { "x-ratelimit-remaining": "0", "retry-after": "60" }, " Retry after 60 seconds."],
      [500, { "x-ratelimit-remaining": "0" }, ""],
      [429, {}, ""],
    ] satisfies Array<[number, Record<string, string>, string]>)("returns HTTP 429 for GitHub HTTP %s", async (status, headers, delay) => {
      const dependencies = successfulDependencies();
      dependencies.github = failingGitHubGateway(step, status, headers);
      const handler = createRepositoryPostHandler({
        getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
        createRegistrationDependencies: async () => dependencies,
      });

      const response = await handler(jsonRequest(validInput()));
      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body).toEqual({ error: {
        code: "GITHUB_RATE_LIMITED",
        message: `GitHub rate-limited the request to ${description} (HTTP ${status}).${delay} Please retry registration later.`,
      } });
      expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header|OAuth|oauth_application_policy/);
    });
  });

  it("describes a user-owned webhook 404 as hidden or missing rather than denied", async () => {
    const dependencies = successfulDependencies();
    dependencies.github = failingGitHubGateway("webhook", 404, {}, "User");
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: {
      code: "GITHUB_ACCESS",
      message: "GitHub answered 404 for the request to create the repository webhook. GitHub returns 404 rather than 403 when it will not reveal a resource, so the usual cause is missing authorization. The repository may also have been renamed, moved or deleted since it was looked up. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry registration.",
    } });
  });

  it("returns the registered repository after a successful explicit registration", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async (session) => successfulDependencies(session.user),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      repository: {
        id: "repository-id",
        githubRepositoryId: 42,
        ownerName: "octo/overflow",
        sponsorId: "moderator-id",
        visibility: "PUBLIC",
        githubWebhookId: 501,
      },
      existingWorkIngested: true,
    });
  });

  it("reports that existing work was not ingested when reconciliation fails", async () => {
    const handler = createRepositoryPostHandler({
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async (session) => ({
        ...successfulDependencies(session.user),
        reconcile: async () => {
          throw new Error("GitHub reconciliation failed");
        },
      }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      repository: { ownerName: "octo/overflow" },
      existingWorkIngested: false,
    });
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("https://overflow.example/api/repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validInput() {
  return {
    repositoryUrl: "https://github.com/octo/overflow.git",
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "size/S", comparisonPoints: 2, reservePoints: 2 },
      { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
      { label: "size/L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

type SuccessfulDependenciesOptions = {
  canAdminister?: boolean;
  existingRepository?: boolean;
  webhookFailure?: boolean;
};

function successfulDependencies(
  actor: { id: string; role: "MEMBER" | "MODERATOR" } = {
    id: "moderator-id",
    role: "MODERATOR",
  },
  options: SuccessfulDependenciesOptions = {},
): RepositoryRegistrationDependencies {
  return {
    actor,
    github: {
      async getRepository() {
        return {
          id: 42,
          owner: "octo",
          ownerType: "USER",
          name: "overflow",
          fullName: "octo/overflow",
          visibility: "PUBLIC",
          url: "https://github.com/octo/overflow",
          canAdminister: options.canAdminister ?? true,
        };
      },
      async ensureDifficultyLabels() {},
      async createWebhook() {
        if (options.webhookFailure) {
          throw new Error("upstream access-token-should-not-leak");
        }
        return { id: 501 };
      },
      async deleteWebhook() {},
    },
    store: {
      async findRepositoryByGitHubId() {
        return options.existingRepository
          ? {
              id: "repository-id",
              githubRepositoryId: 42,
              ownerName: "octo/overflow",
              sponsorId: "moderator-id",
              visibility: "PUBLIC" as const,
              githubWebhookId: 501,
            }
          : null;
      },
      async createRepository() {
        return {
          id: "repository-id",
          githubRepositoryId: 42,
          ownerName: "octo/overflow",
          sponsorId: "moderator-id",
          visibility: "PUBLIC",
          githubWebhookId: 501,
        };
      },
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
      secret: "webhook-secret-for-test",
    },
    async reconcile() {
      return { adds: 0, changes: 0, removals: 0 };
    },
  };
}

function failingGitHubGateway(
  step: "lookup" | "labels" | "webhook",
  status: number,
  headers: Record<string, string> = {},
  ownerType = "Organization",
): GitHubGateway {
  return new GitHubGateway({
    accessToken: "access-token-should-not-leak",
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      const requestedStep = pathname.endsWith("/hooks") ? "webhook" : pathname.endsWith("/labels") ? "labels" : "lookup";
      if (requestedStep === step) {
        return new Response("private-body access-token-should-not-leak", {
          status,
          headers: { ...headers, "x-private": "private-header" },
        });
      }
      if (requestedStep === "labels") {
        return Response.json([...validInput().openingLabels, ...validInput().actualLabels].map(({ label }) => ({ name: label })));
      }
      return Response.json({
        id: 42,
        name: "overflow",
        full_name: "Actual-Owner/overflow",
        private: false,
        html_url: "https://github.com/Actual-Owner/overflow",
        owner: { login: "Actual-Owner", type: ownerType },
        permissions: { admin: true },
      });
    },
  });
}
