import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import { GitHubApiError, classifyGitHubApiFailure, isUnclassifiedGitHubFailure } from "@/lib/github/errors";
import type { GitHubRepository, GitHubRepositoryReference } from "@/lib/github/types";
import { plural } from "@/lib/plural";
import {
  drainAbandonedWebhooks,
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
  RepositoryRegistrationError,
  type RegisteredRepository,
  type RepositoryRegistrationDependencies,
  type RepositoryUnregisterApiResult,
  type RepositoryUnregisterOutcome,
} from "@/lib/repositories/register";

/** App setup runs after the shared repository checks and before any store write. */
export async function registerGitHubAppRepository(
  dependencies: RepositoryRegistrationDependencies,
  submittedRepository: GitHubRepositoryReference,
  repository: GitHubRepository,
  difficultyScheme: DifficultyScheme,
): Promise<RegisteredRepository> {
  if (dependencies.registrationApp == null) {
    throw new RepositoryRegistrationError("INVALID_INPUT", "Registration through the App is not available on this instance.");
  }
  let installation: { installationId: number } | null;
  try {
    installation = await dependencies.registrationApp.lookupInstallation(`${submittedRepository.owner}/${submittedRepository.name}`);
  } catch (error) {
    throw registrationAppLookupError(error);
  }
  if (installation === null) {
    throw new RepositoryRegistrationError("INVALID_INPUT", "Install the registration App on this repository first, then retry registration.");
  }
  let created: RegisteredRepository | null;
  try {
    created = await dependencies.store.createRepository({
      githubRepositoryId: repository.id, ownerName: repository.fullName, sponsorId: dependencies.actor.id,
      visibility: repository.visibility, registrationMethod: "app", githubWebhookId: null,
      webhookCredential: null, difficultyScheme,
    });
  } catch (error) {
    if (error instanceof RepositoryOwnerNameConflictError) {
      throw new RepositoryRegistrationError("CONFLICT",
        `The GitHub path ${error.ownerName} is claimed by a different registration. `
        + "The submitted repository is not registered, and it cannot be registered while another registration holds that path.");
    }
    if (error instanceof RepositoryRegistrationEnforcementError) {
      throw new RepositoryRegistrationError("FORBIDDEN", "The account is not eligible to register repositories.");
    }
    throw new RepositoryRegistrationError("UPSTREAM_FAILURE", "Unable to save the repository registration.");
  }
  if (created === null) {
    throw new RepositoryRegistrationError("CONFLICT", "This GitHub repository is already registered.");
  }
  return created;
}

/** Installation lookup authenticates as the instance's registration App, not its sponsor. */
function registrationAppLookupError(error: unknown): RepositoryRegistrationError {
  const step = "check the registration App installation";
  if (error instanceof GitHubApiError) {
    const failure = classifyGitHubApiFailure(error);
    if (failure === "CREDENTIALS") {
      return new RepositoryRegistrationError("GITHUB_CREDENTIALS",
        `GitHub rejected this instance's registration App credential (HTTP 401) while trying to ${step}. `
        + "Contact the instance operator to verify the registration App ID and private key, then retry registration.");
    }
    if (failure === "ACCESS") {
      const uncertainty = error.status === 403
        ? "GitHub answers 403 both when the registration App installation lookup is refused and when it is temporarily limiting requests, "
          + "and this response carries nothing that separates the two causes. Wait a minute and retry registration before changing anything. "
        : "";
      return new RepositoryRegistrationError("GITHUB_ACCESS",
        `GitHub refused to ${step} (HTTP ${error.status}). ` + uncertainty
        + "If the refusal persists, contact the instance operator to check the registration App configuration and its installation on this repository.");
    }
    if (failure === "RATE_LIMITED") {
      const delay = error.retryAfterSeconds === null ? "" : ` Retry after ${error.retryAfterSeconds} ${plural(error.retryAfterSeconds, "second")}.`;
      return new RepositoryRegistrationError("GITHUB_RATE_LIMITED",
        `GitHub rate-limited the request to ${step} (HTTP ${error.status}).${delay} Please retry registration later.`);
    }
  }
  return new RepositoryRegistrationError("UPSTREAM_FAILURE", `Unable to ${step} on GitHub.`);
}

/** Complete local unregistration with the cleanup and guidance for its GitHub method. */
export async function completeGitHubUnregistration(
  dependencies: RepositoryRegistrationDependencies,
  outcome: Extract<RepositoryUnregisterOutcome, { kind: "UNREGISTERED" | "ALREADY_UNREGISTERED" }>,
  registrationMethod: RegisteredRepository["registrationMethod"],
  webhookDeleted: boolean,
): Promise<RepositoryUnregisterApiResult> {
  // App unregistration retains GitHub cleanup records rather than issuing GitHub requests.
  // Other registrations still drain their abandoned hooks before returning the committed result.
  await drainAbandonedWebhooks(dependencies, registrationMethod !== "app");

  return {
    repository: outcome.repository,
    webhookDeleted,
    alreadyUnregistered: outcome.kind === "ALREADY_UNREGISTERED",
    ...(outcome.repository.registrationMethod === "app" ? { appAccessRemains: {
      message: "The GitHub App still has access to this repository. Manage its access in your GitHub installation settings.",
      url: "https://github.com/settings/installations",
    } } : {}),
  };
}

export function githubSetupError(
  error: unknown,
  repository: GitHubRepository | null,
  step: "check the registration App installation" | "retrieve the submitted GitHub repository" | "read the repository difficulty labels" | "create the repository webhook" | "delete the repository webhook",
): RepositoryRegistrationError {
  // Issue 93: a 401 means GitHub rejected Overflow's own authorization — not retryable, unlike a 403/404.
  if (error instanceof GitHubApiError && classifyGitHubApiFailure(error) === "CREDENTIALS") {
    return new RepositoryRegistrationError(
      "GITHUB_CREDENTIALS",
      `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to ${step}. `
        + "To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry registration.",
    );
  }

  if (error instanceof GitHubApiError && classifyGitHubApiFailure(error) === "ACCESS") {
    let cause = repository?.ownerType === "ORGANIZATION"
      ? `This can happen when the Overflow OAuth application is not approved for that organization. Ask an organization owner to approve it at https://github.com/organizations/${repository.owner}/settings/oauth_application_policy.`
      : "This may be caused by missing authorization for the Overflow OAuth application.";
    if (repository === null) {
      cause += " For an organization-owned repository, an organization owner may additionally need to approve the Overflow application under the organization's third-party application access policy.";
    }
    const authorizationRemedies = ` ${cause} Review Overflow's authorization at https://github.com/settings/applications, then retry registration.`;
    if (error.status === 404) {
      const observation = `GitHub answered 404 for the request to ${step}. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted${repository === null ? "" : " since it was looked up"}.`;
      return new RepositoryRegistrationError("GITHUB_ACCESS", `${observation}${authorizationRemedies}`);
    }
    // Issue 97: a 403 with no rate-limit evidence cannot separate a missing authorization
    // from a secondary rate limit — GitHub answers 403 both ways. Lead with the retry.
    return new RepositoryRegistrationError(
      "GITHUB_ACCESS",
      `GitHub refused to ${step} (HTTP 403). `
        + "GitHub answers 403 both when the Overflow OAuth application is not yet authorized "
        + "and when it is temporarily limiting requests, and this response carries nothing that "
        + "separates the two causes. Wait a minute and retry registration before changing anything."
        + authorizationRemedies,
    );
  }

  if (error instanceof GitHubApiError && classifyGitHubApiFailure(error) === "RATE_LIMITED") {
    const delay = error.retryAfterSeconds === null ? "" : ` Retry after ${error.retryAfterSeconds} ${plural(error.retryAfterSeconds, "second")}.`;
    return new RepositoryRegistrationError(
      "GITHUB_RATE_LIMITED",
      `GitHub rate-limited the request to ${step} (HTTP ${error.status}).${delay} Please retry registration later.`,
    );
  }

  return new RepositoryRegistrationError(
    "UPSTREAM_FAILURE",
    step === "retrieve the submitted GitHub repository"
      ? "Unable to retrieve the submitted GitHub repository."
      : `Unable to ${step} on GitHub.`,
    // Issue 883/890: only the bounded label read keeps a cause, and only for a failure no status arm
    // classified — a walk cut short, or a GitHub status nothing here can explain. A thrown value of undefined keeps none.
    step === "read the repository difficulty labels" && isUnclassifiedGitHubFailure(error) ? error : undefined,
  );
}
