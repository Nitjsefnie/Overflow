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
  let issue: GitHubWebhookIssue | undefined;
  const kind = isIssueEvent ? "ISSUE" : "PULL_REQUEST";
  if (isIssueEvent) {
    const envelope = issueEnvelopeSchema.safeParse(parsed.data.issue);
    if (!envelope.success) return null;
    // A PR-carrying envelope's id is the issue surface's, not the PR database
    // id, and repository.issue(number:) cannot resolve a PR back. Enqueueing
    // it would poison reconciliation's evidence delete-key with an unresolvable
    // ISSUE row; the PR's true PULL_REQUEST row arrives from its lifecycle
    // events instead.
    if (envelope.data.pull_request !== undefined) return null;
    const view = issueViewSchema.safeParse(parsed.data.issue);
    if (!view.success) return null;
    issue = { state: view.data.state === "open" ? "OPEN" : "CLOSED", updatedAt: view.data.updated_at,
      title: view.data.title, body: view.data.body ?? "", url: view.data.html_url };
  }

  return {
    deliveryId,
    event: eventName,
    action: parsed.data.action,
    repositoryGitHubId: parsed.data.repository.id,
    repositoryFullName: parsed.data.repository.full_name,
    subject: { kind, ...subject.data },
    ...(issue === undefined ? {} : { issue }),
  };
}

function isSupportedEvent(value: string): value is SupportedGitHubWebhookEvent {
  return Object.hasOwn(supportedActions, value);
}
