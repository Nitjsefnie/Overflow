import { parse } from "yaml";

export type ClaimPathEvidence = { path: string; content: string };
export type ClaimPathAssessment = "PRESENT" | "ABSENT";

// PATCHing an issue with an assignees body is deliberately not evidence: matching
// a bare issue URL and a nearby field would admit too many false positives.
// Shell expansions after assignees deliberately yield ABSENT, even when empty.
// A quoted semicolon suffix remains an accepted residual false PRESENT: without
// shell parsing it is indistinguishable from the separator real scripts use.
const assigneesCollection = /(?<![\w.~%+:=$-])issues\/[^/\r\n]+\/assignees(?=$|[\s"'`;&|)<>?#\\])/;
const additiveCall = /\baddAssigneesToAssignable\b|\bissues\s*\.\s*addAssignees\b/;
const deletion = /(?:-X|--method)\s+DELETE\b/i;

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

    // Any DELETE method on a REST line excludes it, even in a comment. Named
    // additive calls are independent of that exclusion and may span lines.
    const assigns = additiveCall.test(content) || content.split(/\r?\n/).some(
      (line) => assigneesCollection.test(line) && !deletion.test(line),
    );
    if (reactsToComments && assigns) {
      return "PRESENT";
    }
  }

  return "ABSENT";
}
