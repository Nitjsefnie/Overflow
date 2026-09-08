import { z } from "zod";

export type SupportedGitHubWebhookEvent = keyof typeof supportedActions;

export type GitHubWebhookDelivery = {
  deliveryId: string;
  event: SupportedGitHubWebhookEvent;
  action: string;
  repositoryGitHubId: number;
  repositoryFullName: string;
  subject: { kind: "ISSUE" | "PULL_REQUEST"; id: number; number: number };
};

const subjectSchema = z.object({ id: z.number().int().positive(), number: z.number().int().positive() });

const payloadSchema = z
  .object({
    action: z.string().trim().min(1),
    repository: z.object({
      id: z.number().int().positive(),
      full_name: z.string().trim().min(1),
    }),
  })
  .passthrough();

const supportedActions = {
  issues: new Set(["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "assigned", "unassigned"]),
  pull_request: new Set(["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "synchronize"]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
  issue_comment: new Set(["created", "edited", "deleted"]),
};

export const githubWebhookEvents = Object.keys(supportedActions) as SupportedGitHubWebhookEvent[];

export function parseGitHubWebhookDelivery(
  eventName: string | null,
  deliveryId: string | null,
  payload: unknown,
): GitHubWebhookDelivery | null {
  if (
    eventName === null ||
    deliveryId === null ||
    deliveryId.trim().length === 0 ||
    !isSupportedEvent(eventName)
  ) {
    return null;
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success || !supportedActions[eventName].has(parsed.data.action)) {
    return null;
  }
  const isIssueEvent = eventName === "issues" || eventName === "issue_comment";
  const subject = subjectSchema.safeParse(isIssueEvent ? parsed.data.issue : parsed.data.pull_request);
  if (!subject.success) return null;

  return {
    deliveryId,
    event: eventName,
    action: parsed.data.action,
    repositoryGitHubId: parsed.data.repository.id,
    repositoryFullName: parsed.data.repository.full_name,
    subject: { kind: isIssueEvent ? "ISSUE" : "PULL_REQUEST", ...subject.data },
  };
}

function isSupportedEvent(value: string): value is SupportedGitHubWebhookEvent {
  return Object.hasOwn(supportedActions, value);
}
