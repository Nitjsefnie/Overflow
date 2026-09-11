import { describe, expect, it, vi } from "vitest";
import { classifyGitHubRateLimit, GitHubApiError } from "@/lib/github/errors";
import type { GitHubRepository } from "@/lib/github/types";
import type { ClaimPathEvidence } from "@/lib/domain/claim-path";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  RegisteredRepository,
  RepositoryRegistrationDependencies,
  RepositoryRegistrationInput,
  RepositoryRegistrationState,
  RepositoryUnregisterOutcome,
} from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
  RepositoryRegistrationError,
  RepositoryWebhookIdConflictError,
  changeRepositoryCatalog,
  describeErrorCause,
  drainAbandonedWebhooks,
  parseGitHubRepository,
  registerRepository,
  unregisterRepository,
} from "@/lib/repositories/register";

const claimWorkflow: ClaimPathEvidence = {
  path: ".github/workflows/claim.yml",
  content: "on: issue_comment\njobs:\n  claim:\n    steps:\n      - run: gh api repos/octo/overflow/issues/1/assignees -f assignees[]=contributor\n",
};

describe("explicit repository registration", () => {
  it("normalizes a canonical GitHub repository URL", () => {
    expect(parseGitHubRepository("https://github.com/octo/overflow.git")).toEqual({
      owner: "octo",
      name: "overflow",
    });
  });

  it("registers exactly one submitted repository with arbitrary configured S/M/L opening labels", async () => {
    const harness = createHarness();
    const input = createInput();

    await expect(registerRepository(harness.dependencies, input)).resolves.toMatchObject({
      githubRepositoryId: 42,
      githubWebhookId: 501,
      ownerName: "octo/overflow",
    });

    expect(harness.createdRepositories).toHaveLength(1);
    expect(harness.createdRepositories[0]?.difficultyScheme).toEqual(toDifficultyScheme(input));
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "listRepositoryLabels:octo/overflow",
      "createWebhook:octo/overflow",
      "listWorkflowFiles:octo/overflow",
    ]);
    expect(harness.githubCalls.some((call) => call.includes("listAccessibleRepositories"))).toBe(false);
  });

  it("registers a repository whose difficulty labels all already exist in GitHub", async () => {
    const harness = createHarness();

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      githubRepositoryId: 42,
      githubWebhookId: 501,
    });
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "listRepositoryLabels:octo/overflow",
      "createWebhook:octo/overflow",
      "listWorkflowFiles:octo/overflow",
    ]);
  });

  it("refuses registration naming every scheme label the repository is missing", async () => {
    const harness = createHarness({ repositoryLabels: ["size/S", "delivered/1"] });

    const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "INVALID_INPUT",
    });
    const message = (error as Error).message;
    expect(message).toContain("size/M");
    expect(message).toContain("size/L");
    expect(message).toContain("delivered/2");
    expect(message).toContain("delivered/3");
    expect(message).toContain("delivered/4");
    expect(message).toContain("delivered/5");
    expect(message).toContain("delivered/6");
    expect(message).toContain("delivered/7");
    expect(message).toContain("delivered/8");
    expect(message).toContain("delivered/9");
    expect(message).toContain("delivered/10");
    expect(message).toContain("register again");
    expect(message).not.toContain("`size/S`");
    expect(message).not.toContain("`delivered/1`");
    expect(harness.createdRepositories).toEqual([]);
    expect(harness.deletedWebhookIds).toEqual([]);
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "listRepositoryLabels:octo/overflow",
    ]);
  });

  it("refuses a catalog change naming every scheme label the repository is missing", async () => {
    const harness = createHarness({ existing: registeredRepository(), repositoryLabels: [] });

    const error = await changeRepositoryCatalog(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "INVALID_INPUT" });
    const message = (error as Error).message;
    expect(message).toContain("`size/S`");
    expect(message).toContain("`delivered/10`");
    expect(message).toContain("retry the catalog change");
    expect(harness.deletedWebhookIds).toEqual([]);
  });

  it("refuses a GitHub-shaped catalog change whose forge id a GitLab registration holds", async () => {
    const harness = createHarness({ existing: registeredRepository() });
    harness.dependencies.store.findRepositoryProviderById = async () => "gitlab";
    const append = vi.spyOn(harness.dependencies.store, "appendDifficultySchemeVersion");

    const error = await changeRepositoryCatalog(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "RepositoryRegistrationError", code: "CONFLICT" });
    const message = (error as Error).message;
    expect(message).toMatch(/collides with forge id/);
    expect(message).toContain("provider 'gitlab'");
    expect(message).toContain("catalog change refused");
    expect(append).not.toHaveBeenCalled();
  });

  it("refuses the cross-forge collision before the sponsor check on the catalog-change path", async () => {
    // The guard precedes the sponsor check: a non-sponsor asking to change a
    // row another forge holds learns the collision, not the sponsor refusal.
    const harness = createHarness({ existing: { ...registeredRepository(), sponsorId: "someone-else" } });
    harness.dependencies.store.findRepositoryProviderById = async () => "gitlab";

    const error = await changeRepositoryCatalog(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "RepositoryRegistrationError", code: "CONFLICT" });
    const message = (error as Error).message;
    expect(message).toMatch(/collides with forge id/);
    expect(message).toMatch(/catalog change refused\.$/);
    expect(message).not.toContain("Only the repository's sponsor can change its difficulty catalog.");
    expect(harness.createdRepositories).toEqual([]);
  });

  it("carries a catalog change past the forge guard when the stored provider is github", async () => {
    const harness = createHarness({ existing: registeredRepository() });
    harness.dependencies.store.findRepositoryProviderById = async () => "github";
    const append = vi.spyOn(harness.dependencies.store, "appendDifficultySchemeVersion")
      .mockResolvedValue({ changed: true, versionNumber: 2, effectiveFrom: "2026-09-12T00:00:00.000Z" });

    await expect(changeRepositoryCatalog(harness.dependencies, createInput())).resolves.toMatchObject({
      changed: true,
      versionNumber: 2,
      repository: { id: "registered-repository-id" },
    });
    expect(append).toHaveBeenCalledExactlyOnceWith({
      githubRepositoryId: 42,
      sponsorId: "moderator-id",
      scheme: toDifficultyScheme(createInput()),
      effectiveFrom: expect.any(Date),
    });
  });

  it("allows a signed-in member who has GitHub administrator permission for the submitted repository", async () => {
    const harness = createHarness({ actorRole: "MEMBER" });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      githubRepositoryId: 42,
    });
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "listRepositoryLabels:octo/overflow",
      "createWebhook:octo/overflow",
      "listWorkflowFiles:octo/overflow",
    ]);
  });

  it("reads workflows for the submitted repository when both owner and name differ from the default fixture", async () => {
    const harness = createHarness({ owner: "harbour-coop", name: "contributions" });
    const listWorkflowFiles = vi.spyOn(harness.dependencies.github, "listWorkflowFiles");

    await expect(registerRepository(harness.dependencies, createInput({
      repositoryUrl: "https://github.com/harbour-coop/contributions.git",
    }))).resolves.toMatchObject({ id: "registered-repository-id" });

    expect(listWorkflowFiles).toHaveBeenCalledExactlyOnceWith({
      owner: "harbour-coop",
      name: "contributions",
    });
  });

  it.each(["WARNED", "UNDER_AUDIT"] as const)(
    "allows a %s account to register a repository",
    async (enforcementState) => {
      const harness = createHarness({ actorEnforcementState: enforcementState });

      await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
        githubRepositoryId: 42,
        sponsorId: "moderator-id",
      });
      expect(harness.githubCalls).toEqual([
        "getRepository:octo/overflow",
        "listRepositoryLabels:octo/overflow",
        "createWebhook:octo/overflow",
        "listWorkflowFiles:octo/overflow",
      ]);
      expect(harness.createdRepositories).toHaveLength(1);
    },
  );

  it.each(["RECALIBRATING", "BANNED"] as const)(
    "blocks a %s account from registering a repository before contacting GitHub",
    async (enforcementState) => {
      const harness = createHarness({ actorEnforcementState: enforcementState });

      await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "The account is not eligible to register repositories.",
      });
      expect(harness.githubCalls).toEqual([]);
      expect(harness.createdRepositories).toEqual([]);
    },
  );

  it("denies a moderator who lacks GitHub administrator permission for the submitted repository", async () => {
    const harness = createHarness({ canAdminister: false });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "GitHub administrator permission is required for the submitted repository.",
    });
    expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    expect(harness.createdRepositories).toEqual([]);
  });

  it("rejects a private repository before duplicate lookup, label verification, webhook creation, or persistence", async () => {
    const harness = createHarness({ visibility: "PRIVATE" });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only public GitHub repositories can be registered.",
    });
    expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    expect(harness.duplicateLookupIds).toEqual([]);
    expect(harness.createdRepositories).toEqual([]);
    expect(harness.deletedWebhookIds).toEqual([]);
  });

  it("rejects a private repository as private even when the actor lacks GitHub administrator permission", async () => {
    const harness = createHarness({ visibility: "PRIVATE", canAdminister: false });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only public GitHub repositories can be registered.",
    });
    expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    expect(harness.createdRepositories).toEqual([]);
  });

  it("rejects a repository that is already registered before creating a webhook", async () => {
    const existing = registeredRepository();
    const harness = createHarness({ existing });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    expect(harness.createdRepositories).toEqual([]);
  });

  it("consults the by-id registration state for the existing-registration check and conflicts on an active row", async () => {
    const harness = createHarness({ existing: registeredRepository() });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(harness.stateLookupIds).toEqual([42]);
  });

  it("refuses a GitHub registration whose forge id an active GitLab registration holds", async () => {
    // Pin of the existing registration-arm guard (issue 567): an ACTIVE GitLab
    // row (no unregisteredAt) holding the id must refuse a GitHub registration,
    // naming the holding provider.
    const harness = createHarness();
    harness.dependencies.store.findRepositoryProviderById = async () => "gitlab";

    const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "RepositoryRegistrationError", code: "CONFLICT" });
    const message = (error as Error).message;
    expect(message).toMatch(/collides with forge id .* provider 'gitlab'/);
    expect(message).toContain("registration refused");
    expect(harness.createdRepositories).toEqual([]);
  });

  it("reactivates a sponsor-unregistered registration through webhook creation and persistence", async () => {
    const harness = createHarness({ existing: registeredRepository(), existingUnregistered: true });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      githubRepositoryId: 42,
      githubWebhookId: 501,
      id: "registered-repository-id",
    });
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "listRepositoryLabels:octo/overflow",
      "createWebhook:octo/overflow",
      "listWorkflowFiles:octo/overflow",
    ]);
    expect(harness.createdRepositories).toHaveLength(1);
  });

  it("reports a duplicate GitHub repository id discovered at insert as already registered", async () => {
    const harness = createHarness({ storeRejectsAsDuplicateId: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This GitHub repository is already registered.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
  });

  it("reports a GitHub path another registration still claims as a held path, not as this repository", async () => {
    const harness = createHarness({ storeClaimedOwnerName: "octo/overflow" });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "The GitHub path octo/overflow is claimed by a different registration. "
        + "The submitted repository is not registered, and it cannot be registered while another "
        + "registration holds that path.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
  });

  it("reports a GitHub webhook id another registration still claims as a conflict, not an upstream failure", async () => {
    const harness = createHarness({ storeClaimedWebhookId: 501 });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
      message:
        "The GitHub webhook created for the submitted repository collided with one a different "
        + "registration already records. The submitted repository is not registered. Registering "
        + "again requests a new webhook from GitHub, so retry once before treating this as stored "
        + "state that has to be resolved.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
  });

  it("deletes the webhook when the store finds the sponsor ineligible at insert", async () => {
    const harness = createHarness({ storeRejectsSponsorAsIneligible: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "The account is not eligible to register repositories.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
  });

  it("deletes the webhook and surfaces the saved-registration failure when the store raises a registration error itself", async () => {
    const harness = createHarness({ storeRaisesRegistrationError: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to save the repository registration.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
  });

  it("rejects an incomplete actual point mapping without contacting GitHub", async () => {
    const harness = createHarness();
    const input = createInput({ actualLabels: actualLabels().slice(0, -1) });

    await expect(registerRepository(harness.dependencies, input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.githubCalls).toEqual([]);
  });

  it("rejects duplicate actual point mappings without contacting GitHub", async () => {
    const harness = createHarness();
    const labels = actualLabels();
    labels[9] = { label: "delivered/10", points: 9 };

    await expect(registerRepository(harness.dependencies, createInput({ actualLabels: labels }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.githubCalls).toEqual([]);
  });

  it("rejects overlapping opening and actual label catalogs without contacting GitHub", async () => {
    const harness = createHarness();
    const labels = actualLabels();
    labels[0] = { label: "size/S", points: 1 };

    await expect(registerRepository(harness.dependencies, createInput({ actualLabels: labels }))).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.githubCalls).toEqual([]);
  });

  it("returns a sanitized upstream failure when webhook creation fails", async () => {
    const harness = createHarness({ webhookFailure: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to create the repository webhook on GitHub.",
    });
    expect(harness.createdRepositories).toEqual([]);
  });

  it.each([
    ["listRepositoryLabels", "read the repository difficulty labels", 403, "ORGANIZATION"],
    ["listRepositoryLabels", "read the repository difficulty labels", 404, "ORGANIZATION"],
    ["createWebhook", "create the repository webhook", 403, "ORGANIZATION"],
    ["createWebhook", "create the repository webhook", 404, "ORGANIZATION"],
    ["listRepositoryLabels", "read the repository difficulty labels", 403, "USER"],
    ["listRepositoryLabels", "read the repository difficulty labels", 404, "USER"],
    ["createWebhook", "create the repository webhook", 403, "USER"],
    ["createWebhook", "create the repository webhook", 404, "USER"],
  ] as const)("explains %s (%s) HTTP %s access failures for %s owners", async (step, description, status, ownerType) => {
    const harness = createHarness({ owner: "Real-Owner", ownerType });
    harness.dependencies.github[step] = async () => { throw new GitHubApiError(status); };

    const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GITHUB_ACCESS" });
    const message = (error as Error).message;
    if (status === 403) {
      expect(message).toContain(`GitHub refused to ${description} (HTTP 403).`);
    } else {
      expect(message).toContain(`GitHub answered 404 for the request to ${description}.`);
      expect(message).toContain("GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization.");
      expect(message).toContain("The repository may also have been renamed, moved or deleted since it was looked up.");
      expect(message).not.toMatch(/denied|refused/);
    }
    expect(message).toContain("https://github.com/settings/applications");
    expect(message).toContain("retry registration");
    if (ownerType === "ORGANIZATION") {
      expect(message).toContain("the Overflow OAuth application is not approved for that organization");
      expect(message).toContain("https://github.com/organizations/Real-Owner/settings/oauth_application_policy");
      expect(message).not.toContain("/organizations/octo/");
    } else {
      expect(message).toContain("This may be caused by missing authorization for the Overflow OAuth application.");
      expect(message).not.toContain("GitHub denied Overflow access to this repository.");
      expect(message).not.toMatch(/organization|oauth_application_policy/i);
    }
    if (step === "listRepositoryLabels") {
      expect(message).not.toContain("webhook");
      expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    }
    expect(harness.createdRepositories).toEqual([]);
  });

  // Issue 97: an ambiguous 403 — remaining budget, no Retry-After, marker-free body — cannot
  // separate a missing authorization from a secondary rate limit, so the message must say so
  // and put wait-and-retry before the settings remedies instead of ranking authorization first.
  const waitInstruction = "Wait a minute and retry registration before changing anything.";
  const ambiguityClause = "this response carries nothing that separates the two causes";
  it.each([
    { step: "listRepositoryLabels", description: "read the repository difficulty labels", ownerType: "ORGANIZATION" },
    { step: "createWebhook", description: "create the repository webhook", ownerType: "ORGANIZATION" },
    { step: "listRepositoryLabels", description: "read the repository difficulty labels", ownerType: "USER" },
    { step: "createWebhook", description: "create the repository webhook", ownerType: "USER" },
  ] as const)("ranks wait-and-retry before the settings remedies for an ambiguous HTTP 403 on $step for $ownerType owners", async ({ step, description, ownerType }) => {
    const harness = createHarness({ owner: "Real-Owner", ownerType });
    const body = "Resource not accessible";
    const details = classifyGitHubRateLimit(403, new Headers({ "x-ratelimit-remaining": "4999" }), body);
    harness.dependencies.github[step] = async () => {
      throw new GitHubApiError(403, details.rateLimited, details.retryAfterSeconds, body);
    };

    const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GITHUB_ACCESS" });
    const message = (error as Error).message;
    expect(message).toContain(`GitHub refused to ${description} (HTTP 403).`);
    expect(message).toContain(waitInstruction);
    expect(message).toContain(ambiguityClause);
    expect(message.indexOf(waitInstruction)).toBeLessThan(message.indexOf("https://github.com/settings/applications"));
    if (ownerType === "ORGANIZATION") {
      expect(message.indexOf(waitInstruction))
        .toBeLessThan(message.indexOf("https://github.com/organizations/Real-Owner/settings/oauth_application_policy"));
    }
    expect(harness.createdRepositories).toEqual([]);
  });

  it("ranks wait-and-retry before the settings remedies for an ambiguous lookup HTTP 403", async () => {
    const harness = createHarness();
    const body = "Resource not accessible";
    const details = classifyGitHubRateLimit(403, new Headers({ "x-ratelimit-remaining": "4999" }), body);
    harness.dependencies.github.getRepository = async () => {
      throw new GitHubApiError(403, details.rateLimited, details.retryAfterSeconds, body);
    };

    const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GITHUB_ACCESS" });
    const message = (error as Error).message;
    expect(message).toContain("retrieve the submitted GitHub repository");
    expect(message).toContain(waitInstruction);
    expect(message).toContain(ambiguityClause);
    expect(message.indexOf(waitInstruction))
      .toBeLessThan(message.indexOf("https://github.com/settings/applications"));
    expect(message).toContain("For an organization-owned repository, an organization owner may additionally need to approve the Overflow application under the organization's third-party application access policy.");
    expect(message).not.toContain("https://github.com/organizations/");
    expect(harness.createdRepositories).toEqual([]);
  });

  it.each([
    ["listRepositoryLabels", new Error("network secret"), "Unable to read the repository difficulty labels on GitHub."],
    ["createWebhook", new Error("network secret"), "Unable to create the repository webhook on GitHub."],
    ["listRepositoryLabels", new GitHubApiError(500), "Unable to read the repository difficulty labels on GitHub."],
    ["createWebhook", new GitHubApiError(500), "Unable to create the repository webhook on GitHub."],
  ] as const)("keeps %s failure %s as a sanitized upstream failure", async (step, failure, message) => {
    const harness = createHarness();
    harness.dependencies.github[step] = async () => { throw failure; };

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message,
    });
    expect(harness.createdRepositories).toEqual([]);
  });

  it.each([403, 404])("explains lookup HTTP %s without guessing the owner type", async (status) => {
    const harness = createHarness();
    harness.dependencies.github.getRepository = async () => { throw new GitHubApiError(status); };

    const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "GITHUB_ACCESS" });
    const message = (error as Error).message;
    expect(message).toContain("retrieve the submitted GitHub repository");
    expect(message).toContain(String(status));
    expect(message).toContain("https://github.com/settings/applications");
    expect(message).toContain("For an organization-owned repository, an organization owner may additionally need to approve the Overflow application under the organization's third-party application access policy.");
    expect(message).not.toContain("https://github.com/organizations/");
    expect(message).toContain("retry registration");
    expect(harness.createdRepositories).toEqual([]);
  });

  describe.each([
    ["getRepository", "retrieve the submitted GitHub repository", "Unable to retrieve the submitted GitHub repository."],
    ["listRepositoryLabels", "read the repository difficulty labels", "Unable to read the repository difficulty labels on GitHub."],
    ["createWebhook", "create the repository webhook", "Unable to create the repository webhook on GitHub."],
  ] as const)("%s error classification", (step, description, upstreamMessage) => {
    it("treats a plain object with GitHub error fields as an upstream failure", async () => {
      const harness = createHarness();
      harness.dependencies.github[step] = async () => {
        throw { status: 403, rateLimited: false, retryAfterSeconds: null };
      };

      await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
        code: "UPSTREAM_FAILURE",
        message: upstreamMessage,
      });
    });

    it.each([
      [401, "GITHUB_CREDENTIALS"],
      [422, "UPSTREAM_FAILURE"],
      [429, "GITHUB_RATE_LIMITED"],
      [500, "UPSTREAM_FAILURE"],
    ] as const)("classifies unthrottled HTTP %s as %s", async (status, code) => {
      const harness = createHarness();
      harness.dependencies.github[step] = async () => { throw new GitHubApiError(status); };

      await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
        code,
        message: status === 401
          ? `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to ${description}. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry registration.`
          : status === 429
            ? `GitHub rate-limited the request to ${description} (HTTP 429). Please retry registration later.`
            : upstreamMessage,
      });
      expect(harness.createdRepositories).toEqual([]);
    });

    // Issue 93: a 401 says GitHub rejected the stored authorization itself, so the message
    // must name the failed step and give the remedy that refreshes the credential.
    it("surfaces an HTTP 401 as GITHUB_CREDENTIALS naming the step and the recovery", async () => {
      const harness = createHarness();
      harness.dependencies.github[step] = async () => { throw new GitHubApiError(401); };

      const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "GITHUB_CREDENTIALS" });
      const message = (error as Error).message;
      expect(message).toContain(`(HTTP 401) while trying to ${description}.`);
      expect(message).toContain("sign out of Overflow and sign in again with GitHub");
      expect(harness.createdRepositories).toEqual([]);
    });

    it.each([
      [403, 60, " Retry after 60 seconds."],
      [404, null, ""],
      [429, 1, " Retry after 1 second."],
      [429, 2, " Retry after 2 seconds."],
      [500, 0, " Retry after 0 seconds."],
    ] as const)("prioritizes throttling for HTTP %s with retry delay %s", async (status, retryAfterSeconds, delay) => {
      const harness = createHarness({ owner: "Real-Owner", ownerType: "ORGANIZATION" });
      harness.dependencies.github[step] = async () => { throw new GitHubApiError(status, true, retryAfterSeconds); };

      await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
        code: "GITHUB_RATE_LIMITED",
        message: `GitHub rate-limited the request to ${description} (HTTP ${status}).${delay} Please retry registration later.`,
      });
      expect(harness.createdRepositories).toEqual([]);
    });

    // Issue 97's repro shape: a 403 secondary rate limit can carry nonzero remaining budget and
    // no Retry-After, so the body marker is what separates it from an authorization refusal.
    // The error is built the way the transport builds it — the real classifyGitHubRateLimit
    // answer feeds the GitHubApiError the fake gateway throws — rather than hand-crafted.
    it("answers a secondary rate limit carried on a 403 with remaining budget as throttling", async () => {
      const harness = createHarness();
      const body = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";
      const details = classifyGitHubRateLimit(403, new Headers({ "x-ratelimit-remaining": "4999" }), body);
      expect(details).toEqual({ rateLimited: true, retryAfterSeconds: null });
      harness.dependencies.github[step] = async () => {
        throw new GitHubApiError(403, details.rateLimited, details.retryAfterSeconds, body);
      };

      const error = await registerRepository(harness.dependencies, createInput()).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "GITHUB_RATE_LIMITED",
        message: `GitHub rate-limited the request to ${description} (HTTP 403). Please retry registration later.`,
      });
      const message = (error as Error).message;
      expect(message).toContain("Please retry registration later.");
      expect(message).not.toContain("github.com/settings/applications");
      expect(message).not.toContain("oauth_application_policy");
      expect(harness.createdRepositories).toEqual([]);
    });
  });

  it("best-effort deletes the webhook when database persistence fails", async () => {
    const harness = createHarness({ databaseFailure: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to save the repository registration.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
    expect(harness.scheduledRepositoryIds).toEqual([]);
  });

  it("schedules the import of the repository's existing work once the registration is stored", async () => {
    const harness = createHarness();

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      id: "registered-repository-id",
      initialImportScheduled: true,
    });

    expect(harness.scheduledRepositoryIds).toEqual(["registered-repository-id"]);
  });

  it("keeps the registration and reports an unscheduled import when the enqueue fails", async () => {
    const harness = createHarness({ scheduleFailure: true, workflows: [claimWorkflow] });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      id: "registered-repository-id",
      initialImportScheduled: false,
      claimPath: "EVIDENCE_FOUND",
    });

    expect(harness.createdRepositories).toHaveLength(1);
    expect(harness.deletedWebhookIds).toEqual([]);
  });

  it("reports an unscheduled import when no scheduler is wired up", async () => {
    const harness = createHarness({ withoutScheduleInitialImport: true, workflows: [claimWorkflow] });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      initialImportScheduled: false,
      claimPath: "EVIDENCE_FOUND",
    });
  });

  it.each<{ description: string; workflows: ClaimPathEvidence[]; expected: string }>([
    {
      description: "a workflow reacting to comments and referencing assignment",
      workflows: [claimWorkflow],
      expected: "EVIDENCE_FOUND",
    },
    {
      description: "a workflow without assignment evidence",
      workflows: [{ path: ".github/workflows/ci.yml", content: "on: push\njobs: {}\n" }],
      expected: "NO_EVIDENCE_FOUND",
    },
    { description: "an empty workflow list", workflows: [], expected: "NO_EVIDENCE_FOUND" },
    {
      description: "several workflow files with qualifying evidence only in the last file",
      workflows: [
        { path: ".github/workflows/ci.yml", content: "on: push\njobs: {}\n" },
        { path: ".github/workflows/comments.yml", content: "on: issue_comment\njobs: {}\n" },
        claimWorkflow,
      ],
      expected: "EVIDENCE_FOUND",
    },
  ])("reports claim-path evidence for $description after persistence", async ({ workflows, expected }) => {
    const harness = createHarness({ workflows });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      id: "registered-repository-id",
      claimPath: expected,
    });
    expect(harness.workflowReadRepositoryCounts).toEqual([1]);
    expect(harness.githubCalls.at(-1)).toBe("listWorkflowFiles:octo/overflow");
  });

  it.each([
    { description: "a string", rejection: "workflow read failed" },
    { description: "a plain object", rejection: { reason: "workflow read failed" } },
  ])("keeps a successful registration when the workflow gateway rejects with $description", async ({ rejection }) => {
    const harness = createHarness();
    harness.dependencies.github.listWorkflowFiles = async () => { throw rejection; };

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      id: "registered-repository-id",
      githubWebhookId: 501,
      claimPath: "NOT_CHECKED",
      initialImportScheduled: true,
    });
    expect(harness.createdRepositories).toHaveLength(1);
    expect(harness.deletedWebhookIds).toEqual([]);
    expect(harness.scheduledRepositoryIds).toEqual(["registered-repository-id"]);
  });

  it.each(["gateway", "assessment"] as const)(
    "keeps a successful registration and reports NOT_CHECKED when the %s throws",
    async (failure) => {
      const workflows: ClaimPathEvidence[] = [{
        path: ".github/workflows/claim.yml",
        get content(): string {
          throw new Error("workflow assessment failed");
        },
      }];
      const harness = createHarness({ workflows, workflowFailure: failure === "gateway" });

      await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
        id: "registered-repository-id",
        githubWebhookId: 501,
        claimPath: "NOT_CHECKED",
        initialImportScheduled: true,
      });
      expect(harness.createdRepositories).toHaveLength(1);
      expect(harness.workflowReadRepositoryCounts).toEqual([1]);
      expect(harness.deletedWebhookIds).toEqual([]);
      expect(harness.scheduledRepositoryIds).toEqual(["registered-repository-id"]);
    },
  );
});

describe("unregistering a registered repository", () => {
  it("deletes the webhook on GitHub before writing the local unregister", async () => {
    const harness = createHarness({ existing: registeredRepository() });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).resolves.toMatchObject({
      repository: {
        id: "registered-repository-id",
        githubRepositoryId: 42,
        ownerName: "octo/overflow",
        sponsorId: "moderator-id",
        visibility: "PUBLIC",
        githubWebhookId: 501,
      },
      webhookDeleted: true,
      alreadyUnregistered: false,
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
    expect(harness.unregisterInputs).toEqual([{ ownerName: "octo/overflow", sponsorId: "moderator-id" }]);
    // The flow runs no GitHub pre-checks: the deletion is the only GitHub request (E2).
    expect(harness.githubCalls).toEqual([]);
  });

  it("reads a GitHub 404 on the deletion as an already-absent hook and still unregisters locally", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      deleteWebhookFailure: new GitHubApiError(404),
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).resolves.toMatchObject({
      repository: { id: "registered-repository-id" },
      webhookDeleted: false,
      alreadyUnregistered: false,
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
  });

  it.each([
    { name: "credential rejection", failure: new GitHubApiError(401), code: "GITHUB_CREDENTIALS" },
    { name: "access refusal", failure: new GitHubApiError(403), code: "GITHUB_ACCESS" },
    { name: "rate limit", failure: new GitHubApiError(429), code: "GITHUB_RATE_LIMITED" },
    { name: "upstream status", failure: new GitHubApiError(500), code: "UPSTREAM_FAILURE" },
    { name: "plain error", failure: new Error("network secret"), code: "UPSTREAM_FAILURE" },
  ] as const)("maps a deletion $name to $code and leaves the local store untouched", async ({ failure, code }) => {
    const harness = createHarness({ existing: registeredRepository(), deleteWebhookFailure: failure });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code,
    });
    expect(harness.unregisterInputs).toEqual([]);
    expect(harness.callOrder).toEqual(["deleteWebhook:501"]);
  });

  it("rejects an unparseable submission as invalid input without contacting anyone", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "not a repository" })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(harness.callOrder).toEqual([]);
  });

  it("maps a failing by-owner-name lookup to UPSTREAM_FAILURE and exposes nothing of the store error", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      stateLookupFailure: new Error("database connectivity secret"),
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to unregister the repository.",
    });
    expect(harness.callOrder).toEqual([]);
  });

  it("maps a failing unregister write to UPSTREAM_FAILURE and exposes nothing of the store error", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      storeUnregisterFailure: new Error("database connectivity secret"),
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to unregister the repository.",
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
  });

  it("answers NOT_FOUND for an owner name no registration holds", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(harness.stateLookupsByOwnerName).toEqual(["octo/overflow"]);
    expect(harness.callOrder).toEqual([]);
  });

  it("refuses a GitHub-shaped unregistration whose forge id a GitLab registration holds, before any webhook or store write", async () => {
    // The target lookup matches the stored owner name, which is not
    // forge-qualified, so a GitLab row resolves here; the guard must refuse
    // before the webhook block and before the store write (issue 567).
    const harness = createHarness({ existing: registeredRepository() });
    harness.dependencies.store.findRepositoryProviderById = async () => "gitlab";

    const error = await unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "RepositoryRegistrationError", code: "CONFLICT" });
    const message = (error as Error).message;
    expect(message).toMatch(/collides with forge id .* provider 'gitlab'/);
    expect(message).toContain("unregistration refused");
    expect(harness.callOrder).toEqual([]);
    expect(harness.unregisterInputs).toEqual([]);
    expect(harness.deletedWebhookIds).toEqual([]);
    expect(harness.deleteWebhookReferences).toEqual([]);
  });

  it("refuses the cross-forge collision before the sponsor check on the unregistration path", async () => {
    // The guard precedes the sponsor check: a non-sponsor asking to
    // unregister a row another forge holds learns the collision, not the
    // sponsor refusal — and still moves nothing.
    const harness = createHarness({ existing: { ...registeredRepository(), sponsorId: "someone-else" } });
    harness.dependencies.store.findRepositoryProviderById = async () => "gitlab";

    const error = await unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" }).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: "RepositoryRegistrationError", code: "CONFLICT" });
    const message = (error as Error).message;
    expect(message).toMatch(/collides with forge id/);
    expect(message).toMatch(/unregistration refused\.$/);
    expect(message).not.toContain("Only the repository's sponsor can unregister it.");
    expect(harness.callOrder).toEqual([]);
    expect(harness.unregisterInputs).toEqual([]);
    expect(harness.deletedWebhookIds).toEqual([]);
  });

  it("carries an unregistration past the forge guard when the stored provider is github", async () => {
    const harness = createHarness({ existing: registeredRepository() });
    harness.dependencies.store.findRepositoryProviderById = async () => "github";

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).resolves.toMatchObject({
      repository: { id: "registered-repository-id" },
      webhookDeleted: true,
      alreadyUnregistered: false,
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
  });

  it("refuses someone other than the repository's sponsor before contacting GitHub", async () => {
    const harness = createHarness({ existing: { ...registeredRepository(), sponsorId: "someone-else-id" } });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the repository's sponsor can unregister it.",
    });
    expect(harness.callOrder).toEqual([]);
    expect(harness.githubCalls).toEqual([]);
  });

  it("surfaces NOT_FOUND when the registration vanishes between the lookup and the write", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      storeUnregisterOutcome: { kind: "NOT_REGISTERED" },
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
  });

  it("surfaces FORBIDDEN when the store refuses the sponsor at the write", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      storeUnregisterOutcome: { kind: "FORBIDDEN" },
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("reports an idempotent repeat as already unregistered with the row carried", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      storeUnregisterOutcome: { kind: "ALREADY_UNREGISTERED", repository: registeredRepository() },
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).resolves.toMatchObject({
      repository: { id: "registered-repository-id" },
      webhookDeleted: true,
      alreadyUnregistered: true,
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
  });

  it("does not gate unregistration on participation eligibility", async () => {
    const harness = createHarness({ existing: registeredRepository(), actorEnforcementState: "BANNED" });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).resolves.toMatchObject({
      webhookDeleted: true,
      alreadyUnregistered: false,
    });
    expect(harness.callOrder).toEqual(["deleteWebhook:501", "unregisterRepository:octo/overflow"]);
  });
});

describe("unregistering a GitLab registration by forge identity", () => {
  const instanceUrl = "https://gitlab.example.com";

  it("unregisters a nested-group project submitted as a path with namespace, addressed by the row's stored owner name", async () => {
    const harness = createHarness({
      existing: registeredGitLabRepository(),
      storeUnregisterOutcome: { kind: "UNREGISTERED", repository: registeredGitLabRepository() },
    });

    // The submission's instance URL is not stored verbatim: the lookup runs
    // against the normalized form the link flow stores under.
    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl: "https://GitLab.example.com/",
      project: "group/subgroup/project",
    })).resolves.toMatchObject({
      repository: {
        id: "registered-gitlab-repository-id",
        githubRepositoryId: 4242,
        ownerName: "group/subgroup/project",
        sponsorId: "moderator-id",
        visibility: "PUBLIC",
        githubWebhookId: null,
      },
      webhookDeleted: false,
      alreadyUnregistered: false,
    });
    expect(harness.forgeIdentityLookups).toEqual([
      { provider: "gitlab", instanceUrl: "https://gitlab.example.com", ownerName: "group/subgroup/project" },
    ]);
    // Never the GitHub-shaped path finder: a nested group's path is not a
    // two-segment owner/name reference.
    expect(harness.stateLookupsByOwnerName).toEqual([]);
    expect(harness.unregisterInputs).toEqual([{ ownerName: "group/subgroup/project", sponsorId: "moderator-id" }]);
    expect(harness.callOrder).toEqual(["unregisterRepository:group/subgroup/project"]);
    expect(harness.githubCalls).toEqual([]);
  });

  it("resolves a numeric project id by forge project id with no forge or GitHub gateway call", async () => {
    const harness = createHarness({
      existing: registeredGitLabRepository(),
      storeUnregisterOutcome: { kind: "UNREGISTERED", repository: registeredGitLabRepository() },
    });

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "4242",
    })).resolves.toMatchObject({
      repository: { id: "registered-gitlab-repository-id", githubWebhookId: null },
      webhookDeleted: false,
      alreadyUnregistered: false,
    });
    expect(harness.forgeIdentityLookups).toEqual([
      { provider: "gitlab", instanceUrl, forgeProjectId: 4242 },
    ]);
    expect(harness.callOrder).toEqual(["unregisterRepository:group/subgroup/project"]);
    expect(harness.githubCalls).toEqual([]);
  });

  it.each([
    { name: "a missing instance URL", input: { provider: "gitlab" as const, project: "group/subgroup/project" } },
    { name: "a missing project", input: { provider: "gitlab" as const, instanceUrl } },
    { name: "an empty instance URL", input: { provider: "gitlab" as const, instanceUrl: "", project: "group/subgroup/project" } },
    { name: "an empty project", input: { provider: "gitlab" as const, instanceUrl, project: "" } },
  ])("refuses $name with the missing-fields message", async ({ input }) => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, input)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "A GitLab unregistration requires the instance URL and the project id or path.",
    });
    expect(harness.forgeIdentityLookups).toEqual([]);
    expect(harness.callOrder).toEqual([]);
  });

  it("refuses a project that is neither a positive numeric id nor a path with namespace", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "project-without-namespace",
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Submit the GitLab project as a positive numeric id or a path with namespace.",
    });
    expect(harness.forgeIdentityLookups).toEqual([]);
    expect(harness.callOrder).toEqual([]);
  });

  it("refuses a numeric id that is not a positive integer, as registration does", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "0",
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "The GitLab project id must be a positive integer.",
    });
    expect(harness.forgeIdentityLookups).toEqual([]);
    expect(harness.callOrder).toEqual([]);
  });

  it("refuses a malformed instance URL with the same message the link flow uses", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl: "not a url",
      project: "group/subgroup/project",
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "The instance URL must be an absolute URL.",
    });
    expect(harness.forgeIdentityLookups).toEqual([]);
    expect(harness.callOrder).toEqual([]);
  });

  it("answers NOT_FOUND when no registration holds the submitted path on any instance", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "group/subgroup/project",
    })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No GitLab registration matches that instance and project, so there is nothing to unregister.",
    });
    expect(harness.forgeIdentityLookups).toEqual([
      { provider: "gitlab", instanceUrl, ownerName: "group/subgroup/project" },
    ]);
    expect(harness.callOrder).toEqual([]);
  });

  it("answers NOT_FOUND for an unregistered forge id", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "4242",
    })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No GitLab registration matches that instance and project, so there is nothing to unregister.",
    });
    expect(harness.forgeIdentityLookups).toEqual([
      { provider: "gitlab", instanceUrl, forgeProjectId: 4242 },
    ]);
    expect(harness.callOrder).toEqual([]);
  });

  it("refuses someone other than the repository's sponsor before the write and without contacting any forge", async () => {
    const harness = createHarness({ existing: { ...registeredGitLabRepository(), sponsorId: "someone-else-id" } });

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "group/subgroup/project",
    })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only the repository's sponsor can unregister it.",
    });
    expect(harness.unregisterInputs).toEqual([]);
    expect(harness.callOrder).toEqual([]);
    expect(harness.githubCalls).toEqual([]);
  });

  it("maps a failing forge-identity lookup to UPSTREAM_FAILURE and exposes nothing of the store error", async () => {
    const harness = createHarness({
      existing: registeredGitLabRepository(),
      forgeStateLookupFailure: new Error("database connectivity secret"),
    });

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "group/subgroup/project",
    })).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to unregister the repository.",
    });
    expect(harness.callOrder).toEqual([]);
  });

  it("reports an idempotent repeat as already unregistered with the GitLab row carried", async () => {
    const harness = createHarness({
      existing: registeredGitLabRepository(),
      storeUnregisterOutcome: { kind: "ALREADY_UNREGISTERED", repository: registeredGitLabRepository() },
    });

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "group/subgroup/project",
    })).resolves.toMatchObject({
      repository: { id: "registered-gitlab-repository-id" },
      webhookDeleted: false,
      alreadyUnregistered: true,
    });
    expect(harness.callOrder).toEqual(["unregisterRepository:group/subgroup/project"]);
  });

  it("surfaces NOT_FOUND when the registration vanishes between the lookup and the write", async () => {
    const harness = createHarness({
      existing: registeredGitLabRepository(),
      storeUnregisterOutcome: { kind: "NOT_REGISTERED" },
    });

    await expect(unregisterRepository(harness.dependencies, {
      provider: "gitlab",
      instanceUrl,
      project: "group/subgroup/project",
    })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(harness.callOrder).toEqual(["unregisterRepository:group/subgroup/project"]);
  });

  it("refuses a submission with neither a repository reference nor a GitLab provider", async () => {
    const harness = createHarness();

    await expect(unregisterRepository(harness.dependencies, {})).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "Submit one GitHub repository as owner/name or a canonical GitHub URL.",
    });
    expect(harness.callOrder).toEqual([]);
  });
});

describe("abandoning the webhook a failed registration created", () => {
  // The compensating delete is no longer best-effort: the cleanup record is
  // written durably BEFORE the deletion is attempted, so even a webhook whose
  // deletion never completes stays known to Overflow and reachable by the drain.
  it("records the cleanup before attempting the deletion when both the save and the delete fail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      databaseFailure: true,
      deleteWebhookFailure: new GitHubApiError(500),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    expect(harness.callOrder).toEqual([
      "saveAbandonedWebhookCleanup:501",
      "deleteWebhook:501",
    ]);
    const diagnostic = String(consoleError.mock.calls[0]?.[0]);
    expect(diagnostic).toContain("octo/overflow");
    expect(diagnostic).toContain("501");
    expect(diagnostic).toContain("retained");
  });

  it("surfaces ROLLBACK_INCOMPLETE in place of the conflict when the deletion of the abandoned webhook fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      storeClaimedOwnerName: "octo/overflow",
      deleteWebhookFailure: new GitHubApiError(403),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    expect(harness.callOrder).toEqual([
      "saveAbandonedWebhookCleanup:501",
      "deleteWebhook:501",
    ]);
    const diagnostic = String(consoleError.mock.calls[0]?.[0]);
    expect(diagnostic).toContain("octo/overflow");
    expect(diagnostic).toContain("501");
    expect(diagnostic).toContain("retained");
  });

  it("clears the cleanup record and surfaces the original conflict when the compensating deletion succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({ storeClaimedOwnerName: "octo/overflow" });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(harness.callOrder).toEqual([
      "saveAbandonedWebhookCleanup:501",
      "deleteWebhook:501",
      "clearAbandonedWebhookCleanup:501",
    ]);
    expect(harness.deletedWebhookIds).toEqual([501]);
  });

  it("keeps the original mapping and reports the missing record when saving the cleanup record fails but the deletion succeeds", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      databaseFailure: true,
      saveAbandonedFailure: new Error("the cleanup insert failed"),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to save the repository registration.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
    expect(harness.callOrder).toEqual([
      "saveAbandonedWebhookCleanup:501",
      "deleteWebhook:501",
      "clearAbandonedWebhookCleanup:501",
    ]);
    const diagnostic = String(consoleError.mock.calls[0]?.[0]);
    expect(diagnostic).toContain("octo/overflow");
    expect(diagnostic).toContain("501");
    expect(diagnostic).toContain("could not be saved");
  });

  it("surfaces ROLLBACK_INCOMPLETE when the absent-row conflict's compensating deletion fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      storeRejectsAsDuplicateId: true,
      deleteWebhookFailure: new GitHubApiError(500),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    expect(harness.callOrder).toEqual([
      "saveAbandonedWebhookCleanup:501",
      "deleteWebhook:501",
    ]);
    const diagnostic = String(consoleError.mock.calls[0]?.[0]);
    expect(diagnostic).toContain("octo/overflow");
    expect(diagnostic).toContain("501");
    expect(diagnostic).toContain("retained");
  });

  // Issue 515: the ROLLBACK_INCOMPLETE diagnostics named only the webhook/record
  // state, so an operator could not tell a database outage from a constraint
  // conflict. The original save failure now rides into the diagnostic, bounded
  // and secret-safe; the public ROLLBACK_INCOMPLETE message is unchanged.
  it("carries the original save failure into the rollback-incomplete diagnostic", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      createRepositoryFailure: new Error("controlled save outage"),
      deleteWebhookFailure: new GitHubApiError(500),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    expect(harness.callOrder).toEqual([
      "saveAbandonedWebhookCleanup:501",
      "deleteWebhook:501",
    ]);
    const diagnostic = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(diagnostic).toContain("controlled save outage");
  });

  it("redacts credentials embedded in the save failure before it reaches the diagnostic", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      createRepositoryFailure: new Error(
        "could not connect: postgres://sponsor:hunter2@db.internal:5432/overflow",
      ),
      deleteWebhookFailure: new GitHubApiError(500),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    const diagnostic = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(diagnostic).not.toContain("hunter2");
    expect(diagnostic).toContain("postgres://***@db.internal:5432/overflow");
  });

  it("caps an overlong save failure's rendering in the diagnostic", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      createRepositoryFailure: new Error("x".repeat(400) + " OVERFLOW-MARKER"),
      deleteWebhookFailure: new GitHubApiError(500),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    const diagnostic = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    // The cause renders as "Error: <message>" and is cut at the 200-char cap:
    // 7 characters of prefix + 193 of the repeated x survive, nothing beyond.
    expect(diagnostic).toContain(`Error: ${"x".repeat(193)}`);
    expect(diagnostic).not.toContain("x".repeat(194));
    expect(diagnostic).not.toContain("OVERFLOW-MARKER");
  });

  it("names the arbiter decline rather than an unknown save error when the store returns no row and the deletion is unproven", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = createHarness({
      storeRejectsAsDuplicateId: true,
      deleteWebhookFailure: new GitHubApiError(500),
    });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "ROLLBACK_INCOMPLETE",
    });
    const diagnostic = consoleError.mock.calls.map((call) => String(call[0])).join("\n");
    expect(diagnostic).toContain(
      "the store's on-conflict arbiter declined the save (another registration holds the GitHub path)",
    );
  });
});

describe("describing a save failure's cause for operator diagnostics", () => {
  it("renders an Error as its name and message", () => {
    expect(describeErrorCause(new Error("controlled save outage"))).toBe("Error: controlled save outage");
  });

  it("renders a non-Error rejection through String", () => {
    expect(describeErrorCause("plain string rejection")).toBe("plain string rejection");
    expect(describeErrorCause(42)).toBe("42");
    expect(describeErrorCause(undefined)).toBe("undefined");
  });

  it("renders an Error with an empty message through String", () => {
    expect(describeErrorCause(new Error(""))).toBe("Error");
  });

  it("collapses newlines so the diagnostic stays one line", () => {
    const rendered = describeErrorCause(new Error("line one\nline two\r\nline three"));
    expect(rendered).toBe("Error: line one line two line three");
    expect(rendered).not.toMatch(/[\r\n]/);
  });

  it("redacts credentials in a connection URL", () => {
    const rendered = describeErrorCause(
      new Error("could not connect: postgres://sponsor:hunter2@db.internal:5432/overflow"),
    );
    expect(rendered).not.toContain("hunter2");
    expect(rendered).toContain("postgres://***@db.internal:5432/overflow");
  });

  it("redacts password= and password: fragments to password=***", () => {
    expect(describeErrorCause(new Error("auth failed: password=hunter2"))).toBe("Error: auth failed: password=***");
    expect(describeErrorCause(new Error("auth failed: password: hunter2"))).toBe("Error: auth failed: password=***");
  });

  it("caps the rendering at 200 characters and drops the tail", () => {
    const rendered = describeErrorCause(new Error("x".repeat(400) + " OVERFLOW-MARKER"));
    expect(rendered).toHaveLength(200);
    expect(rendered).not.toContain("OVERFLOW-MARKER");
  });

  it("renders the same error identically on every call", () => {
    const error = new Error("deterministic failure: password=sekret");
    expect(describeErrorCause(error)).toBe(describeErrorCause(error));
    expect(describeErrorCause(error)).not.toContain("sekret");
  });
});

describe("draining the abandoned webhook cleanup records", () => {
  function cleanupRecord(webhookId: number, createdAt: string, overrides: {
    provider?: "github" | "gitlab";
    instanceUrl?: string | null;
    ownerName?: string;
    githubRepositoryId?: number;
  } = {}) {
    return {
      githubRepositoryId: 42,
      ownerName: "octo/overflow",
      webhookId,
      createdAt,
      provider: "github" as const,
      instanceUrl: null as string | null,
      ...overrides,
    };
  }

  it("clears a record whose active registration holds the same webhook id without deleting anything", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z")],
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "github", webhookId: 501 }]);
    expect(harness.deletedWebhookIds).toEqual([]);
    expect(harness.deleteWebhookReferences).toEqual([]);
  });

  it("resolves the repository by id and deletes the recorded webhook through the name GitHub serves now", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      existingUnregistered: true,
      abandonedRecords: [{ ...cleanupRecord(501, "2020-01-01T00:00:00.000Z"), ownerName: "octo/old-name" }],
      resolvedByIdRepository: githubRepositoryFixture({
        name: "new-name",
        fullName: "octo/new-name",
        url: "https://github.com/octo/new-name",
      }),
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.repositoryByIdLookups).toEqual([42]);
    expect(harness.deleteWebhookReferences).toEqual([{ owner: "octo", name: "new-name" }]);
    expect(harness.deletedWebhookIds).toEqual([501]);
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "github", webhookId: 501 }]);
  });

  it("keeps the record when the deletion at the resolved path fails without a proven 404", async () => {
    const harness = createHarness({
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z")],
      deleteWebhookFailure: new GitHubApiError(403),
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.deleteWebhookReferences).toEqual([{ owner: "octo", name: "overflow" }]);
    expect(harness.abandonedClears).toEqual([]);
  });

  it("reads a 404 at the resolved current path as proven and clears the record", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      existingUnregistered: true,
      abandonedRecords: [{ ...cleanupRecord(501, "2020-01-01T00:00:00.000Z"), ownerName: "octo/old-name" }],
      resolvedByIdRepository: githubRepositoryFixture({
        name: "new-name",
        fullName: "octo/new-name",
        url: "https://github.com/octo/new-name",
      }),
      deleteWebhookFailure: new GitHubApiError(404),
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.repositoryByIdLookups).toEqual([42]);
    expect(harness.deleteWebhookReferences).toEqual([{ owner: "octo", name: "new-name" }]);
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "github", webhookId: 501 }]);
  });

  it("clears the record without touching webhooks when the id no longer resolves to a repository", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      existingUnregistered: true,
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z")],
      resolvedByIdRepository: null,
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.repositoryByIdLookups).toEqual([42]);
    expect(harness.deletedWebhookIds).toEqual([]);
    expect(harness.deleteWebhookReferences).toEqual([]);
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "github", webhookId: 501 }]);
  });

  it("keeps the record and attempts no deletion when resolving the repository by id fails", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      existingUnregistered: true,
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z")],
      resolvedByIdRepository: new GitHubApiError(502),
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.deleteWebhookReferences).toEqual([]);
    expect(harness.abandonedClears).toEqual([]);
  });

  // The wiring itself is pinned here, not just the drain's branches: a seeded
  // record whose webhook id the flow never touches (777, against the flow's own
  // 501) can only be deleted and cleared by the drain the success path runs.
  it("drains a seeded cleanup record through a successful registration", async () => {
    const harness = createHarness({
      abandonedRecords: [cleanupRecord(777, "2020-01-01T00:00:00.000Z")],
    });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      id: "registered-repository-id",
      githubWebhookId: 501,
    });
    expect(harness.deletedWebhookIds).toEqual([777]);
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "github", webhookId: 777 }]);
  });

  it("drains a seeded cleanup record through a successful unregistration", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      abandonedRecords: [cleanupRecord(777, "2020-01-01T00:00:00.000Z")],
    });

    await expect(unregisterRepository(harness.dependencies, { repositoryUrl: "octo/overflow" })).resolves.toMatchObject({
      webhookDeleted: true,
      alreadyUnregistered: false,
    });
    // The flow deleted the registration's own webhook 501; only the drain touches 777.
    expect(harness.deletedWebhookIds).toEqual([501, 777]);
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "github", webhookId: 777 }]);
  });

  it("deletes a GitLab record through the GitLab gateway when the drain runs beside the record instance's identity", async () => {
    const gitlabRequests: Request[] = [];
    const harness = createHarness({
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z", {
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
        ownerName: "gl-group/project",
      })],
      forgeIdentity: { instanceUrl: "https://gitlab.example.com", token: "glpat-drain" },
      forgeFetch: async (input, init) => {
        const request = new Request(input, init);
        gitlabRequests.push(request);
        return new Response(null, { status: 204 });
      },
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(gitlabRequests.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "DELETE /api/v4/projects/gl-group%2Fproject/hooks/501",
    ]);
    expect(gitlabRequests[0]!.headers.get("authorization")).toBe("Bearer glpat-drain");
    // The GitHub gateway is never consulted for a GitLab record.
    expect(harness.deleteWebhookReferences).toEqual([]);
    expect(harness.deletedWebhookIds).toEqual([]);
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "gitlab", webhookId: 501 }]);
  });

  it("keeps a GitLab record when the identity at hand names another instance, and when there is none", async () => {
    const record = cleanupRecord(501, "2020-01-01T00:00:00.000Z", {
      provider: "gitlab",
      instanceUrl: "https://gitlab.example.com",
      ownerName: "gl-group/project",
    });
    // The transport would delete if asked — so the instance match is the only
    // thing standing between the record and its deletion, and the test fails
    // if the guard is dropped.
    const willingTransport = async () => new Response(null, { status: 204 });
    for (const forgeIdentity of [{ instanceUrl: "https://other.example.com", token: "glpat-x" }, null]) {
      const harness = createHarness({ abandonedRecords: [record], forgeIdentity, forgeFetch: willingTransport });
      await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
      expect(harness.abandonedClears).toEqual([]);
    }
  });

  it("reads a GitLab 404 as the hook already gone and clears the record", async () => {
    const harness = createHarness({
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z", {
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
        ownerName: "gl-group/project",
      })],
      forgeIdentity: { instanceUrl: "https://gitlab.example.com", token: "glpat-drain" },
      forgeFetch: async () => new Response(null, { status: 404 }),
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "gitlab", webhookId: 501 }]);
  });

  it("keeps the GitLab record when the deletion is refused without a 404", async () => {
    const harness = createHarness({
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z", {
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
        ownerName: "gl-group/project",
      })],
      forgeIdentity: { instanceUrl: "https://gitlab.example.com", token: "glpat-drain" },
      forgeFetch: async () => new Response("refused", { status: 403 }),
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.abandonedClears).toEqual([]);
  });

  it("spares a GitLab record whose active registration holds the same webhook id, clearing it without a deletion call", async () => {
    const harness = createHarness({
      existing: registeredRepository(),
      abandonedRecords: [cleanupRecord(501, "2020-01-01T00:00:00.000Z", {
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
        ownerName: "gl-group/project",
      })],
      forgeIdentity: { instanceUrl: "https://gitlab.example.com", token: "glpat-drain" },
      forgeFetch: async () => {
        throw new Error("a wanted hook must not be deleted");
      },
    });

    await expect(drainAbandonedWebhooks(harness.dependencies)).resolves.toBeUndefined();
    expect(harness.abandonedClears).toEqual([{ githubRepositoryId: 42, provider: "gitlab", webhookId: 501 }]);
  });
});

type HarnessOptions = {
  actorRole?: "MEMBER" | "MODERATOR";
  actorEnforcementState?: "ACTIVE" | "UNDER_AUDIT" | "WARNED" | "RECALIBRATING" | "BANNED";
  canAdminister?: boolean;
  owner?: string;
  name?: string;
  ownerType?: "USER" | "ORGANIZATION";
  visibility?: "PUBLIC" | "PRIVATE";
  existing?: RegisteredRepository | null;
  /** The held row reads as sponsor-unregistered: the register path reactivates, not conflicts. */
  existingUnregistered?: boolean;
  /** The outcome the fake unregister write answers with (default: unregisters the held row). */
  storeUnregisterOutcome?: RepositoryUnregisterOutcome;
  /** The rejection the fake unregister write raises (after recording the call). */
  storeUnregisterFailure?: unknown;
  /** The rejection the by-owner-name state lookup raises. */
  stateLookupFailure?: unknown;
  /** The rejection the by-forge-identity state lookup raises. */
  forgeStateLookupFailure?: unknown;
  /** The rejection the fake webhook deletion raises (after recording the call). */
  deleteWebhookFailure?: unknown;
  /** What the store answers for the drain's list of abandoned-webhook cleanup records. */
  abandonedRecords?: Array<{
    githubRepositoryId: number;
    ownerName: string;
    webhookId: number;
    createdAt: string;
    provider?: "github" | "gitlab";
    instanceUrl?: string | null;
  }>;
  /** The registering actor's linked GitLab identity, handed to the drain's GitLab arm. */
  forgeIdentity?: { instanceUrl: string; token: string } | null;
  /** Injectable transport for the drain's GitLab gateway. */
  forgeFetch?: typeof fetch;
  /** The rejection the fake cleanup-record write raises (after recording the call). */
  saveAbandonedFailure?: unknown;
  /** The rejection the fake cleanup-record clear raises (after recording the call). */
  clearAbandonedFailure?: unknown;
  /** The label names the fake GitHub answers `listRepositoryLabels` with. */
  repositoryLabels?: readonly string[];
  /** The rejection the fake createRepository raises (after recording the call). */
  createRepositoryFailure?: unknown;
  webhookFailure?: boolean;
  /** What the fake GitHub answers `getRepositoryById` with: a repository, null for a deleted repository, or a rejection to throw. Default: the repository under its stored name. */
  resolvedByIdRepository?: GitHubRepository | null | Error;
  databaseFailure?: boolean;
  storeRejectsAsDuplicateId?: boolean;
  storeClaimedOwnerName?: string;
  storeClaimedWebhookId?: number;
  storeRejectsSponsorAsIneligible?: boolean;
  storeRaisesRegistrationError?: boolean;
  scheduleFailure?: boolean;
  withoutScheduleInitialImport?: boolean;
  workflows?: ClaimPathEvidence[];
  workflowFailure?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const githubCalls: string[] = [];
  const deletedWebhookIds: number[] = [];
  const deleteWebhookReferences: Array<{ owner: string; name: string }> = [];
  const repositoryByIdLookups: number[] = [];
  const duplicateLookupIds: number[] = [];
  const stateLookupIds: number[] = [];
  const stateLookupsByOwnerName: string[] = [];
  const forgeIdentityLookups: Array<{ provider: string; instanceUrl: string; forgeProjectId?: number; ownerName?: string }> = [];
  const unregisterInputs: Array<{ ownerName: string; sponsorId: string }> = [];
  const callOrder: string[] = [];
  const scheduledRepositoryIds: string[] = [];
  const workflowReadRepositoryCounts: number[] = [];
  const abandonedSaves: Array<{
    githubRepositoryId: number;
    ownerName: string;
    webhookId: number;
    createdAt: string;
    provider: "github" | "gitlab";
    instanceUrl: string | null;
  }> = [];
  const abandonedClears: Array<{ githubRepositoryId: number; provider: "github" | "gitlab"; webhookId: number }> = [];
  const createdRepositories: Array<Parameters<RepositoryRegistrationDependencies["store"]["createRepository"]>[0]> = [];

  const existingState = (): RepositoryRegistrationState | null =>
    options.existing === null || options.existing === undefined
      ? null
      : {
          repository: options.existing,
          unregisteredAt: options.existingUnregistered === true ? "2020-01-01T00:00:00.000Z" : null,
        };

  const actor = {
    id: "moderator-id",
    role: options.actorRole ?? "MODERATOR",
    ...(options.actorEnforcementState === undefined
      ? {}
      : { enforcementState: options.actorEnforcementState }),
  };
  const dependencies: RepositoryRegistrationDependencies = {
    actor,
    github: {
      async getRepository(repository) {
        githubCalls.push(`getRepository:${repository.owner}/${repository.name}`);
        return {
          id: 42,
          owner: options.owner ?? "octo",
          ownerType: options.ownerType ?? "USER",
          name: options.name ?? "overflow",
          fullName: `${options.owner ?? "octo"}/${options.name ?? "overflow"}`,
          visibility: options.visibility ?? "PUBLIC",
          url: `https://github.com/${options.owner ?? "octo"}/${options.name ?? "overflow"}`,
          canAdminister: options.canAdminister ?? true,
        };
      },
      async getRepositoryById(githubRepositoryId) {
        callOrder.push(`getRepositoryById:${githubRepositoryId}`);
        repositoryByIdLookups.push(githubRepositoryId);
        if (options.resolvedByIdRepository instanceof Error) {
          throw options.resolvedByIdRepository;
        }
        if (options.resolvedByIdRepository !== undefined) {
          return options.resolvedByIdRepository;
        }
        return githubRepositoryFixture({ id: githubRepositoryId });
      },
      async listRepositoryLabels(repository) {
        githubCalls.push(`listRepositoryLabels:${repository.owner}/${repository.name}`);
        return new Set(options.repositoryLabels ?? defaultRepositoryLabels());
      },
      async createWebhook(repository) {
        githubCalls.push(`createWebhook:${repository.owner}/${repository.name}`);
        if (options.webhookFailure) {
          throw new Error("webhook upstream response contained secret text");
        }
        return { id: 501 };
      },
      async deleteWebhook(repository, webhookId) {
        callOrder.push(`deleteWebhook:${webhookId}`);
        deleteWebhookReferences.push(repository);
        if (options.deleteWebhookFailure !== undefined) {
          throw options.deleteWebhookFailure;
        }
        deletedWebhookIds.push(webhookId);
      },
      async listWorkflowFiles(repository) {
        githubCalls.push(`listWorkflowFiles:${repository.owner}/${repository.name}`);
        workflowReadRepositoryCounts.push(createdRepositories.length);
        if (options.workflowFailure) {
          throw new Error("workflow read failed");
        }
        return options.workflows ?? [];
      },
    },
    store: {
      async findRepositoryByGitHubId(githubRepositoryId) {
        duplicateLookupIds.push(githubRepositoryId);
        return options.existing ?? null;
      },
      async findRepositoryProviderById() {
        return null;
      },
      async findRepositoryRegistrationStateByOwnerName(ownerName: string) {
        stateLookupsByOwnerName.push(ownerName);
        if (options.stateLookupFailure !== undefined) {
          throw options.stateLookupFailure;
        }
        return existingState();
      },
      async findRepositoryRegistrationState(githubRepositoryId) {
        stateLookupIds.push(githubRepositoryId);
        return existingState();
      },
      async findRepositoryRegistrationStateByForgeIdentity(input) {
        forgeIdentityLookups.push(input);
        if (options.forgeStateLookupFailure !== undefined) {
          throw options.forgeStateLookupFailure;
        }
        return existingState();
      },
      async unregisterRepository(input) {
        callOrder.push(`unregisterRepository:${input.ownerName}`);
        unregisterInputs.push(input);
        if (options.storeUnregisterFailure !== undefined) {
          throw options.storeUnregisterFailure;
        }
        return options.storeUnregisterOutcome ?? { kind: "UNREGISTERED", repository: registeredRepository() };
      },
      async appendDifficultySchemeVersion() {
        return null;
      },
      async saveAbandonedWebhookCleanup(record) {
        callOrder.push(`saveAbandonedWebhookCleanup:${record.webhookId}`);
        if (options.saveAbandonedFailure !== undefined) {
          throw options.saveAbandonedFailure;
        }
        abandonedSaves.push(record);
      },
      async listAbandonedWebhookCleanups() {
        return (options.abandonedRecords ?? []).map((record) => ({
          provider: "github" as const,
          instanceUrl: null as string | null,
          ...record,
        }));
      },
      async clearAbandonedWebhookCleanup(githubRepositoryId, provider, webhookId) {
        callOrder.push(`clearAbandonedWebhookCleanup:${webhookId}`);
        if (options.clearAbandonedFailure !== undefined) {
          throw options.clearAbandonedFailure;
        }
        abandonedClears.push({ githubRepositoryId, provider, webhookId });
      },
      async createRepository(repository) {
        createdRepositories.push(repository);
        if (options.createRepositoryFailure !== undefined) {
          throw options.createRepositoryFailure;
        }
        if (options.databaseFailure) {
          throw new Error("database connectivity failure");
        }
        if (options.storeClaimedOwnerName !== undefined) {
          throw new RepositoryOwnerNameConflictError(options.storeClaimedOwnerName);
        }
        if (options.storeClaimedWebhookId !== undefined) {
          throw new RepositoryWebhookIdConflictError(options.storeClaimedWebhookId);
        }
        if (options.storeRejectsSponsorAsIneligible === true) {
          throw new RepositoryRegistrationEnforcementError();
        }
        if (options.storeRaisesRegistrationError === true) {
          // A store, decorator or retry wrapper may raise the registration error type itself:
          // the injected interface only promises a resolved value, never which errors it throws.
          throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "database connectivity failure");
        }
        if (options.storeRejectsAsDuplicateId === true) {
          return null;
        }
        return registeredRepository();
      },
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
      secret: "webhook-secret-for-test",
    },
    ...(options.forgeIdentity !== undefined ? { forgeIdentity: options.forgeIdentity } : {}),
    ...(options.forgeFetch !== undefined ? { forgeFetch: options.forgeFetch } : {}),
    ...(options.withoutScheduleInitialImport === true
      ? {}
      : {
          async scheduleInitialImport(repositoryId: string) {
            scheduledRepositoryIds.push(repositoryId);
            if (options.scheduleFailure) {
              throw new Error("the reconciliation job could not be enqueued");
            }
          },
        }),
  };

  return {
    dependencies,
    githubCalls,
    deletedWebhookIds,
    deleteWebhookReferences,
    repositoryByIdLookups,
    duplicateLookupIds,
    stateLookupIds,
    stateLookupsByOwnerName,
    forgeIdentityLookups,
    unregisterInputs,
    callOrder,
    createdRepositories,
    abandonedSaves,
    abandonedClears,
    scheduledRepositoryIds,
    workflowReadRepositoryCounts,
  };
}

function createInput(
  overrides: Partial<RepositoryRegistrationInput> = {},
): RepositoryRegistrationInput {
  return {
    repositoryUrl: "https://github.com/octo/overflow.git",
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "size/S", comparisonPoints: 2, reservePoints: 2 },
      { label: "size/M", comparisonPoints: 5, reservePoints: 5 },
      { label: "size/L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: actualLabels(),
    ...overrides,
  };
}

function actualLabels() {
  return Array.from({ length: 10 }, (_, index) => ({
    label: `delivered/${index + 1}`,
    points: index + 1,
  }));
}

/** Every label the default submitted scheme names — the fake GitHub starts from a complete repository. */
function defaultRepositoryLabels(): string[] {
  return [...createInput().openingLabels, ...createInput().actualLabels].map(({ label }) => label);
}

function toDifficultyScheme(input: RepositoryRegistrationInput): DifficultyScheme {
  return {
    openingName: input.openingName,
    actualName: input.actualName,
    openingLabels: input.openingLabels,
    actualLabels: input.actualLabels,
  };
}

function registeredRepository(): RegisteredRepository {
  return {
    id: "registered-repository-id",
    githubRepositoryId: 42,
    ownerName: "octo/overflow",
    sponsorId: "moderator-id",
    visibility: "PUBLIC",
    githubWebhookId: 501,
  };
}

/** A GitLab registration row: a nested group's path, no webhook, its own id. */
function registeredGitLabRepository(): RegisteredRepository {
  return {
    id: "registered-gitlab-repository-id",
    githubRepositoryId: 4242,
    ownerName: "group/subgroup/project",
    sponsorId: "moderator-id",
    visibility: "PUBLIC",
    githubWebhookId: null,
  };
}

function githubRepositoryFixture(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 42,
    owner: "octo",
    ownerType: "USER",
    name: "overflow",
    fullName: "octo/overflow",
    visibility: "PUBLIC",
    url: "https://github.com/octo/overflow",
    canAdminister: true,
    ...overrides,
  };
}
