import { describe, expect, it } from "vitest";
import { GitHubApiError } from "@/lib/github/errors";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  RegisteredRepository,
  RepositoryRegistrationDependencies,
  RepositoryRegistrationInput,
} from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
  RepositoryRegistrationError,
  RepositoryWebhookIdConflictError,
  parseGitHubRepository,
  registerRepository,
} from "@/lib/repositories/register";

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
    expect(harness.configuredLabels).toEqual([
      "size/S",
      "size/M",
      "size/L",
      "delivered/1",
      "delivered/2",
      "delivered/3",
      "delivered/4",
      "delivered/5",
      "delivered/6",
      "delivered/7",
      "delivered/8",
      "delivered/9",
      "delivered/10",
    ]);
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "ensureDifficultyLabels:octo/overflow",
      "createWebhook:octo/overflow",
    ]);
    expect(harness.githubCalls.some((call) => call.includes("listAccessibleRepositories"))).toBe(false);
  });

  it("allows a signed-in member who has GitHub administrator permission for the submitted repository", async () => {
    const harness = createHarness({ actorRole: "MEMBER" });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      githubRepositoryId: 42,
    });
    expect(harness.githubCalls).toEqual([
      "getRepository:octo/overflow",
      "ensureDifficultyLabels:octo/overflow",
      "createWebhook:octo/overflow",
    ]);
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
        "ensureDifficultyLabels:octo/overflow",
        "createWebhook:octo/overflow",
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

  it("rejects a private repository before duplicate lookup, label creation, webhook creation, or persistence", async () => {
    const harness = createHarness({ visibility: "PRIVATE" });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Only public GitHub repositories can be registered.",
    });
    expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    expect(harness.duplicateLookupIds).toEqual([]);
    expect(harness.configuredLabels).toEqual([]);
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
    ["ensureDifficultyLabels", "configure difficulty labels", 403, "ORGANIZATION"],
    ["ensureDifficultyLabels", "configure difficulty labels", 404, "ORGANIZATION"],
    ["createWebhook", "create the repository webhook", 403, "ORGANIZATION"],
    ["createWebhook", "create the repository webhook", 404, "ORGANIZATION"],
    ["ensureDifficultyLabels", "configure difficulty labels", 403, "USER"],
    ["ensureDifficultyLabels", "configure difficulty labels", 404, "USER"],
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
    if (step === "ensureDifficultyLabels") {
      expect(message).not.toContain("webhook");
      expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    }
    expect(harness.createdRepositories).toEqual([]);
  });

  it.each([
    ["ensureDifficultyLabels", new Error("network secret"), "Unable to configure difficulty labels on GitHub."],
    ["createWebhook", new Error("network secret"), "Unable to create the repository webhook on GitHub."],
    ["ensureDifficultyLabels", new GitHubApiError(500), "Unable to configure difficulty labels on GitHub."],
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
    ["ensureDifficultyLabels", "configure difficulty labels", "Unable to configure difficulty labels on GitHub."],
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
      [401, "UPSTREAM_FAILURE"],
      [422, "UPSTREAM_FAILURE"],
      [429, "GITHUB_RATE_LIMITED"],
      [500, "UPSTREAM_FAILURE"],
    ] as const)("classifies unthrottled HTTP %s as %s", async (status, code) => {
      const harness = createHarness();
      harness.dependencies.github[step] = async () => { throw new GitHubApiError(status); };

      await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
        code,
        message: status === 429
          ? `GitHub rate-limited the request to ${description} (HTTP 429). Please retry registration later.`
          : upstreamMessage,
      });
      expect(harness.createdRepositories).toEqual([]);
    });

    it.each([
      [403, 60, " Retry after 60 seconds."],
      [404, null, ""],
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
  });

  it("best-effort deletes the webhook when database persistence fails", async () => {
    const harness = createHarness({ databaseFailure: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to save the repository registration.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
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
    const harness = createHarness({ scheduleFailure: true });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      id: "registered-repository-id",
      initialImportScheduled: false,
    });

    expect(harness.createdRepositories).toHaveLength(1);
    expect(harness.deletedWebhookIds).toEqual([]);
  });

  it("reports an unscheduled import when no scheduler is wired up", async () => {
    const harness = createHarness({ withoutScheduleInitialImport: true });

    await expect(registerRepository(harness.dependencies, createInput())).resolves.toMatchObject({
      initialImportScheduled: false,
    });
  });
});

type HarnessOptions = {
  actorRole?: "MEMBER" | "MODERATOR";
  actorEnforcementState?: "ACTIVE" | "UNDER_AUDIT" | "WARNED" | "RECALIBRATING" | "BANNED";
  canAdminister?: boolean;
  owner?: string;
  ownerType?: "USER" | "ORGANIZATION";
  visibility?: "PUBLIC" | "PRIVATE";
  existing?: RegisteredRepository | null;
  webhookFailure?: boolean;
  databaseFailure?: boolean;
  storeRejectsAsDuplicateId?: boolean;
  storeClaimedOwnerName?: string;
  storeClaimedWebhookId?: number;
  storeRejectsSponsorAsIneligible?: boolean;
  storeRaisesRegistrationError?: boolean;
  scheduleFailure?: boolean;
  withoutScheduleInitialImport?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const githubCalls: string[] = [];
  const configuredLabels: string[] = [];
  const deletedWebhookIds: number[] = [];
  const duplicateLookupIds: number[] = [];
  const scheduledRepositoryIds: string[] = [];
  const createdRepositories: Array<Parameters<RepositoryRegistrationDependencies["store"]["createRepository"]>[0]> = [];

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
          name: "overflow",
          fullName: `${options.owner ?? "octo"}/overflow`,
          visibility: options.visibility ?? "PUBLIC",
          url: `https://github.com/${options.owner ?? "octo"}/overflow`,
          canAdminister: options.canAdminister ?? true,
        };
      },
      async ensureDifficultyLabels(repository, labels) {
        githubCalls.push(`ensureDifficultyLabels:${repository.owner}/${repository.name}`);
        configuredLabels.push(...labels);
      },
      async createWebhook(repository) {
        githubCalls.push(`createWebhook:${repository.owner}/${repository.name}`);
        if (options.webhookFailure) {
          throw new Error("webhook upstream response contained secret text");
        }
        return { id: 501 };
      },
      async deleteWebhook(_repository, webhookId) {
        deletedWebhookIds.push(webhookId);
      },
    },
    store: {
      async findRepositoryByGitHubId(githubRepositoryId) {
        duplicateLookupIds.push(githubRepositoryId);
        return options.existing ?? null;
      },
      async createRepository(repository) {
        createdRepositories.push(repository);
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
    configuredLabels,
    deletedWebhookIds,
    duplicateLookupIds,
    createdRepositories,
    scheduledRepositoryIds,
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
