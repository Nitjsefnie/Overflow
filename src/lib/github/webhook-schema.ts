import { z } from "zod";

export type SupportedGitHubWebhookEvent = "issues" | "pull_request" | "pull_request_review";

export type GitHubWebhookDelivery = {
  deliveryId: string;
  event: SupportedGitHubWebhookEvent;
  action: string;
  repositoryGitHubId: number;
  repositoryFullName: string;
};

const payloadSchema = z
  .object({
    action: z.string().trim().min(1),
    repository: z.object({
      id: z.number().int().positive(),
      full_name: z.string().trim().min(1),
    }),
  })
  .passthrough();

const supportedActions: Record<SupportedGitHubWebhookEvent, ReadonlySet<string>> = {
  issues: new Set(["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "assigned", "unassigned"]),
  pull_request: new Set(["opened", "edited", "closed", "reopened", "labeled", "unlabeled", "synchronize"]),
  pull_request_review: new Set(["submitted", "edited", "dismissed"]),
};

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

  return {
    deliveryId,
    event: eventName,
    action: parsed.data.action,
    repositoryGitHubId: parsed.data.repository.id,
    repositoryFullName: parsed.data.repository.full_name,
  };
}

function isSupportedEvent(value: string): value is SupportedGitHubWebhookEvent {
  return value === "issues" || value === "pull_request" || value === "pull_request_review";
}
