/**
 * The sponsor's "Done when" statement: the earliest sponsor comment whose body
 * opens with the phrase, written before the first assignment and not edited
 * after it. GitLab records no assignment history, so there it is unbounded.
 */
import {
  compareHistoryItems, compareRationaleSequence, editedAfter, isRepositorySponsor,
  validIssueComment, validIssueHistoryEvent, type FoldUser,
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
  const firstAssignment = Math.min(
    ...issue.history
      .filter((event) => event.kind === "ASSIGNED" && validIssueHistoryEvent(event))
      .map((event) => Date.parse(event.createdAt)),
  );
  const candidates = issue.comments
    .filter((comment) =>
      validIssueComment(comment) &&
      isRepositorySponsor({ login: comment.authorLogin, githubUserId: comment.authorGitHubUserId }, sponsor) &&
      Date.parse(comment.createdAt) < firstAssignment &&
      !editedAfter(comment, firstAssignment))
    .sort((left, right) => compareHistoryItems(left, right) || compareRationaleSequence(left, right));
  for (const comment of candidates) {
    const text = doneWhenText(comment.body);
    if (text !== null) {
      return { text, commentId: comment.id };
    }
  }
  return null;
}
