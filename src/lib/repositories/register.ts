import { isParticipationEligible, type EnforcementState, type UserRole } from "@/lib/db/types";
import {
  validateDifficultyScheme,
  type ActualDifficultyLabel,
  type DifficultyScheme,
  type OpeningDifficultyLabel,
} from "@/lib/domain/difficulty-scheme";
import type {
  GitHubRepository,
  GitHubRepositoryReference,
  GitHubWebhook,
  GitHubWebhookConfiguration,
} from "@/lib/github/types";

export type RepositoryRegistrationInput = {
  repositoryUrl: string;
  openingName: string;
  actualName: string;
  openingLabels: OpeningDifficultyLabel[];
  actualLabels: ActualDifficultyLabel[];
};

export type RegisteredRepository = {
  id: string;
  githubRepositoryId: number;
  ownerName: string;
  sponsorId: string;
  visibility: "PUBLIC" | "PRIVATE";
  githubWebhookId: number;
};

export type NewRegisteredRepository = Omit<RegisteredRepository, "id"> & {
  difficultyScheme: DifficultyScheme;
};

export type RepositoryRegistrationGateway = {
  getRepository(repository: GitHubRepositoryReference): Promise<GitHubRepository>;
  ensureDifficultyLabels(repository: GitHubRepositoryReference, labels: readonly string[]): Promise<void>;
  createWebhook(
    repository: GitHubRepositoryReference,
    configuration: GitHubWebhookConfiguration,
  ): Promise<GitHubWebhook>;
  deleteWebhook(repository: GitHubRepositoryReference, webhookId: number): Promise<void>;
};

export type RepositoryRegistrationStore = {
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<RegisteredRepository | null>;
  createRepository(repository: NewRegisteredRepository): Promise<RegisteredRepository | null>;
};

export type RepositoryRegistrationDependencies = {
  actor: { id: string; role: UserRole; enforcementState?: EnforcementState };
  github: RepositoryRegistrationGateway;
  store: RepositoryRegistrationStore;
  webhook: GitHubWebhookConfiguration;
};

export class RepositoryRegistrationError extends Error {
  public constructor(
    public readonly code: "CONFLICT" | "FORBIDDEN" | "INVALID_INPUT" | "UPSTREAM_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "RepositoryRegistrationError";
  }
}

export class RepositoryRegistrationEnforcementError extends Error {
  public constructor() {
    super("The account is not eligible to register repositories.");
    this.name = "RepositoryRegistrationEnforcementError";
  }
}

export async function registerRepository(
  dependencies: RepositoryRegistrationDependencies,
  input: RepositoryRegistrationInput,
): Promise<RegisteredRepository> {
  if (
    dependencies.actor.enforcementState !== undefined &&
    !isParticipationEligible(dependencies.actor.enforcementState)
  ) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "The account is not eligible to register repositories.",
    );
  }

  const difficultyScheme = toDifficultyScheme(input);
  const validation = validateDifficultyScheme(difficultyScheme);
  if (!validation.ok) {
    throw new RepositoryRegistrationError("INVALID_INPUT", validation.reason);
  }

  let submittedRepository: GitHubRepositoryReference;
  try {
    submittedRepository = parseGitHubRepository(input.repositoryUrl);
  } catch {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      "Submit one GitHub repository as owner/name or a canonical GitHub URL.",
    );
  }

  const repository = await getSubmittedRepository(dependencies.github, submittedRepository);
  if (!repository.canAdminister) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "GitHub administrator permission is required for the submitted repository.",
    );
  }

  const existing = await findExistingRepository(dependencies.store, repository.id);
  if (existing !== null) {
    throw new RepositoryRegistrationError("CONFLICT", "This GitHub repository is already registered.");
  }

  const labels = [...difficultyScheme.openingLabels, ...difficultyScheme.actualLabels].map((label) => label.label);
  let webhook: GitHubWebhook;
  try {
    await dependencies.github.ensureDifficultyLabels(submittedRepository, labels);
    webhook = await dependencies.github.createWebhook(submittedRepository, dependencies.webhook);
  } catch {
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to register the repository with GitHub.");
  }

  try {
    const created = await dependencies.store.createRepository({
      githubRepositoryId: repository.id,
      ownerName: repository.fullName,
      sponsorId: dependencies.actor.id,
      visibility: repository.visibility,
      githubWebhookId: webhook.id,
      difficultyScheme,
    });
    if (created === null) {
      await deleteWebhookBestEffort(dependencies.github, submittedRepository, webhook.id);
      throw new RepositoryRegistrationError("CONFLICT", "This GitHub repository is already registered.");
    }

    return created;
  } catch (error) {
    if (error instanceof RepositoryRegistrationError) {
      throw error;
    }

    if (error instanceof RepositoryRegistrationEnforcementError) {
      await deleteWebhookBestEffort(dependencies.github, submittedRepository, webhook.id);
      throw new RepositoryRegistrationError(
        "FORBIDDEN",
        "The account is not eligible to register repositories.",
      );
    }

    await deleteWebhookBestEffort(dependencies.github, submittedRepository, webhook.id);
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the repository registration.");
  }
}

export function parseGitHubRepository(value: string): GitHubRepositoryReference {
  const submitted = value.trim();
  const shorthand = submitted.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthand !== null) {
    return toRepositoryReference(shorthand[1], shorthand[2]);
  }

  let url: URL;
  try {
    url = new URL(submitted);
  } catch {
    throw new Error("Invalid GitHub repository URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.port.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("Invalid GitHub repository URL.");
  }

  const pathSegments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length !== 2) {
    throw new Error("Invalid GitHub repository URL.");
  }

  return toRepositoryReference(pathSegments[0], pathSegments[1]);
}

function toDifficultyScheme(input: RepositoryRegistrationInput): DifficultyScheme {
  return {
    openingName: input.openingName,
    actualName: input.actualName,
    openingLabels: input.openingLabels,
    actualLabels: input.actualLabels,
  };
}

function toRepositoryReference(owner: string, repositoryName: string): GitHubRepositoryReference {
  const name = repositoryName.replace(/\.git$/i, "");
  if (!isGitHubRepositorySegment(owner) || !isGitHubRepositorySegment(name)) {
    throw new Error("Invalid GitHub repository URL.");
  }

  return { owner, name };
}

function isGitHubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

async function getSubmittedRepository(
  github: RepositoryRegistrationGateway,
  repository: GitHubRepositoryReference,
): Promise<GitHubRepository> {
  try {
    return await github.getRepository(repository);
  } catch {
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to retrieve the submitted GitHub repository.");
  }
}

async function findExistingRepository(
  store: RepositoryRegistrationStore,
  githubRepositoryId: number,
): Promise<RegisteredRepository | null> {
  try {
    return await store.findRepositoryByGitHubId(githubRepositoryId);
  } catch {
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the repository registration.");
  }
}

async function deleteWebhookBestEffort(
  github: RepositoryRegistrationGateway,
  repository: GitHubRepositoryReference,
  webhookId: number,
): Promise<void> {
  try {
    await github.deleteWebhook(repository, webhookId);
  } catch {
    // The database error remains the safe response; a later reconciliation can retry deletion.
  }
}
