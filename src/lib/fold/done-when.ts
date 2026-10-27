/**
 * The sponsor's "Done when" statement: the earliest sponsor comment whose body
 * opens with the phrase, written before the first assignment and not edited
 * after it. GitLab records no assignment history, so there it is unbounded.
 */
import {
  compareHistoryItems, compareRationaleSequence, editedAfter, findDuplicatedDatabaseId, isRepositorySponsor,
  rationaleSequenceRank, validIssueComment, validIssueHistoryEvent, type FoldUser,
} from "@/lib/fold/repository-fold";
import type { GitHubIssue } from "@/lib/github/types";

export const DONE_WHEN_MAX_BYTES = 2048;
const PHRASE = "Done when";
const ELLIPSIS = "…";

export function doneWhenText(body: string): string | null {
  // An unterminated comment runs to the end, as a CommonMark HTML block does.
  const text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
  if (!/^Done when(?![\p{L}\p{N}_])/u.test(text) || /^[\s:\p{Pd}]*$/u.test(text.slice(PHRASE.length))) {
    return null;
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= DONE_WHEN_MAX_BYTES) {
    return text;
  }
  let cut = DONE_WHEN_MAX_BYTES - Buffer.byteLength(ELLIPSIS);
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  return bytes.subarray(0, cut).toString("utf8") + ELLIPSIS;
}

export function sponsorDoneWhen(
  issue: Pick<GitHubIssue, "comments" | "history">,
  sponsor: FoldUser,
): { text: string; commentId: string } | null {
  const assignment = issue.history.filter(validIssueHistoryEvent).sort(compareHistoryItems)
    .find((event) => event.kind === "ASSIGNED");
  const firstAssignment = assignment === undefined ? Number.POSITIVE_INFINITY : Date.parse(assignment.createdAt);
  const statements = issue.comments
    .filter((comment) =>
      validIssueComment(comment) &&
      isRepositorySponsor({ login: comment.authorLogin, githubUserId: comment.authorGitHubUserId }, sponsor) &&
      Date.parse(comment.createdAt) < firstAssignment &&
      !editedAfter(comment, firstAssignment) &&
      doneWhenText(comment.body) !== null)
    .sort((left, right) => compareHistoryItems(left, right) || compareRationaleSequence(left, right));
  const first = statements[0];
  if (first === undefined) {
    return null;
  }
  // As for a settlement rationale: a tie its database ids cannot order lists as none.
  const tie = statements.filter((comment) => Date.parse(comment.createdAt) === Date.parse(first.createdAt));
  if (tie.filter((comment) => rationaleSequenceRank(comment.databaseId) === null).length > 1 ||
    findDuplicatedDatabaseId(tie) !== undefined) {
    return null;
  }
  return { text: doneWhenText(first.body)!, commentId: first.id };
}
