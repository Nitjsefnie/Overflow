import { z } from "zod";
import type { IssueState } from "@/lib/db/types";

export type GitHubWebhookIssue = {
  state: IssueState;
  updatedAt: string;
  title: string;
  body: string;
  url: string;
};

export type SupportedGitHubWebhookEvent = keyof typeof supportedActions;

export type GitHubWebhookDelivery = {
  deliveryId: string;
  event: SupportedGitHubWebhookEvent;
  action: string;
  repositoryGitHubId: number;
  repositoryFullName: string;
  subject: { kind: "ISSUE" | "PULL_REQUEST"; id: number; number: number };
  /** Present only for genuine, PR-free issue envelopes; a PR-carrying envelope yields no subject at all. */
  issue?: GitHubWebhookIssue;
};

export type GitHubWebhookParseResult =
  | { status: "ok"; delivery: GitHubWebhookDelivery }
  | { status: "ignored" }
  | { status: "invalid" };

const subjectSchema = z.object({ id: z.number().int().positive(), number: z.number().int().positive() });
const issueEnvelopeSchema = subjectSchema.extend({ pull_request: z.object({}).optional() });
const issueViewSchema = z.object({
  state: z.enum(["open", "closed"]),
  updated_at: z.iso.datetime({ offset: true }),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.url({ protocol: /^https?$/ }),
});

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

// Recognized pull-request actions Overflow deliberately does not materialize.
// The route answers these 204 (parsed-but-ignored), reserving 400 for
// malformed traffic; GitHub's repository webhooks cannot unsubscribe per-action.
const unmaterializedActions: Partial<Record<SupportedGitHubWebhookEvent, Set<string>>> = {
  pull_request: new Set(["ready_for_review", "converted_to_draft"]),
};

export const githubWebhookEvents = Object.keys(supportedActions) as SupportedGitHubWebhookEvent[];

export function parseGitHubWebhookDeliveryDetailed(
  eventName: string | null,
  deliveryId: string | null,
  payload: unknown,
): GitHubWebhookParseResult {
  if (
    eventName === null ||
    deliveryId === null ||
    deliveryId.trim().length === 0 ||
    !isSupportedEvent(eventName)
  ) {
    return { status: "invalid" };
  }

  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) return { status: "invalid" };
  if (unmaterializedActions[eventName]?.has(parsed.data.action)) {
    // A recognized action this deployment deliberately does not materialize:
    // parsed-but-ignored, so the route answers 204 and GitHub's delivery log
    // stays green on valid traffic Overflow chose not to process. Checked
    // before subject parsing — the delivery is dropped regardless of what
    // else the envelope carries.
    return { status: "ignored" };
  }
  if (!supportedActions[eventName].has(parsed.data.action)) {
    return { status: "invalid" };
  }
  const isIssueEvent = eventName === "issues" || eventName === "issue_comment";
  const subject = subjectSchema.safeParse(isIssueEvent ? parsed.data.issue : parsed.data.pull_request);
  if (!subject.success) return { status: "invalid" };
  let issue: GitHubWebhookIssue | undefined;
  const kind = isIssueEvent ? "ISSUE" : "PULL_REQUEST";
  if (isIssueEvent) {
    const envelope = issueEnvelopeSchema.safeParse(parsed.data.issue);
    if (!envelope.success) return { status: "invalid" };
    // A PR-carrying envelope's id is the issue surface's, not the PR database
    // id, and repository.issue(number:) cannot resolve a PR back. Enqueueing
    // it would poison reconciliation's evidence delete-key with an unresolvable
    // ISSUE row; the PR's true PULL_REQUEST row arrives from its lifecycle
    // events instead.
    if (envelope.data.pull_request !== undefined) return { status: "ignored" };
    const view = issueViewSchema.safeParse(parsed.data.issue);
    if (!view.success) return { status: "invalid" };
    issue = { state: view.data.state === "open" ? "OPEN" : "CLOSED", updatedAt: view.data.updated_at,
      title: view.data.title, body: view.data.body ?? "", url: view.data.html_url };
  }

  return {
    status: "ok",
    delivery: {
      deliveryId,
      event: eventName,
      action: parsed.data.action,
      repositoryGitHubId: parsed.data.repository.id,
      repositoryFullName: parsed.data.repository.full_name,
      subject: { kind, ...subject.data },
      ...(issue === undefined ? {} : { issue }),
    },
  };
}

export function parseGitHubWebhookDelivery(
  eventName: string | null,
  deliveryId: string | null,
  payload: unknown,
): GitHubWebhookDelivery | null {
  const result = parseGitHubWebhookDeliveryDetailed(eventName, deliveryId, payload);
  return result.status === "ok" ? result.delivery : null;
}

function isSupportedEvent(value: string): value is SupportedGitHubWebhookEvent {
  return Object.hasOwn(supportedActions, value);
}
