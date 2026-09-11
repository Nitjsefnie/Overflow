import { GitLabApiError, GitLabGateway } from "@/lib/gitlab/client";
import { gitlabWebhookError, type GitLabWebhookStep } from "@/lib/repositories/gitlab-forge-errors";
import { RepositoryRegistrationError } from "@/lib/repositories/register";

/**
 * The GitLab hook deletion an unregistration performs (issue 547, behavior 3).
 * Forge-first, like the GitHub flow: the hook is deleted on the instance
 * BEFORE the local row is touched, so a refusal leaves the registration
 * exactly as it stood. This module is deliberately self-contained — it reads
 * through its store seam and deletes through its gateway seam, and touches
 * nothing else — so the unregistration flow can adopt it wholesale when the
 * GitLab branch of `unregisterRepository` lands (the flow that will wire it).
 *
 * Outcomes:
 * - DELETED: this call deleted the hook (`webhookDeleted: true`).
 * - ALREADY_ABSENT: no hook to delete — the row predates the webhook path
 *   (null hook id), or GitLab answered 404 (hook or project already gone);
 *   the flow continues with `webhookDeleted: false`.
 * - Anything else throws through the registration error catalog with the row
 *   untouched: 404 target resolution, a foreign sponsor (FORBIDDEN), no
 *   verified identity on the instance, a rejected token (GITHUB_CREDENTIALS),
 *   or a GitLab refusal (GITHUB_ACCESS / GITHUB_RATE_LIMITED /
 *   UPSTREAM_FAILURE). A retry converges once the sponsor relinks or the
 *   instance recovers.
 */
export type GitLabWebhookUnregistrationStore = {
  /**
   * The registration holding this owner/name path AS A GITLAB REGISTRATION —
   * null when no row holds the path or when a GitHub registration holds it
   * (whose hook deletion is the GitHub flow's business). Returns the hook
   * target fields the deletion needs.
   */
  findGitLabWebhookTargetByOwnerName(ownerName: string): Promise<{
    sponsorId: string;
    githubWebhookId: number | null;
    instanceUrl: string | null;
  } | null>;
  /** The sponsor's decrypted GitLab PAT for a normalized instance, or null. */
  getForgeToken(userId: string, instanceUrl: string): Promise<string | null>;
};

export type GitLabWebhookUnregistrationDependencies = {
  store: GitLabWebhookUnregistrationStore;
  createGateway(instanceUrl: string, token: string): Pick<GitLabGateway, "deleteWebhook">;
};

export type GitLabWebhookDeletionOutcome =
  | { kind: "DELETED" }
  | { kind: "ALREADY_ABSENT" };

const deleteStep: GitLabWebhookStep = "delete the project webhook";

export async function deleteGitLabWebhookForUnregistration(
  dependencies: GitLabWebhookUnregistrationDependencies,
  input: { ownerName: string; sponsorId: string },
): Promise<GitLabWebhookDeletionOutcome> {
  const target = await dependencies.store.findGitLabWebhookTargetByOwnerName(input.ownerName);
  if (target === null) {
    throw new RepositoryRegistrationError(
      "NOT_FOUND",
      `No registration holds the GitLab path ${input.ownerName}, so there is nothing to unregister.`,
    );
  }
  if (target.sponsorId !== input.sponsorId) {
    throw new RepositoryRegistrationError(
      "FORBIDDEN",
      "Only the repository's sponsor can unregister it.",
    );
  }
  if (target.githubWebhookId === null) {
    // A pre-547 GitLab registration: no hook was installed, so the desired
    // end state already holds.
    return { kind: "ALREADY_ABSENT" };
  }
  if (target.instanceUrl === null || target.instanceUrl.length === 0) {
    // A hook id without the instance that issued it cannot be addressed: the
    // row is inconsistent, and the flow refuses rather than guessing.
    throw new RepositoryRegistrationError(
      "UPSTREAM_FAILURE",
      "The GitLab registration is missing its instance URL, so its project hook cannot be addressed.",
    );
  }

  const token = await dependencies.store.getForgeToken(input.sponsorId, target.instanceUrl);
  if (token === null || token.length === 0) {
    throw new RepositoryRegistrationError(
      "GITHUB_CREDENTIALS",
      "A verified GitLab identity linked to this instance is required to unregister a GitLab repository. "
        + "Relink your GitLab identity on the Ledger page, then retry unregistration.",
    );
  }

  const reference = projectReference(input.ownerName);
  if (reference === null) {
    throw new RepositoryRegistrationError(
      "UPSTREAM_FAILURE",
      "The GitLab registration's stored path is not a path with namespace, so its project hook cannot be addressed.",
    );
  }
  const gateway = dependencies.createGateway(target.instanceUrl, token);
  try {
    await gateway.deleteWebhook(reference, target.githubWebhookId);
    return { kind: "DELETED" };
  } catch (error) {
    if (error instanceof GitLabApiError && error.status === 404) {
      return { kind: "ALREADY_ABSENT" };
    }
    throw gitlabWebhookError(error, deleteStep, "unregistration");
  }
}

/**
 * Splits the stored path with namespace into the owner/name reference the
 * gateway addresses the project with. Null when the stored path cannot be a
 * path with namespace — no addressable project, so no hook deletion.
 */
function projectReference(ownerName: string): { owner: string; name: string } | null {
  const segments = ownerName.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    return null;
  }
  return { owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1]! };
}
