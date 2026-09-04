import { describe, expect, it } from "vitest";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  RegisteredRepository,
  RepositoryRegistrationDependencies,
  RepositoryRegistrationInput,
} from "@/lib/repositories/register";
import { parseGitHubRepository, registerRepository } from "@/lib/repositories/register";

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

  it("rejects a repository that is already registered before creating a webhook", async () => {
    const existing = registeredRepository();
    const harness = createHarness({ existing });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(harness.githubCalls).toEqual(["getRepository:octo/overflow"]);
    expect(harness.createdRepositories).toEqual([]);
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
      message: "Unable to register the repository with GitHub.",
    });
    expect(harness.createdRepositories).toEqual([]);
  });

  it("best-effort deletes the webhook when database persistence fails", async () => {
    const harness = createHarness({ databaseFailure: true });

    await expect(registerRepository(harness.dependencies, createInput())).rejects.toMatchObject({
      code: "UPSTREAM_FAILURE",
      message: "Unable to save the repository registration.",
    });
    expect(harness.deletedWebhookIds).toEqual([501]);
  });
});

type HarnessOptions = {
  actorRole?: "MEMBER" | "MODERATOR";
  actorEnforcementState?: "ACTIVE" | "UNDER_AUDIT" | "WARNED" | "RECALIBRATING" | "BANNED";
  canAdminister?: boolean;
  existing?: RegisteredRepository | null;
  webhookFailure?: boolean;
  databaseFailure?: boolean;
};

function createHarness(options: HarnessOptions = {}) {
  const githubCalls: string[] = [];
  const configuredLabels: string[] = [];
  const deletedWebhookIds: number[] = [];
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
          owner: "octo",
          name: "overflow",
          fullName: "octo/overflow",
          visibility: "PUBLIC",
          url: "https://github.com/octo/overflow",
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
      async findRepositoryByGitHubId() {
        return options.existing ?? null;
      },
      async createRepository(repository) {
        createdRepositories.push(repository);
        if (options.databaseFailure) {
          throw new Error("database connectivity failure");
        }
        return registeredRepository();
      },
    },
    webhook: {
      callbackUrl: "https://overflow.example/api/github/webhooks",
      secret: "webhook-secret-for-test",
    },
  };

  return { dependencies, githubCalls, configuredLabels, deletedWebhookIds, createdRepositories };
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
