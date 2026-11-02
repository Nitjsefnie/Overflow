import { GitHubWebhookScopeError } from "@/lib/auth/github-granted-scopes";
import { validateDifficultyScheme } from "@/lib/domain/difficulty-scheme";
import { parseGitLabRegistrationInput } from "@/lib/repositories/gitlab-registration-input";
import { parseGitHubRepository, RepositoryRegistrationError, type RepositoryRegistrationInput } from "@/lib/repositories/register";
import type { RegistrationRefusalKind } from "@/lib/stats/registration-attempts";

export function isCountableRegistrationInput(input: RepositoryRegistrationInput): boolean {
  try {
    if (!validateDifficultyScheme(input).ok) return false;
    if (input.provider === "gitlab") {
      if (input.registrationMethod === "app") return false;
      parseGitLabRegistrationInput(input);
    } else {
      parseGitHubRepository(input.repositoryUrl);
    }
    return true;
  } catch {
    return false;
  }
}

export function registrationRefusal(error: unknown): RegistrationRefusalKind | null {
  if (error instanceof GitHubWebhookScopeError) return "WEBHOOK_SCOPE_MISSING";
  if (!(error instanceof RepositoryRegistrationError)) return null;
  switch (error.code) {
    case "INVALID_INPUT":
      return error.refusal ?? null;
    case "FORBIDDEN":
    case "CONFLICT":
    case "NOT_FOUND":
    case "GITHUB_ACCESS":
      // A null tag explicitly excludes transient conflicts from the fallback.
      return error.refusal === undefined ? "OTHER" : error.refusal;
    default:
      return null;
  }
}
