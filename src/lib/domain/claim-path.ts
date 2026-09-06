/*
 * NO_EVIDENCE_FOUND is the reliable, actionable answer: no workflow both reacts
 * to issue comments and references issue assignment. It is the warning signal.
 * EVIDENCE_FOUND means only that a workflow mentions both, not that it assigns
 * the commenter. It deliberately causes no warning: a wrong EVIDENCE_FOUND
 * leaves the sponsor where they were before this check, while a wrong
 * NO_EVIDENCE_FOUND warns about a fix they may already have.
 *
 * REST deletion exclusion applies per command segment, after joining shell
 * continuations. Segment splitting on &&, ||, ;, | and & is approximate,
 * including within quotes. A separator inside a quoted endpoint expression
 * splits a real assignment and yields NO_EVIDENCE_FOUND: the warning direction,
 * rather than a silent pass. Closing this limit would require splitting only
 * on separators outside quotes and expansions — quote-aware parsing, which
 * this module deliberately does not do.
 *
 * Interpreting shell, conditional job gating and GitHub Actions expressions is
 * out of scope; the result names make that omission explicit. Known textual
 * limits yielding EVIDENCE_FOUND include read-only GETs, commented-out commands,
 * jobs gated on ${{ false }}, POSTs assigning a fixed login, quoted
 * assignees&disabled or assignees;disabled suffixes, and "assignees"/disabled
 * path concatenation. None guarantees runtime assignment of the commenter.
 */
import { parse } from "yaml";

export type ClaimPathEvidence = { path: string; content: string };
export type ClaimPathAssessment = "EVIDENCE_FOUND" | "NO_EVIDENCE_FOUND";

// PATCHing an issue with an assignees body is deliberately not evidence: matching
// a bare issue URL and a nearby field would admit too many false positives.
// Shell expansions after assignees deliberately yield NO_EVIDENCE_FOUND, even when empty.
const assigneesCollection = /(?<![\w.~%+:=$-])issues\/[^/\r\n]+\/assignees(?=$|[\s"'`;&|)<>?#\\])/;
const additiveCall = /\baddAssigneesToAssignable\b|\bissues\s*\.\s*addAssignees\b/;
const deletion = /(?:-X\s*|--method(?:\s+|=))["']?DELETE\b|\bremoveAssignees(?:FromAssignable)?\b/i;

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

    // Join shell continuations before splitting commands for the REST deletion scan.
    // Deletion tokens exclude even comments or repository names within a segment;
    // additive calls stay independent.
    const referencesAssignment = additiveCall.test(content) || content.replace(/\\\r?\n/g, "").split(/\r?\n/).some(
      (line) => line.split(/&&|\|\||[;|&]/).some((segment) => assigneesCollection.test(segment) && !deletion.test(segment)),
    );
    if (reactsToComments && referencesAssignment) {
      return "EVIDENCE_FOUND";
    }
  }

  return "NO_EVIDENCE_FOUND";
}
