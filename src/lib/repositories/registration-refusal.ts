import { GitHubWebhookScopeError } from "@/lib/auth/github-granted-scopes";
import { RepositoryRegistrationError } from "@/lib/repositories/register";
import type { RegistrationRefusalKind } from "@/lib/stats/registration-attempts";

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
