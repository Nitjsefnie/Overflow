import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { RepositoryRegistrationError, type RepositoryRegistrationInput } from "@/lib/repositories/register";

export function parseGitLabRegistrationInput(input: RepositoryRegistrationInput): { instanceUrl: string; project: string } {
  if (input.instanceUrl === undefined || input.project === undefined || input.instanceUrl === "" || input.project === "") {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      "A GitLab registration requires the instance URL and the project id or path.",
    );
  }

  // The same normalization the link flow stores under: one input cannot be
  // valid here and invalid there (or vice versa).
  let instanceUrl: string;
  try {
    instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  } catch (error) {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      error instanceof Error ? error.message : "The instance URL is malformed.",
    );
  }
  if (/^\d+$/.test(input.project)) {
    const numericProject = Number(input.project);
    if (!Number.isSafeInteger(numericProject) || numericProject <= 0) {
      throw new RepositoryRegistrationError(
        "INVALID_INPUT",
        "The GitLab project id must be a positive integer.",
      );
    }
  } else if (!input.project.includes("/")) {
    throw new RepositoryRegistrationError(
      "INVALID_INPUT",
      "Submit the GitLab project as a positive numeric id or a path with namespace.",
    );
  }
  return { instanceUrl, project: input.project };
}
