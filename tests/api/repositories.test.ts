import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  expectNoDependencyCall,
  foreignOrigin,
  guardedRequests,
  requestHost,
  trustedOrigin,
  useTrustedOrigin,
} from "../support/trusted-origin";
import { createGitHubGraphqlBudgetStore } from "@/lib/github/rate-limit-budget";
import { GitHubApiError } from "@/lib/github/errors";
import { GitHubGateway } from "@/lib/github/client";
import { POST as mintToken } from "@/app/api/tokens/route";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import type { ApiTokenAccount } from "@/lib/tokens/postgres-store";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import type { RepositoryRouteDependencies, RepositoryRouteSession } from "@/app/api/repositories/route";

import {
  RepositoryRegistrationEnforcementError,
  RepositoryRegistrationError,
  RepositorySchemeChangeForbiddenError,
  RepositorySchemeChangeOrderError,
  type RegisteredRepository,
  type RepositoryCatalogChange,
  type RepositoryRegistrationDependencies,
  type RepositoryUnregisterOutcome,
} from "@/lib/repositories/register";
import {
  POST,
  createRepositoryDeleteHandler,
  createRepositoryPostHandler,
  createRepositoryPatchHandler,
} from "@/app/api/repositories/route";

const { readSession } = vi.hoisted(() => ({ readSession: vi.fn() }));
vi.mock("@/auth", () => ({ auth: readSession }));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));

useTrustedOrigin();

beforeEach(() => {
  readSession.mockReset().mockResolvedValue(null);
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});

// A test whose subject legitimately emits server-side output (the abandoned-webhook
// diagnostic, issue 451) names the method here before acting and the teardown skips it.
const consoleOutputAllowed = new Set<string>();

afterEach(() => {
  try {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      if (!consoleOutputAllowed.has(method)) {
        expect(console[method]).not.toHaveBeenCalled();
      }
    }
  } finally {
    consoleOutputAllowed.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

// Issue 97: the ambiguous 403 message states the ambiguity explicitly and ranks the
// wait-and-retry remedy before the authorization settings remedies.
const ambiguitySentence = "GitHub answers 403 both when the Overflow OAuth application is not yet authorized and when it is temporarily limiting requests, and this response carries nothing that separates the two causes.";
const waitInstruction = "Wait a minute and retry registration before changing anything.";
const ambiguous403Advice = `${ambiguitySentence} ${waitInstruction}`;

describe("POST /api/repositories", () => {
  it("returns a structured 400 when the request does not contain exactly one repository configuration", async () => {
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
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
      findAccountByTokenHash: async () => null,
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
      findAccountByTokenHash: async () => null,
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
      findAccountByTokenHash: async () => null,
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
      findAccountByTokenHash: async () => null,
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
      findAccountByTokenHash: async () => null,
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

  it("returns a structured 503 when the save failed and the compensating webhook deletion failed too", async () => {
    consoleOutputAllowed.add("error");
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async (session) =>
        successfulDependencies(session.user, {
          createRepositoryError: new Error("database connectivity failure"),
          deleteWebhookError: new GitHubApiError(500),
        }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "ROLLBACK_INCOMPLETE",
        message: "The repository registration could not be saved, and the webhook Overflow created for it "
          + "could not be deleted on GitHub. Nothing was registered; retry the registration, and a later "
          + "successful registration or unregistration removes the abandoned webhook.",
      },
    });
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
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ error: {
      code: "GITHUB_ACCESS",
      message: `GitHub refused to create the repository webhook (HTTP 403). ${ambiguous403Advice} This can happen when the Overflow OAuth application is not approved for that organization. Ask an organization owner to approve it at https://github.com/organizations/Actual-Org/settings/oauth_application_policy. Review Overflow's authorization at https://github.com/settings/applications, then retry registration.`,
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
    [404, "GitHub answered 404 for the request to retrieve the submitted GitHub repository. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted."],
  ] as const)("returns actionable HTTP 403 for a lookup HTTP %s failure", async (status, observation) => {
    const dependencies = successfulDependencies();
    dependencies.github = failingGitHubGateway("lookup", status);
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: {
      code: "GITHUB_ACCESS",
      message: `${observation} ${status === 403 ? `${ambiguous403Advice} ` : ""}This may be caused by missing authorization for the Overflow OAuth application. For an organization-owned repository, an organization owner may additionally need to approve the Overflow application under the organization's third-party application access policy. Review Overflow's authorization at https://github.com/settings/applications, then retry registration.`,
    } });
  });

  describe.each([
    ["lookup", "retrieve the submitted GitHub repository", "Unable to retrieve the submitted GitHub repository."],
    ["labels", "read the repository difficulty labels", "Unable to read the repository difficulty labels on GitHub."],
    ["webhook", "create the repository webhook", "Unable to create the repository webhook on GitHub."],
  ] as const)("%s HTTP failure classification through the real gateway", (step, description, upstreamMessage) => {
    it.each([
      [401, {}, "GITHUB_CREDENTIALS", 401, ""],
      [503, { "retry-after": "60", "x-ratelimit-remaining": "4999" }, "UPSTREAM_FAILURE", 502, ""],
      [500, { "retry-after": "60" }, "UPSTREAM_FAILURE", 502, ""],
      [500, { "x-ratelimit-remaining": "0" }, "UPSTREAM_FAILURE", 502, ""],
      [403, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", 429, " Retry after 60 seconds."],
      [403, { "x-ratelimit-remaining": "0" }, "GITHUB_RATE_LIMITED", 429, ""],
      [403, {}, "GITHUB_ACCESS", 403, ""],
      [429, {}, "GITHUB_RATE_LIMITED", 429, ""],
    ] satisfies Array<[number, Record<string, string>, string, number, string]>)("classifies GitHub HTTP %s with %j as %s / HTTP %s", async (status, headers, code, responseStatus, delay) => {
      const dependencies = successfulDependencies();
      dependencies.github = failingGitHubGateway(step, status, headers);
      const handler = createRepositoryPostHandler({
        findAccountByTokenHash: async () => null,
        getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
        createRegistrationDependencies: async () => dependencies,
      });

      const response = await handler(jsonRequest(validInput()));
      expect(response.status).toBe(responseStatus);
      const body = await response.json();
      expect(body.error.code).toBe(code);
      if (code === "UPSTREAM_FAILURE") {
        expect(body.error.message).toBe(upstreamMessage);
      } else if (code === "GITHUB_RATE_LIMITED") {
        expect(body.error.message).toBe(`GitHub rate-limited the request to ${description} (HTTP ${status}).${delay} Please retry registration later.`);
      } else if (code === "GITHUB_CREDENTIALS") {
        expect(body.error.message).toBe(
          `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to ${description}. `
            + "To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry registration.",
        );
      } else {
        expect(body.error.message).toContain(`GitHub refused to ${description} (HTTP 403).`);
        expect(body.error.message).toContain("https://github.com/settings/applications");
      }
      expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
      if (code !== "GITHUB_ACCESS") {
        expect(JSON.stringify(body)).not.toMatch(/OAuth|oauth_application_policy/);
      }
    });
  });

  // Issue 97's repro shape at the route: a 403 secondary rate limit arrives with nonzero
  // remaining budget, no Retry-After, and the marker in the body, so only the body separates
  // it from an authorization refusal — the route must answer it as HTTP 429 either way.
  const secondaryRateLimitBody = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
  describe.each([
    ["lookup", "retrieve the submitted GitHub repository"],
    ["labels", "read the repository difficulty labels"],
    ["webhook", "create the repository webhook"],
  ] as const)("%s secondary rate limit with remaining budget through the real gateway", (step, description) => {
    it.each(["Organization", "User"] as const)("answers a %s-owned HTTP 403 marker body as GITHUB_RATE_LIMITED and HTTP 429", async (ownerType) => {
      const dependencies = successfulDependencies();
      dependencies.github = failingGitHubGateway(step, 403, { "x-ratelimit-remaining": "4999" }, ownerType, secondaryRateLimitBody);
      const handler = createRepositoryPostHandler({
        findAccountByTokenHash: async () => null,
        getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
        createRegistrationDependencies: async () => dependencies,
      });

      const response = await handler(jsonRequest(validInput()));
      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.code).toBe("GITHUB_RATE_LIMITED");
      expect(body.error.message).toBe(`GitHub rate-limited the request to ${description} (HTTP 403). Please retry registration later.`);
      expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
      expect(JSON.stringify(body)).not.toMatch(/settings\/applications|oauth_application_policy/);
    });
  });

  describe.each(["lookup", "labels", "webhook"] as const)("%s ambiguous 403 ordering", (step) => {
    it.each([
      ["Organization", 403, { "x-ratelimit-remaining": "4999" }, "GITHUB_ACCESS", 403],
      ["User", 403, { "x-ratelimit-remaining": "4999" }, "GITHUB_ACCESS", 403],
      ["Organization", 404, {}, "GITHUB_ACCESS", 403],
      ["User", 404, {}, "GITHUB_ACCESS", 403],
      ["Organization", 403, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", 429],
      ["User", 403, { "retry-after": "60" }, "GITHUB_RATE_LIMITED", 429],
    ] satisfies Array<[string, number, Record<string, string>, string, number]>)("handles %s HTTP %s with %j as %s", async (ownerType, status, headers, code, responseStatus) => {
      const dependencies = successfulDependencies();
      dependencies.github = failingGitHubGateway(step, status, headers, ownerType);
      const handler = createRepositoryPostHandler({
        findAccountByTokenHash: async () => null,
        getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
        createRegistrationDependencies: async () => dependencies,
      });

      const response = await handler(jsonRequest(validInput()));
      expect(response.status).toBe(responseStatus);
      const body = await response.json();
      expect(body.error.code).toBe(code);
      const message = body.error.message as string;
      if (status === 403 && code === "GITHUB_ACCESS") {
        // The ambiguous 403 names the ambiguity and puts wait-and-retry before every
        // settings URL instead of ranking authorization first (issue 97).
        expect(message).toContain(ambiguitySentence);
        expect(message).toContain(waitInstruction);
        expect(message.indexOf(waitInstruction)).toBeLessThan(message.indexOf("https://github.com/settings/applications"));
        // The org policy URL is only in the message once the repository — and its owner —
        // was resolved; the lookup step fails before that, so guard on its presence.
        if (message.includes("oauth_application_policy")) {
          expect(message.indexOf(waitInstruction)).toBeLessThan(message.indexOf("oauth_application_policy"));
        }
      } else {
        // The 404 branch keeps its message unchanged, and a classified throttle carries
        // none of the ambiguous-403 framing.
        expect(message).not.toContain(ambiguitySentence);
        expect(message).not.toContain(waitInstruction);
        if (status === 404) {
          expect(message.endsWith("Review Overflow's authorization at https://github.com/settings/applications, then retry registration.")).toBe(true);
        }
      }
      expect(JSON.stringify(body)).not.toMatch(/access-token-should-not-leak|private-body|private-header/);
    });
  });

  it("describes a user-owned webhook 404 as hidden or missing rather than denied", async () => {
    const dependencies = successfulDependencies();
    dependencies.github = failingGitHubGateway("webhook", 404, {}, "User");
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: {
      code: "GITHUB_ACCESS",
      message: "GitHub answered 404 for the request to create the repository webhook. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted since it was looked up. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry registration.",
    } });
  });

  it("returns the registered repository after a successful explicit registration", async () => {
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
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
      initialImportScheduled: true,
      claimPath: "NO_EVIDENCE_FOUND",
    });
  });

  it.each(["EVIDENCE_FOUND", "NOT_CHECKED"] as const)(
    "carries the service's %s claim-path verdict in the 201 response",
    async (claimPath) => {
      const dependencies = successfulDependencies();
      dependencies.github.listWorkflowFiles = async () => {
        if (claimPath === "NOT_CHECKED") {
          throw new Error("workflow read failed");
        }
        return [{
          path: ".github/workflows/claim.yml",
          content: "on: issue_comment\njobs:\n  claim:\n    steps:\n      - run: gh api repos/octo/overflow/issues/1/assignees -f assignees[]=contributor\n",
        }];
      };
      const handler = createRepositoryPostHandler({
        findAccountByTokenHash: async () => null,
        getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
        createRegistrationDependencies: async () => dependencies,
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
        initialImportScheduled: true,
        claimPath,
      });
    },
  );

  it("reports an unscheduled initial import when the enqueue fails", async () => {
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async (session) => ({
        ...successfulDependencies(session.user),
        scheduleInitialImport: async () => {
          throw new Error("the reconciliation job could not be enqueued");
        },
      }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      repository: { ownerName: "octo/overflow" },
      initialImportScheduled: false,
    });
  });

  // A cross-site form post carries the session cookie by itself, so a forged
  // registration must cost the server nothing: no token lookup, no session
  // read, no registration setup.
  it("refuses a foreign-origin cookie request before the token lookup or the session read", async () => {
    const dependencies = unusedRouteDependencies();
    const handler = createRepositoryPostHandler(dependencies);

    const response = await handler(foreignJsonRequest(validInput()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin cookie request that is not JSON", async () => {
    const dependencies = unusedRouteDependencies();
    const handler = createRepositoryPostHandler(dependencies);

    const response = await handler(trustedTextRequest(validInput()));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expectNoDependencyCall(dependencies);
  });

  // Which guard applies is decided by whether a bearer credential parsed, never
  // by whether an Authorization header is merely present. Behind a reverse proxy
  // doing HTTP Basic, every browser request carries `Authorization: Basic ...`,
  // so the cheaper predicate would exempt all of them from the origin check and
  // then read the victim's session cookie anyway.
  it.each<{ label: string; build: (body: unknown) => Request }>([
    { label: "JSON", build: foreignJsonRequest },
    { label: "text/plain", build: foreignTextRequest },
  ])(
    "refuses a foreign-origin $label request whose Authorization header is not a bearer credential",
    async ({ build }) => {
      const dependencies = unusedRouteDependencies();
      const handler = createRepositoryPostHandler(dependencies);
      const request = build(validInput());
      request.headers.set("authorization", "Basic abc");

      const response = await handler(request);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
      });
      expectNoDependencyCall(dependencies);
    },
  );
});

const apiToken = `ovf_${"recognisable-api-credential".padEnd(43, "_")}`;
const tokenAccount: ApiTokenAccount = {
  id: "token-account-id",
  role: "MEMBER",
  enforcementState: "ACTIVE",
};
const tokenRejection = {
  error: { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." },
};

function tokenFixture(
  account: ApiTokenAccount | null = tokenAccount,
  options: SuccessfulDependenciesOptions = {},
  method: "POST" | "DELETE" = "POST",
) {
  const getSession = vi.fn(async () => ({
    user: { id: "cookie-account-id", role: "MODERATOR" as const },
  }));
  const findAccountByTokenHash = vi.fn<(hash: Buffer) => Promise<ApiTokenAccount | null>>(async () => account);
  const createRegistrationDependencies = vi.fn(async (session: RepositoryRouteSession) =>
    successfulDependencies(session.user, options),
  );
  const handlerDependencies = { getSession, findAccountByTokenHash, createRegistrationDependencies };
  const handler = method === "DELETE"
    ? createRepositoryDeleteHandler(handlerDependencies)
    : createRepositoryPostHandler(handlerDependencies);
  return { handler, getSession, findAccountByTokenHash, createRegistrationDependencies };
}

/** Every route dependency as a mock, for requests the guard must refuse outright. */
function unusedRouteDependencies() {
  return {
    getSession: vi.fn(),
    findAccountByTokenHash: vi.fn(),
    createRegistrationDependencies: vi.fn(),
  };
}

/**
 * A programmatic client is not a browser: it sends no `Origin` header at all,
 * so every token-path test here exercises the request shape a script actually
 * produces.
 */
function authorizedRequest(
  body: unknown = validInput(),
  credential = apiToken,
  headers: Record<string, string> = {},
): Request {
  return new Request(routeUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** A bearer-authenticated unregistration request against the same route URL. */
function deleteRequest(
  body: unknown = validUnregisterInput(),
  credential = apiToken,
  headers: Record<string, string> = {},
): Request {
  return new Request(routeUrl, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function validUnregisterInput() {
  return { repositoryUrl: "https://github.com/octo/overflow.git" };
}

function validGitlabUnregisterInput() {
  return {
    provider: "gitlab",
    instanceUrl: "https://gitlab.example.com",
    project: "group/subgroup/project",
  };
}

function registeredTarget(sponsorId = "moderator-id"): RegisteredRepository {
  return {
    id: "repository-id",
    githubRepositoryId: 42,
    ownerName: "octo/overflow",
    sponsorId,
    visibility: "PUBLIC",
    githubWebhookId: 501,
  };
}

function gitlabTarget(sponsorId = "moderator-id"): RegisteredRepository {
  return {
    id: "gitlab-repository-id",
    githubRepositoryId: 4242,
    ownerName: "group/subgroup/project",
    sponsorId,
    visibility: "PUBLIC",
    githubWebhookId: null,
  };
}

describe("Overflow token registration", () => {
  it.each([
    { account: tokenAccount, credential: apiToken },
    {
      account: { id: "second-token-account-id", role: "MODERATOR", enforcementState: "ACTIVE" } as const,
      credential: `ovf_${"second-api-credential".padEnd(43, "_")}`,
    },
  ])("registers with a valid token for $account.id using the resolved account and never reads the cookie", async ({ account, credential }) => {
    const fixture = tokenFixture(account);
    const expectedHash = createHash("sha256").update(credential).digest();
    fixture.findAccountByTokenHash.mockImplementation(async (hash) =>
      hash.equals(expectedHash) ? account : null,
    );
    const response = await fixture.handler(authorizedRequest(validInput(), credential));
    expect(response.status).toBe(201);
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(fixture.findAccountByTokenHash).toHaveBeenCalledExactlyOnceWith(
      expectedHash,
    );
    expect(fixture.createRegistrationDependencies).toHaveBeenCalledExactlyOnceWith(
      { user: { id: account.id, role: account.role } },
      validInput(),
    );
    const body = await response.json();
    expect(body).toEqual({
      repository: {
        id: "repository-id",
        githubRepositoryId: 42,
        ownerName: "octo/overflow",
        sponsorId: account.id,
        visibility: "PUBLIC",
        githubWebhookId: 501,
      },
      initialImportScheduled: true,
      claimPath: "NO_EVIDENCE_FOUND",
    });
    expect(JSON.stringify(body)).not.toContain(credential);
  });

  it.each([
    ["unknown", apiToken],
    ["malformed", "malformed-recognisable-credential"],
  ])(
    "rejects the %s credential without being rescued by a valid cookie", async (_kind, credential) => {
      const fixture = tokenFixture(null);
      const response = await fixture.handler(authorizedRequest(validInput(), credential));
      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body).toEqual(tokenRejection);
      expect(JSON.stringify(body)).not.toContain(credential);
      expect(fixture.getSession).toHaveBeenCalledTimes(0);
      expect(fixture.createRegistrationDependencies).toHaveBeenCalledTimes(0);
      expect(fixture.findAccountByTokenHash).toHaveBeenCalledTimes(credential === apiToken ? 1 : 0);
    },
  );

  it.each([
    ["unknown", apiToken],
    ["malformed", "malformed-recognisable-credential"],
  ])(
    "authenticates the %s credential before reading or validating the payload", async (_kind, credential) => {
      const fixture = tokenFixture(null);
      const request = authorizedRequest({ invalid: true }, credential);
      const readJson = vi.spyOn(request, "json");
      const response = await fixture.handler(request);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(tokenRejection);
      expect(readJson).toHaveBeenCalledTimes(0);
    },
  );

  it("falls through to the cookie for a malformed Authorization header", async () => {
    const fixture = tokenFixture();
    // Unrecognized credentials land on the cookie path, guard included, so this
    // request is built as the browser one it is treated as.
    const request = jsonRequest(validInput());
    request.headers.set("authorization", "Basic abc");
    const response = await fixture.handler(request);
    expect(response.status).toBe(201);
    expect(fixture.getSession).toHaveBeenCalledTimes(1);
    expect(fixture.findAccountByTokenHash).toHaveBeenCalledTimes(0);
    expect(fixture.createRegistrationDependencies).toHaveBeenCalledExactlyOnceWith(
      { user: { id: "cookie-account-id", role: "MODERATOR" } },
      validInput(),
    );
  });

  it("sanitizes a token lookup failure without consulting the cookie or registration factory", async () => {
    const fixture = tokenFixture();
    fixture.findAccountByTokenHash.mockRejectedValue(new Error(apiToken));
    const response = await fixture.handler(authorizedRequest());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body).toEqual({ error: {
      code: "UPSTREAM_FAILURE", message: "Unable to initialize repository registration.",
    } });
    expect(JSON.stringify(body)).not.toContain(apiToken);
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(fixture.createRegistrationDependencies).toHaveBeenCalledTimes(0);
  });

  it.each([
    ["payload", 400, "INVALID_REQUEST", "Invalid repository registration request."],
    ["domain input", 400, "INVALID_INPUT", "Submit one GitHub repository as owner/name or a canonical GitHub URL."],
    ["banned", 403, "FORBIDDEN", "The account is not eligible to register repositories."],
    ["private repository", 403, "FORBIDDEN", "Only public GitHub repositories can be registered."],
    ["repository lookup", 502, "UPSTREAM_FAILURE", "Unable to save the repository registration."],
    ["repository creation", 502, "UPSTREAM_FAILURE", "Unable to save the repository registration."],
    ["write-time enforcement", 403, "FORBIDDEN", "The account is not eligible to register repositories."],
    ["permissions", 403, "FORBIDDEN", "GitHub administrator permission is required for the submitted repository."],
    ["conflict", 409, "CONFLICT", "This GitHub repository is already registered."],
    ["github", 502, "UPSTREAM_FAILURE", "Unable to create the repository webhook on GitHub."],
    ["initialization", 502, "UPSTREAM_FAILURE", "Unable to initialize repository registration."],
  ] as const)("does not expose the token on %s failure", async (failure, status, code, message) => {
    const fixture = tokenFixture();
    fixture.createRegistrationDependencies.mockImplementation(async (session) => {
      if (failure === "initialization") {
        throw new Error(apiToken);
      }
      const dependencies = successfulDependencies(session.user, {
        canAdminister: failure !== "permissions",
        existingRepository: failure === "conflict",
      });
      if (failure === "private repository") {
        const repository = await dependencies.github.getRepository({ owner: "octo", name: "overflow" });
        dependencies.github.getRepository = async () => ({
          ...repository, visibility: "PRIVATE", fullName: apiToken,
        });
      }
      if (failure === "repository lookup") {
        // The registration flow consults the by-id registration state, so the
        // store failure it must surface without leaking the token is that lookup.
        dependencies.store.findRepositoryRegistrationState = async () => { throw new Error(apiToken); };
      }
      if (failure === "repository creation") {
        dependencies.store.createRepository = async () => { throw new Error(apiToken); };
      }
      if (failure === "write-time enforcement") {
        dependencies.actor.enforcementState = "ACTIVE";
        dependencies.store.createRepository = async () => {
          const error = new RepositoryRegistrationEnforcementError();
          error.message = apiToken;
          throw error;
        };
      }
      if (failure === "banned") {
        dependencies.actor.enforcementState = "BANNED";
      }
      if (failure === "github") {
        dependencies.github.createWebhook = async () => { throw new Error(apiToken); };
      }
      return dependencies;
    });
    const input = failure === "payload" ? { invalid: true } : {
      ...validInput(), repositoryUrl: failure === "domain input" ? apiToken : validInput().repositoryUrl,
    };
    const response = await fixture.handler(authorizedRequest(input));
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect.soft(JSON.stringify(body)).not.toContain(apiToken);
    expect(body).toEqual({ error: { code, message } });
  });

  it.each(["token", "cookie"] as const)(
    "rejects a banned account through the production %s path before GitHub work", async (path) => {
      vi.spyOn(PostgresApiTokenStore.prototype, "findAccountByTokenHash")
        .mockResolvedValue({ ...tokenAccount, enforcementState: "BANNED" });
      if (path === "cookie") readSession.mockResolvedValue({ user: tokenAccount });
      vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken")
        .mockResolvedValue("stored-github-oauth-token");
      const enforcement = vi.spyOn(PostgresRepositoryStore.prototype, "getEnforcementState")
        .mockResolvedValue("BANNED");
      vi.stubEnv("GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
      vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
      const fetchGitHub = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
      vi.stubGlobal("fetch", fetchGitHub);
      const response = await POST(path === "token" ? authorizedRequest() : jsonRequest(validInput()));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({ error: {
        code: "FORBIDDEN", message: "The account is not eligible to register repositories.",
      } });
      expect(JSON.stringify(body)).not.toContain(apiToken);
      expect(enforcement).toHaveBeenCalledExactlyOnceWith("token-account-id");
      expect(fetchGitHub).toHaveBeenCalledTimes(0);
    },
  );

  it.each(["token", "cookie"] as const)("attributes the production %s gateway to its account", async (path) => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const budget = createGitHubGraphqlBudgetStore();
    Reflect.set(globalThis, key, budget);
    try {
      vi.spyOn(PostgresApiTokenStore.prototype, "findAccountByTokenHash").mockResolvedValue(tokenAccount);
      if (path === "cookie") readSession.mockResolvedValue({ user: tokenAccount });
      vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue("stored-oauth-token");
      vi.spyOn(PostgresRepositoryStore.prototype, "getEnforcementState").mockResolvedValue("ACTIVE");
      vi.stubEnv("GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
      vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
      const request = vi.fn<typeof fetch>(async () => Response.json({ data: {
        rateLimit: { remaining: 42, resetAt: "2026-09-07T11:00:00Z" },
        repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      } }));
      vi.stubGlobal("fetch", request);
      // Exercise GraphQL on the gateway the route actually constructs, then stop
      // registration before any persistence. This probes wiring through behavior.
      vi.spyOn(GitHubGateway.prototype, "getRepository").mockImplementation(async function (this: GitHubGateway) {
        await this.listIssues({ owner: "octo", name: "overflow" });
        throw new Error("stop after gateway probe");
      });
      const response = await POST(path === "token" ? authorizedRequest() : jsonRequest(validInput()));
      expect(response.status).toBe(502);
      expect(request).toHaveBeenCalledTimes(1);
      expect(budget.owners()).toEqual([tokenAccount.id]);
      expect(budget.read(tokenAccount.id)?.remaining).toBe(42);
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("carries each minted account identity through bearer lookup to its own GitHub OAuth credential", async () => {
    const identities = [
      { account: tokenAccount, oauth: "stored-github-oauth-token" },
      {
        account: { id: "second-token-account-id", role: "MEMBER", enforcementState: "ACTIVE" } as const,
        oauth: "second-account-github-oauth-token",
      },
    ];
    // Keep both accounts' issued hashes live so a constant cannot stand in for
    // the session, bearer hash, or OAuth account at any connected boundary.
    const issuedHashes = new Map<string, Buffer>();
    const issueToken = vi.spyOn(PostgresApiTokenStore.prototype, "issueToken")
      .mockImplementation(async (userId, hash) => {
        issuedHashes.set(userId, hash);
        return { createdAt: new Date("2026-09-05T10:00:00.000Z") };
      });
    const bearerLookup = vi.spyOn(PostgresApiTokenStore.prototype, "findAccountByTokenHash")
      .mockImplementation(async (hash) =>
        identities.find(({ account }) => issuedHashes.get(account.id)?.equals(hash))?.account ?? null,
      );
    const storedToken = vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken")
      .mockImplementation(async (userId) =>
        identities.find(({ account }) => account.id === userId)?.oauth ?? null,
      );
    const enforcement = vi.spyOn(PostgresRepositoryStore.prototype, "getEnforcementState")
      .mockResolvedValue("ACTIVE");
    vi.stubEnv("GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "webhook-secret");
    const fetchGitHub = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchGitHub);

    const credentials: string[] = [];
    for (const [index, { account }] of identities.entries()) {
      readSession.mockResolvedValue({ user: account });
      const response = await mintToken(
        // Minting is a cookie-authenticated mutation, so it is same-origin only.
        new Request(`${requestHost}/api/tokens`, {
          method: "POST",
          headers: { origin: trustedOrigin },
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json() as { token: string };
      expect(body.token).toMatch(/^ovf_[A-Za-z0-9_-]{43}$/);
      credentials.push(body.token);
      expect(issueToken).toHaveBeenNthCalledWith(index + 1, account.id,
        createHash("sha256").update(body.token).digest());
    }
    expect(credentials[1]).not.toBe(credentials[0]);
    expect(issueToken).toHaveBeenCalledTimes(identities.length);
    readSession.mockClear();

    for (const [index, { account, oauth }] of identities.entries()) {
      const credential = credentials[index];
      const response = await POST(authorizedRequest(validInput(), credential));
      expect(bearerLookup).toHaveBeenNthCalledWith(index + 1,
        createHash("sha256").update(credential).digest());
      expect(storedToken).toHaveBeenNthCalledWith(index + 1, account.id);
      expect(enforcement).toHaveBeenNthCalledWith(index + 1, account.id);
      expect(fetchGitHub).toHaveBeenNthCalledWith(index + 1,
        "https://api.github.com/repos/octo/overflow", expect.objectContaining({ headers: expect.any(Headers) }),
      );
      const [, init] = fetchGitHub.mock.calls[index];
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${oauth}`);
      expect(response.status).toBe(502);
      expect(await response.text()).not.toContain(credential);
    }
    expect(readSession).not.toHaveBeenCalled();
    expect(bearerLookup).toHaveBeenCalledTimes(identities.length);
    expect(storedToken).toHaveBeenCalledTimes(identities.length);
    expect(enforcement).toHaveBeenCalledTimes(identities.length);
    expect(fetchGitHub).toHaveBeenCalledTimes(identities.length);
  });

  // A bearer credential is supplied deliberately by the client; a browser never
  // attaches one to a cross-site request the way it attaches a session cookie.
  // So the origin of a token-authenticated request is not consulted at all.
  it.each<{ label: string; headers: Record<string, string> }>([
    { label: "no Origin header", headers: {} },
    { label: "a foreign Origin header", headers: { origin: foreignOrigin } },
  ])("registers a bearer-token request that carries $label", async ({ headers }) => {
    const fixture = tokenFixture();

    const response = await fixture.handler(authorizedRequest(validInput(), apiToken, headers));

    expect(response.status).toBe(201);
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(fixture.findAccountByTokenHash).toHaveBeenCalledExactlyOnceWith(
      createHash("sha256").update(apiToken).digest(),
    );
  });

  // The origin check is the only half a token request skips, and it is the only
  // half that reads APP_URL: an unconfigured origin cannot strand a script.
  it("registers a bearer-token request even when APP_URL is unset", async () => {
    vi.stubEnv("APP_URL", "");
    const fixture = tokenFixture();

    const response = await fixture.handler(authorizedRequest());

    expect(response.status).toBe(201);
  });

  it.each([
    { label: "a recognized credential", credential: apiToken },
    // A credential that fails the format check answers 401 at the hashing step,
    // so a 415 for this one proves the content type is checked before the token
    // is hashed or looked up.
    { label: "a malformed credential", credential: "not-an-overflow-token" },
  ])("refuses a text/plain bearer request carrying $label", async ({ credential }) => {
    const fixture = tokenFixture();

    const response = await fixture.handler(
      authorizedRequest(validInput(), credential, { "content-type": "text/plain" }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expect(fixture.findAccountByTokenHash).not.toHaveBeenCalled();
    expect(fixture.getSession).not.toHaveBeenCalled();
    expect(fixture.createRegistrationDependencies).not.toHaveBeenCalled();
  });
});

const {
  url: routeUrl,
  json: jsonRequest,
  foreignJson: foreignJsonRequest,
  foreignText: foreignTextRequest,
  trustedText: trustedTextRequest,
} = guardedRequests("/api/repositories");

describe("PATCH /api/repositories", () => {
  it("returns a structured 401 without a session", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => null,
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it("returns a structured 400 when the request is not one repository catalog submission", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest({ repositories: ["octo/overflow"] }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid repository registration request." },
    });
  });

  // The same wiring preemption the DELETE handler repairs: a GitLab-shaped
  // catalog change refuses inside buildRegistrationDependencies, and that
  // refusal is the submitter's input — a permanent 400, never the catch-all
  // upstream 502.
  it("maps the forge-identity input refusal raised while wiring a GitLab catalog change to 400", async () => {
    const handler = createRepositoryPatchHandler(forgeWiringDependencies());

    const response = await handler(jsonRequest({ ...validInput(), provider: "gitlab" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "The instance URL must be an absolute URL.",
      },
    });
  });

  it("answers 200 with the appended version when the catalog changed", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        existingRepository: true,
        catalogChange: {
          changed: true,
          versionNumber: 2,
          effectiveFrom: "2026-09-09T12:00:00.000Z",
        },
      }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: {
        id: "repository-id",
        githubRepositoryId: 42,
        ownerName: "octo/overflow",
        sponsorId: "moderator-id",
        visibility: "PUBLIC",
        githubWebhookId: 501,
      },
      changed: true,
      versionNumber: 2,
      effectiveFrom: "2026-09-09T12:00:00.000Z",
    });
  });

  it("answers 200 with changed false when the submitted catalog already is the current one", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        existingRepository: true,
      }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ changed: false, versionNumber: null, effectiveFrom: null });
    expect(body.repository).toMatchObject({ githubRepositoryId: 42 });
  });

  it("returns a structured 403 when the account is not eligible to hold repositories", async () => {
    const dependencies = successfulDependencies({ id: "moderator-id", role: "MODERATOR" });
    dependencies.actor = { ...dependencies.actor, enforcementState: "BANNED" };
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "The account is not eligible to change repository catalogs.",
      },
    });
  });

  it("returns a structured 409 when the submitted repository is not registered", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFLICT",
        message: "This GitHub repository is not registered, so there is no catalog to change.",
      },
    });
  });

  it("returns a structured 403 when the requester is not the repository's sponsor", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "outsider-id", role: "MEMBER" } }),
      createRegistrationDependencies: async () => successfulDependencies(
        { id: "outsider-id", role: "MEMBER" },
        {
          existingRepository: true,
          catalogChange: new RepositorySchemeChangeForbiddenError(42),
        },
      ),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Only the repository's sponsor can change its difficulty catalog.",
      },
    });
  });

  it("refuses a non-sponsor before any GitHub label read", async () => {
    const dependencies = successfulDependencies(
      { id: "outsider-id", role: "MEMBER" },
      {
        existingRepository: true,
        catalogChange: new RepositorySchemeChangeForbiddenError(42),
      },
    );
    let labelReads = 0;
    const listRepositoryLabels = dependencies.github.listRepositoryLabels;
    dependencies.github = {
      ...dependencies.github,
      async listRepositoryLabels(repository) {
        labelReads += 1;
        return listRepositoryLabels(repository);
      },
    };
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "outsider-id", role: "MEMBER" } }),
      createRegistrationDependencies: async () => dependencies,
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(403);
    expect(labelReads).toBe(0);
  });

  it("answers a conflicting catalog order with an explicit 409, not a generic upstream failure", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        existingRepository: true,
        catalogChange: new RepositorySchemeChangeOrderError(42),
      }),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFLICT",
        message: "The catalog change could not be recorded: its effective instant precedes the version before it. Retry the change.",
      },
    });
  });

  it("returns a structured 400 for a catalog that fails the registration validation", async () => {
    const handler = createRepositoryPatchHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, { existingRepository: true }),
    });
    const incomplete = { ...validInput(), actualLabels: validInput().actualLabels.slice(0, 9) };

    const response = await handler(jsonRequest(incomplete));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("keeps the POST registration behavior untouched beside the change path", async () => {
    const handler = createRepositoryPostHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validInput()));

    expect(response.status).toBe(201);
  });
});

describe("DELETE /api/repositories", () => {
  it("returns a structured 401 without a session", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => null,
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAUTHENTICATED", message: "Sign in is required." },
    });
  });

  it("returns a structured 400 when the request is not one repository reference", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest({ repositories: ["octo/overflow"] }, "DELETE"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid repository unregistration request." },
    });
  });

  it("returns a structured 400 when the body carries an unknown extra key beside the reference", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    // A registration-shaped body is the plausible accident here: the extra
    // key must refuse the whole submission, not be trimmed off silently.
    const response = await handler(
      jsonRequest({ ...validUnregisterInput(), openingName: "Scope" }, "DELETE"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INVALID_REQUEST", message: "Invalid repository unregistration request." },
    });
  });

  it("returns a structured 404 when no registration holds the submitted path", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NOT_FOUND",
        message: "No registration holds the GitHub path octo/overflow, so there is nothing to unregister.",
      },
    });
  });

  it("returns a structured 403 when the requester is not the repository's sponsor", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "outsider-id", role: "MEMBER" } }),
      createRegistrationDependencies: async () => successfulDependencies(
        { id: "outsider-id", role: "MEMBER" },
        { unregisterTarget: registeredTarget("someone-else-id") },
      ),
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Only the repository's sponsor can unregister it.",
      },
    });
  });

  it("answers 200 with the unregister result once the hook is deleted and the write lands", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        unregisterTarget: registeredTarget(),
        unregisterOutcome: { kind: "UNREGISTERED", repository: registeredTarget() },
      }),
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: registeredTarget(),
      webhookDeleted: true,
      alreadyUnregistered: false,
    });
  });

  it("answers 200 reporting an idempotent repeat as already unregistered", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        unregisterTarget: registeredTarget(),
        unregisterOutcome: { kind: "ALREADY_UNREGISTERED", repository: registeredTarget() },
      }),
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: registeredTarget(),
      webhookDeleted: true,
      alreadyUnregistered: true,
    });
  });

  it("returns a structured 400 when the body carries neither a repository reference nor a GitLab provider", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest({}, "DELETE"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "Submit one GitHub repository as owner/name or a canonical GitHub URL.",
      },
    });
  });

  it("resolves a GitLab unregistration by instance and project and answers 200 with the result", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        unregisterForgeTarget: gitlabTarget(),
        unregisterOutcome: { kind: "UNREGISTERED", repository: gitlabTarget() },
      }),
    });

    const response = await handler(jsonRequest(validGitlabUnregisterInput(), "DELETE"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: gitlabTarget(),
      webhookDeleted: false,
      alreadyUnregistered: false,
    });
  });

  it("returns a structured 404 when no GitLab registration matches the instance and project", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(),
    });

    const response = await handler(jsonRequest(validGitlabUnregisterInput(), "DELETE"));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "NOT_FOUND",
        message: "No GitLab registration matches that instance and project, so there is nothing to unregister.",
      },
    });
  });

  // The wiring runs before the flow: a GitLab submission without an instance URL
  // refuses inside buildRegistrationDependencies, and that refusal is the
  // submitter's input — a permanent 400, never the catch-all upstream 502.
  it("maps the forge-identity input refusal raised while wiring a GitLab unregistration to 400", async () => {
    const handler = createRepositoryDeleteHandler(forgeWiringDependencies());

    const response = await handler(jsonRequest({ provider: "gitlab" }, "DELETE"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "INVALID_INPUT",
        message: "The instance URL must be an absolute URL.",
      },
    });
  });

  it("passes a store-raised conflict through the shared error mapping unchanged", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => successfulDependencies(undefined, {
        unregisterTarget: registeredTarget(),
        unregisterStoreError: new RepositoryRegistrationError(
          "CONFLICT",
          "The GitHub path octo/overflow is claimed by a different registration.",
        ),
      }),
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "CONFLICT",
        message: "The GitHub path octo/overflow is claimed by a different registration.",
      },
    });
  });

  it("returns a structured 502 when the route's registration dependencies cannot be built", async () => {
    const handler = createRepositoryDeleteHandler({
      findAccountByTokenHash: async () => null,
      getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" } }),
      createRegistrationDependencies: async () => {
        throw new Error("GitHub webhook configuration must be set.");
      },
    });

    const response = await handler(jsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UPSTREAM_FAILURE", message: "Unable to unregister the repository." },
    });
  });

  // A cross-site form post carries the session cookie by itself, so a forged
  // unregistration must cost the server nothing: no token lookup, no session
  // read, no unregister setup.
  it("refuses a foreign-origin cookie request before the token lookup or the session read", async () => {
    const dependencies = unusedRouteDependencies();
    const handler = createRepositoryDeleteHandler(dependencies);

    const response = await handler(foreignJsonRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: "FORBIDDEN", message: "The request origin is not allowed." },
    });
    expectNoDependencyCall(dependencies);
  });

  it("refuses a trusted-origin cookie request that is not JSON", async () => {
    const dependencies = unusedRouteDependencies();
    const handler = createRepositoryDeleteHandler(dependencies);

    const response = await handler(trustedTextRequest(validUnregisterInput(), "DELETE"));

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expectNoDependencyCall(dependencies);
  });

  it("unregisters with a valid bearer token and never reads the cookie", async () => {
    const fixture = tokenFixture(tokenAccount, {
      unregisterTarget: registeredTarget("token-account-id"),
      unregisterOutcome: { kind: "UNREGISTERED", repository: registeredTarget("token-account-id") },
    }, "DELETE");

    const response = await fixture.handler(deleteRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repository: { ...registeredTarget("token-account-id") },
      webhookDeleted: true,
      alreadyUnregistered: false,
    });
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(fixture.findAccountByTokenHash).toHaveBeenCalledExactlyOnceWith(
      createHash("sha256").update(apiToken).digest(),
    );
    expect(fixture.createRegistrationDependencies).toHaveBeenCalledExactlyOnceWith(
      { user: { id: tokenAccount.id, role: tokenAccount.role } },
      { repositoryUrl: "https://github.com/octo/overflow.git" },
    );
  });

  it("rejects an unknown bearer credential without being rescued by a valid cookie", async () => {
    const fixture = tokenFixture(null, {}, "DELETE");

    const response = await fixture.handler(deleteRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual(tokenRejection);
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(fixture.createRegistrationDependencies).toHaveBeenCalledTimes(0);
  });

  it("accepts a bearer request that carries a foreign origin header", async () => {
    const fixture = tokenFixture(tokenAccount, {
      unregisterTarget: registeredTarget("token-account-id"),
      unregisterOutcome: { kind: "UNREGISTERED", repository: registeredTarget("token-account-id") },
    }, "DELETE");

    const response = await fixture.handler(deleteRequest(validUnregisterInput(), apiToken, {
      origin: foreignOrigin,
    }));

    expect(response.status).toBe(200);
    expect(fixture.getSession).toHaveBeenCalledTimes(0);
    expect(fixture.findAccountByTokenHash).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "a recognized credential", credential: apiToken },
    { label: "a malformed credential", credential: "not-an-overflow-token" },
  ])("refuses a text/plain DELETE bearer request carrying $label", async ({ credential }) => {
    const fixture = tokenFixture(tokenAccount, {}, "DELETE");

    const response = await fixture.handler(
      deleteRequest(validUnregisterInput(), credential, { "content-type": "text/plain" }),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "UNSUPPORTED_MEDIA_TYPE",
        message: "The request must use the application/json content type.",
      },
    });
    expect(fixture.findAccountByTokenHash).not.toHaveBeenCalled();
    expect(fixture.getSession).not.toHaveBeenCalled();
    expect(fixture.createRegistrationDependencies).not.toHaveBeenCalled();
  });
});

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
  /** What the store answers for a catalog change: a result, or an error to raise. */
  catalogChange?: RepositoryCatalogChange | Error;
  /** The registration the by-owner-name lookup holds; absent when nothing holds the path. */
  unregisterTarget?: RegisteredRepository;
  /** The registration the by-forge-identity lookup holds; absent when nothing holds it. */
  unregisterForgeTarget?: RegisteredRepository;
  /** The outcome the fake unregister write answers with. */
  unregisterOutcome?: RepositoryUnregisterOutcome;
  /** The error the fake unregister write raises instead of answering. */
  unregisterStoreError?: RepositoryRegistrationError;
  /** The error the fake registration write raises instead of answering. */
  createRepositoryError?: unknown;
  /** The error the fake webhook deletion raises instead of answering. */
  deleteWebhookError?: unknown;
};

function successfulDependencies(
  actor: { id: string; role: "MEMBER" | "MODERATOR" } = {
    id: "moderator-id",
    role: "MODERATOR",
  },
  options: SuccessfulDependenciesOptions = {},
): RepositoryRegistrationDependencies {
  const resolvedRepository = {
    id: 42,
    owner: "octo",
    ownerType: "USER" as const,
    name: "overflow",
    fullName: "octo/overflow",
    visibility: "PUBLIC" as const,
    url: "https://github.com/octo/overflow",
    canAdminister: options.canAdminister ?? true,
  };
  return {
    actor,
    github: {
      async getRepository() {
        return resolvedRepository;
      },
      async getRepositoryById() {
        return resolvedRepository;
      },
      async listRepositoryLabels() {
        return new Set([...validInput().openingLabels, ...validInput().actualLabels].map(({ label }) => label));
      },
      async listWorkflowFiles() { return []; },
      async createWebhook() {
        if (options.webhookFailure) {
          throw new Error("upstream access-token-should-not-leak");
        }
        return { id: 501 };
      },
      async deleteWebhook() {
        if (options.deleteWebhookError !== undefined) {
          throw options.deleteWebhookError;
        }
      },
    },
    store: {
      findRepositoryProviderById: async () => null,
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
      async findRepositoryRegistrationStateByOwnerName() {
        return options.unregisterTarget === undefined
          ? null
          : { repository: options.unregisterTarget, unregisteredAt: null };
      },
      async findRepositoryRegistrationStateByForgeIdentity() {
        return options.unregisterForgeTarget === undefined
          ? null
          : { repository: options.unregisterForgeTarget, unregisteredAt: null };
      },
      async findRepositoryRegistrationState() {
        return options.existingRepository
          ? {
              repository: {
                id: "repository-id",
                githubRepositoryId: 42,
                ownerName: "octo/overflow",
                sponsorId: "moderator-id",
                visibility: "PUBLIC" as const,
                githubWebhookId: 501,
              },
              unregisteredAt: null,
            }
          : null;
      },
      async unregisterRepository(): Promise<RepositoryUnregisterOutcome> {
        if (options.unregisterStoreError !== undefined) {
          throw options.unregisterStoreError;
        }
        if (options.unregisterOutcome !== undefined) {
          return options.unregisterOutcome;
        }
        throw new Error("The route reached the unregister write without an injected outcome.");
      },
      async appendDifficultySchemeVersion() {
        if (options.catalogChange instanceof Error) {
          throw options.catalogChange;
        }
        return options.catalogChange ?? { changed: false, versionNumber: null, effectiveFrom: null };
      },
      async createRepository(repository) {
        if (options.createRepositoryError !== undefined) {
          throw options.createRepositoryError;
        }
        return {
          id: "repository-id",
          githubRepositoryId: 42,
          ownerName: "octo/overflow",
          sponsorId: repository.sponsorId,
          visibility: "PUBLIC",
          githubWebhookId: 501,
        };
      },
      async saveAbandonedWebhookCleanup() {},
      async listAbandonedWebhookCleanups() {
        return [];
      },
      async clearAbandonedWebhookCleanup() {},
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
      secret: "webhook-secret-for-test",
    },
    async scheduleInitialImport() {
      return undefined;
    },
  };
}

/**
 * Route wiring whose forge limb reproduces buildRegistrationDependencies' one
 * unguarded step: a GitLab submission resolves the submitter's linked identity
 * through normalizeInstanceUrl, whose ForgeIdentityError is the submitter's
 * input. The stub throws where the real wiring throws, so these tests pin the
 * route's mapping of that error rather than a stand-in refusal.
 */
function forgeWiringDependencies(options: SuccessfulDependenciesOptions = {}): RepositoryRouteDependencies {
  return {
    findAccountByTokenHash: async () => null,
    getSession: async () => ({ user: { id: "moderator-id", role: "MODERATOR" as const } }),
    async createRegistrationDependencies(_session, input) {
      if (input.provider === "gitlab") {
        normalizeInstanceUrl(input.instanceUrl ?? "");
      }
      return successfulDependencies(undefined, options);
    },
  };
}

function failingGitHubGateway(
  step: "lookup" | "labels" | "webhook",
  status: number,
  headers: Record<string, string> = {},
  ownerType = "Organization",
  body = "private-body access-token-should-not-leak",
): GitHubGateway {
  return new GitHubGateway({
    accessToken: "access-token-should-not-leak",
    fetch: async (input) => {
      const pathname = new URL(String(input)).pathname;
      const requestedStep = pathname.endsWith("/hooks") ? "webhook" : pathname.endsWith("/labels") ? "labels" : "lookup";
      if (requestedStep === step) {
        return new Response(body, {
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
