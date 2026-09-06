import { parse } from "yaml";

export type ClaimPathEvidence = { path: string; content: string };
export type ClaimPathAssessment = "PRESENT" | "ABSENT";

const assignmentSurface = /\bissues\/[^/\r\n]+\/assignees(?=$|[/?#\s"'`])|\baddAssigneesToAssignable\b|\bissues\.addAssignees\b/;

export function assessClaimPath(workflows: readonly ClaimPathEvidence[]): ClaimPathAssessment {
  for (const { content } of workflows) {
    let document: unknown;
    try {
      // Maps preserve the boolean key produced by bare `on` in YAML 1.1.
      document = parse(content, { mapAsMap: true });
    } catch {
      continue;
    }

    if (!(document instanceof Map)) {
      continue;
    }

    const trigger: unknown = document.get("on") ?? document.get(true);
    const reactsToComments = trigger === "issue_comment"
      || (Array.isArray(trigger) && trigger.includes("issue_comment"))
      || (trigger instanceof Map && trigger.has("issue_comment"));

    if (reactsToComments && assignmentSurface.test(content)) {
      return "PRESENT";
    }
  }

  return "ABSENT";
}
