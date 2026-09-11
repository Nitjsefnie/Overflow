import type { ClaimPathEvidence } from "@/lib/domain/claim-path";
import { GitHubGateway, type GitHubGatewayOptions, type GitHubIssueListOptions } from "@/lib/github/client";
import { GitLabGateway } from "@/lib/gitlab/client";
import type {
  GitHubIssue,
  GitHubIssueReference,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubRepository,
  GitHubRepositoryReference,
  GitHubSubject,
  GitHubWebhook,
  GitHubWebhookConfiguration,
} from "@/lib/github/types";

/**
 * The forge seam: every public read and webhook operation the settlement
 * pipeline performs against a forge, stated over the GitHub types that are
 * already the pipeline's neutral vocabulary. GitHubGateway implements it with
 * zero behavior change; GitLabGateway implements it with the graded behaviors
 * the forge-evidence contract locks (reviews permanently empty, no workflow
 * evidence, labels fallback). Method signatures are GitHubGateway's, verbatim.
 */
export interface ForgeGateway {
  getRepository(repository: GitHubRepositoryReference): Promise<GitHubRepository>;
  getRepositoryById(githubRepositoryId: number): Promise<GitHubRepository | null>;
  listIssues(repository: GitHubRepositoryReference, options?: GitHubIssueListOptions): Promise<GitHubIssue[]>;
  getIssue(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssue | null>;
  getPullRequestClosingIssues(
    repository: GitHubRepositoryReference,
    subject: GitHubSubject,
  ): Promise<GitHubIssueReference[]>;
  getIssueClosingPullRequests(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    initialPage?: Parameters<GitHubGateway["getIssueClosingPullRequests"]>[2],
  ): Promise<GitHubPullRequest[]>;
  getPullRequestReviews(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]>;
  createWebhook(
    repository: GitHubRepositoryReference,
    configuration: GitHubWebhookConfiguration,
  ): Promise<GitHubWebhook>;
  deleteWebhook(repository: GitHubRepositoryReference, webhookId: number): Promise<void>;
  ensureWebhookEvents(
    repository: GitHubRepositoryReference,
    webhookId: number,
    existingSecret: string,
  ): Promise<void>;
  listRepositoryLabels(repository: GitHubRepositoryReference): Promise<Set<string>>;
  getPullRequestDiff(repository: GitHubRepositoryReference, pullRequestNumber: number): Promise<string>;
  listWorkflowFiles(repository: GitHubRepositoryReference): Promise<ClaimPathEvidence[]>;
}

export class ForgeGatewayResolutionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ForgeGatewayResolutionError";
  }
}

/**
 * Raised when a read made through a linked identity is refused by the forge
 * as an authentication or scope failure (GitLab 401/403). The sentence is a
 * code constant and never carries upstream error text, because the fold
 * stores this error's class of message where the product reads it; the
 * upstream detail stays in the service log. The identity's row is marked as
 * needing re-verification by the seam that raises this — see
 * `sponsorGateway`'s credential guard.
 */
export class ForgeCredentialRejectedError extends Error {
  public constructor() {
    super("The linked GitLab credential was rejected by the instance, so the fold could not read through it. Re-link the identity to restore folding.");
    this.name = "ForgeCredentialRejectedError";
  }
}

export type ResolveGatewayInput = {
  /** The repository row's `provider`; null on rows that predate migration 038's columns. */
  provider: string | null;
  /** The repository row's `instance_url`; null for GitHub rows. */
  instanceUrl?: string | null;
  /** The GitHub OAuth wiring the existing routes already resolve. */
  github: GitHubGatewayOptions;
  /** The linked identity's PAT and instance, when the actor has one for this instance. */
  gitlab: { instanceUrl: string; token: string } | null;
};

/**
 * Wires the gateway a repository's provider names: 'github' to the existing
 * GitHubGateway wiring, 'gitlab' to a GitLabGateway carrying the linked
 * identity's PAT. A GitLab repository without a verified linked identity on
 * its instance is a caller bug — the registration flow refuses earlier — so
 * the resolver refuses loudly rather than fabricating a gateway.
 */
export function resolveGateway(input: ResolveGatewayInput): ForgeGateway {
  if (input.provider === "gitlab") {
    if (input.gitlab === null || input.instanceUrl === null || input.instanceUrl === undefined) {
      throw new ForgeGatewayResolutionError(
        "A GitLab gateway requires a verified linked identity on the repository's instance.",
      );
    }
    return new GitLabGateway({ instanceUrl: input.instanceUrl, token: input.gitlab.token });
  }
  if (input.provider === "github" || input.provider === null) {
    return new GitHubGateway(input.github);
  }
  throw new ForgeGatewayResolutionError(`Unknown forge provider: ${input.provider}`);
}
