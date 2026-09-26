import { z } from "zod";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import type { GitHubWebhookDelivery, SupportedGitHubWebhookEvent } from "@/lib/github/webhook-schema";

/**
 * The GitLab webhook payload maps into the delivery vocabulary the shared
 * processor already speaks: a GitLab issue event becomes an `issues` delivery
 * with an ISSUE subject, the raw issue view, and a stable message identity.
 * The route scopes that receipt key to the authenticated credential's provider
 * and registration, and the processor forwards that scope unchanged to the
 * receipt store. The webhook UUID identifies an execution; older senders
 * without stable message headers also use it as the fallback receipt key.
 *
 * The delivery carries the payload's forge identity (provider + the instance
 * base normalized from `project.web_url`), and the processor resolves the
 * repository through it — never through the numeric id alone, which a GitHub
 * registration could equally hold.
 *
 * A merge request event becomes a `pull_request` or `pull_request_review`
 * delivery with a PULL_REQUEST subject and no issue view — the same shape the
 * GitHub parser gives a pull-request envelope — so the fold's dirty-subject
 * refresh re-reads that merge request's evidence. An approval, merge or edit
 * that moves no issue therefore invalidates the merge request's own subject
 * instead of waiting for the periodic sweep.
 *
 * Every payload kind the hook subscribes to is either accepted or invalid;
 * there is no deliberately-ignored class.
 */

export type GitLabWebhookParseResult =
  | { status: "ok"; delivery: GitHubWebhookDelivery }
  | { status: "invalid" };

type GitLabMessageHeaders = { idempotencyKey?: string | null; webhookId?: string | null };

/**
 * The GitLab issue actions Overflow materializes, in the GitHub vocabulary.
 * Both action tables are Maps, never object literals: the action name is
 * sender-controlled, and an object lookup would find an inherited member such
 * as `constructor` or `__proto__` instead of reporting the action unknown.
 */
const issueActions: ReadonlyMap<string, string> = new Map([
  ["open", "opened"],
  ["close", "closed"],
  ["reopen", "reopened"],
  ["update", "edited"],
]);

/**
 * The GitLab merge request actions Overflow materializes, each mapped onto
 * the GitHub event/action pair the shared processor and fold already handle.
 * GitLab's `merge` has no GitHub twin — a merged pull request arrives there
 * as `closed` — and its approval actions (spelled both `approved`/`approval`
 * and `unapproved`/`unapproval` across GitLab versions) are the review
 * submitted/dismissed pair. Any other action, an inherited object member name
 * included, is invalid, the same discipline the issue arm applies.
 */
const mergeRequestActions: ReadonlyMap<string, { event: SupportedGitHubWebhookEvent; action: string }> = new Map([
  ["open", { event: "pull_request", action: "opened" }],
  ["reopen", { event: "pull_request", action: "reopened" }],
  ["update", { event: "pull_request", action: "edited" }],
  ["close", { event: "pull_request", action: "closed" }],
  ["merge", { event: "pull_request", action: "closed" }],
  ["approved", { event: "pull_request_review", action: "submitted" }],
  ["approval", { event: "pull_request_review", action: "submitted" }],
  ["unapproved", { event: "pull_request_review", action: "dismissed" }],
  ["unapproval", { event: "pull_request_review", action: "dismissed" }],
]);

const gitlabProjectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().trim().min(1),
  web_url: z.string(),
  visibility_level: z.int().optional(),
});

const gitlabIssueAttributesSchema = z.object({
  id: z.number().int().positive(),
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(["opened", "closed"]),
  updated_at: z.iso.datetime({ offset: true }),
  url: z.url({ protocol: /^https?$/ }),
  action: z.string().trim().min(1),
});

const gitlabMergeRequestAttributesSchema = z.object({
  id: z.number().int().positive(),
  iid: z.number().int().positive(),
  action: z.string().trim().min(1),
});

const gitlabKindSchema = z
  .object({ object_kind: z.string() })
  .passthrough();

const gitlabPayloadSchema = z
  .object({
    object_kind: z.string(),
    project: gitlabProjectSchema,
    object_attributes: gitlabIssueAttributesSchema,
  })
  .passthrough();

const gitlabMergeRequestPayloadSchema = z
  .object({
    object_kind: z.string(),
    project: gitlabProjectSchema,
    object_attributes: gitlabMergeRequestAttributesSchema,
  })
  .passthrough();

export function parseGitLabWebhookDeliveryDetailed(
  eventName: string | null,
  deliveryUuid: string | null,
  payload: unknown,
  messageHeaders: GitLabMessageHeaders = {},
): GitLabWebhookParseResult {
  if (eventName === null || eventName.trim().length === 0 || deliveryUuid === null || deliveryUuid.trim().length === 0
    || deliveryUuid.trim().length > 255) {
    return { status: "invalid" };
  }
  const executionId = deliveryUuid.trim();
  const idempotencyKey = messageHeaders.idempotencyKey?.trim() ?? "";
  const webhookId = messageHeaders.webhookId?.trim() ?? "";
  if (idempotencyKey.length > 255 || webhookId.length > 255) return { status: "invalid" };
  // Idempotency-Key wins even when the sender supplies conflicting stable ids.
  const deliveryId = idempotencyKey || webhookId || executionId;

  // The kind decides which payload shape is read: an issue and a merge
  // request carry different attribute sets, and any other kind is invalid.
  const kind = gitlabKindSchema.safeParse(payload);
  if (!kind.success) return { status: "invalid" };
  if (kind.data.object_kind === "merge_request") {
    return parseMergeRequestPayload(deliveryId, executionId, payload);
  }
  if (kind.data.object_kind !== "issue") {
    return { status: "invalid" };
  }

  const parsed = gitlabPayloadSchema.safeParse(payload);
  if (!parsed.success) return { status: "invalid" };

  const action = issueActions.get(parsed.data.object_attributes.action);
  if (action === undefined) {
    return { status: "invalid" };
  }

  const instanceUrl = instanceUrlOf(parsed.data.project);
  if (instanceUrl === null) return { status: "invalid" };

  return {
    status: "ok",
    delivery: {
      deliveryId,
      executionId,
      event: "issues",
      action,
      repositoryGitHubId: parsed.data.project.id,
      repositoryFullName: parsed.data.project.path_with_namespace,
      subject: {
        kind: "ISSUE",
        id: parsed.data.object_attributes.id,
        number: parsed.data.object_attributes.iid,
      },
      issue: {
        state: parsed.data.object_attributes.state === "opened" ? "OPEN" : "CLOSED",
        updatedAt: parsed.data.object_attributes.updated_at,
        title: parsed.data.object_attributes.title,
        body: parsed.data.object_attributes.description ?? "",
        url: parsed.data.object_attributes.url,
      },
      forge: { provider: "gitlab", instanceUrl },
      ...repositoryPrivateOf(parsed.data.project),
    },
  };
}

function parseMergeRequestPayload(deliveryId: string, executionId: string, payload: unknown): GitLabWebhookParseResult {
  const parsed = gitlabMergeRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return { status: "invalid" };

  const mapped = mergeRequestActions.get(parsed.data.object_attributes.action);
  if (mapped === undefined) {
    return { status: "invalid" };
  }

  const instanceUrl = instanceUrlOf(parsed.data.project);
  if (instanceUrl === null) return { status: "invalid" };

  return {
    status: "ok",
    delivery: {
      deliveryId,
      executionId,
      event: mapped.event,
      action: mapped.action,
      repositoryGitHubId: parsed.data.project.id,
      repositoryFullName: parsed.data.project.path_with_namespace,
      // The subject id is the merge request's global id and the number its
      // iid — the same pair the GitLab gateway records for each closing merge
      // request (`toGitLabMergeRequest`), and the fold matches a dirty
      // PULL_REQUEST subject against that pr.id. Any other choice would mark
      // a subject nothing in the evidence ever carries, and the refresh would
      // never find it. No `issue` view: the processor applies one only to an
      // ISSUE subject, exactly as for a GitHub pull-request envelope.
      subject: {
        kind: "PULL_REQUEST",
        id: parsed.data.object_attributes.id,
        number: parsed.data.object_attributes.iid,
      },
      forge: { provider: "gitlab", instanceUrl },
      ...repositoryPrivateOf(parsed.data.project),
    },
  };
}

// The same normalization the identity link stores under, so the stored
// instance_url and the delivery's instance compare exactly; null when the
// project's web_url cannot name an instance.
function instanceUrlOf(project: { web_url: string }): string | null {
  try {
    return normalizeInstanceUrl(project.web_url);
  } catch {
    return null;
  }
}

// GitLab exposes visibility as an integer level: 0 private, 10 internal,
// 20 public. Any present level other than public is the non-public word the
// shared delivery carries — internal matches registration, which maps
// internal to PRIVATE and refuses — and silence is unknown, so the payload
// alone never refuses.
function repositoryPrivateOf(project: { visibility_level?: number }): { repositoryPrivate?: true } {
  if (project.visibility_level === undefined || project.visibility_level === 20) return {};
  return { repositoryPrivate: true };
}

export function parseGitLabWebhookDelivery(
  eventName: string | null,
  deliveryUuid: string | null,
  payload: unknown,
  messageHeaders: GitLabMessageHeaders = {},
): GitHubWebhookDelivery | null {
  const result = parseGitLabWebhookDeliveryDetailed(eventName, deliveryUuid, payload, messageHeaders);
  return result.status === "ok" ? result.delivery : null;
}
