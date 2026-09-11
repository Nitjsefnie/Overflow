import { z } from "zod";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";

/**
 * The GitLab webhook payload maps into the delivery vocabulary the shared
 * processor already speaks: a GitLab issue event becomes an `issues` delivery
 * with an ISSUE subject, the raw issue view, and a delivery id namespaced
 * `gitlab:` over the `X-Gitlab-Webhook-UUID` header. The namespacing is the
 * dedup: GitHub deliveries carry guid strings, so the prefix guarantees the
 * two forges can never collide on `webhook_deliveries.github_delivery_id` —
 * no migration, no provider column on the deliveries table.
 *
 * The delivery carries the payload's forge identity (provider + the instance
 * base normalized from `project.web_url`), and the processor resolves the
 * repository through it — never through the numeric id alone, which a GitHub
 * registration could equally hold.
 *
 * The hook is installed with merge request events too, but a merge request
 * payload is deliberately ignored (the route answers 204): merge-request
 * evidence is read fresh on every issue reconciliation, and a merge that
 * closes an issue moves the issue itself, whose delivery does the
 * invalidating.
 */

export type GitLabWebhookParseResult =
  | { status: "ok"; delivery: GitHubWebhookDelivery }
  | { status: "ignored" }
  | { status: "invalid" };

/** The GitLab issue actions Overflow materializes, in the GitHub vocabulary. */
const issueActions: Record<string, string> = {
  open: "opened",
  close: "closed",
  reopen: "reopened",
  update: "edited",
};

const gitlabProjectSchema = z.object({
  id: z.number().int().positive(),
  path_with_namespace: z.string().trim().min(1),
  web_url: z.string(),
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

export function parseGitLabWebhookDeliveryDetailed(
  eventName: string | null,
  deliveryUuid: string | null,
  payload: unknown,
): GitLabWebhookParseResult {
  if (eventName === null || eventName.trim().length === 0 || deliveryUuid === null || deliveryUuid.trim().length === 0) {
    return { status: "invalid" };
  }

  // The kind decides the classification before anything else is read: a merge
  // request payload is dropped regardless of what else it carries, the same
  // ordering the GitHub parser uses for its unmaterialized actions.
  const kind = gitlabKindSchema.safeParse(payload);
  if (!kind.success) return { status: "invalid" };
  if (kind.data.object_kind === "merge_request") {
    return { status: "ignored" };
  }
  if (kind.data.object_kind !== "issue") {
    return { status: "invalid" };
  }

  const parsed = gitlabPayloadSchema.safeParse(payload);
  if (!parsed.success) return { status: "invalid" };

  const action = issueActions[parsed.data.object_attributes.action];
  if (action === undefined) {
    return { status: "invalid" };
  }

  let instanceUrl: string;
  try {
    // The same normalization the identity link stores under, so the stored
    // instance_url and the delivery's instance compare exactly.
    instanceUrl = normalizeInstanceUrl(parsed.data.project.web_url);
  } catch {
    return { status: "invalid" };
  }

  return {
    status: "ok",
    delivery: {
      // The namespaced delivery id: the dedup key is forge-safe by
      // construction, since GitHub guids carry no such prefix.
      deliveryId: `gitlab:${deliveryUuid.trim()}`,
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
    },
  };
}

export function parseGitLabWebhookDelivery(
  eventName: string | null,
  deliveryUuid: string | null,
  payload: unknown,
): GitHubWebhookDelivery | null {
  const result = parseGitLabWebhookDeliveryDetailed(eventName, deliveryUuid, payload);
  return result.status === "ok" ? result.delivery : null;
}
