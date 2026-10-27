/**
 * The sponsor's statements on an issue: "Done when", "Agent prompt" and
 * "Recommended model". Each is the earliest sponsor comment whose body opens
 * with its phrase and carries a valid value, written before the first
 * assignment and not edited after it. GitLab records no assignment history,
 * so there it is unbounded.
 */
import {
  compareHistoryItems, compareRationaleSequence, editedAfter, findDuplicatedDatabaseId, isRepositorySponsor,
  rationaleSequenceRank, validIssueComment, validIssueHistoryEvent, type FoldResult, type FoldUser,
} from "@/lib/fold/repository-fold";
import type { GitHubIssue, GitHubIssueComment, GitHubIssueHistoryEvent } from "@/lib/github/types";

export type IssueStatement = { text: string; commentId: string };

export const DONE_WHEN_MAX_BYTES = 2048;
export const AGENT_PROMPT_PHRASE = "Agent prompt";
export const RECOMMENDED_MODEL_PHRASE = "Recommended model";
export const AGENT_PROMPT_MAX_BYTES = 2048;
export const RECOMMENDED_MODEL_MAX_CHARS = 100;
const DONE_WHEN_PHRASE = "Done when";
const ELLIPSIS = "…";
const AFTER_PHRASE_FILLER = /^[\s:\p{Pd}]*/u;

// The comment text when it opens with the phrase and says more than filler after it, else null.
function openedBy(body: string, phrase: string): string | null {
  // An unterminated comment runs to the end, as a CommonMark HTML block does.
  const text = body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim();
  const rest = text.slice(phrase.length);
  if (!text.startsWith(phrase) || /^[\p{L}\p{N}_]/u.test(rest) || /^[\s:\p{Pd}]*$/u.test(rest)) {
    return null;
  }
  return text;
}

function phraseStatement(body: string, phrase: string, maxBytes: number): string | null {
  const text = openedBy(body, phrase);
  if (text === null) {
    return null;
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) {
    return text;
  }
  let cut = maxBytes - Buffer.byteLength(ELLIPSIS);
  while (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) {
    cut -= 1;
  }
  return bytes.subarray(0, cut).toString("utf8") + ELLIPSIS;
}

export const doneWhenText = (body: string): string | null => phraseStatement(body, DONE_WHEN_PHRASE, DONE_WHEN_MAX_BYTES);

export const agentPromptText = (body: string): string | null => phraseStatement(body, AGENT_PROMPT_PHRASE, AGENT_PROMPT_MAX_BYTES);

/** The model name alone: the first line after the phrase, one trailing "." dropped, never cut to fit. */
export function recommendedModelText(body: string): string | null {
  const text = openedBy(body, RECOMMENDED_MODEL_PHRASE);
  if (text === null) {
    return null;
  }
  const line = text.slice(RECOMMENDED_MODEL_PHRASE.length).replace(AFTER_PHRASE_FILLER, "").split("\n")[0]!.trim();
  const model = line.endsWith(".") ? line.slice(0, -1) : line;
  const length = Array.from(model).length;
  return length >= 1 && length <= RECOMMENDED_MODEL_MAX_CHARS && !/[\p{Cc}\p{Cf}]/u.test(model) ? model : null;
}

function sponsorStatement(
  issue: Pick<GitHubIssue, "comments" | "history">,
  sponsor: FoldUser,
  extract: (body: string) => string | null,
): IssueStatement | null {
  const assignment = issue.history.filter(validIssueHistoryEvent).sort(compareHistoryItems)
    .find((event) => event.kind === "ASSIGNED");
  const firstAssignment = assignment === undefined ? Number.POSITIVE_INFINITY : Date.parse(assignment.createdAt);
  const statements = issue.comments
    .filter((comment) =>
      validIssueComment(comment) &&
      isRepositorySponsor({ login: comment.authorLogin, githubUserId: comment.authorGitHubUserId }, sponsor) &&
      Date.parse(comment.createdAt) < firstAssignment &&
      !editedAfter(comment, firstAssignment) &&
      extract(comment.body) !== null)
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
  return { text: extract(first.body)!, commentId: first.id };
}

type StatementSource = Pick<GitHubIssue, "comments" | "history">;

export const sponsorDoneWhen = (issue: StatementSource, sponsor: FoldUser) => sponsorStatement(issue, sponsor, doneWhenText);

export const sponsorAgentPrompt = (issue: StatementSource, sponsor: FoldUser) => sponsorStatement(issue, sponsor, agentPromptText);

export const sponsorRecommendedModel = (issue: StatementSource, sponsor: FoldUser) =>
  sponsorStatement(issue, sponsor, recommendedModelText);

export function attachDoneWhen(
  fold: FoldResult,
  issues: ReadonlyArray<{ id: number; body?: string; comments: GitHubIssueComment[]; history: GitHubIssueHistoryEvent[] }>,
  sponsor: FoldUser,
): void {
  const fresh = new Map(issues.filter((issue) => typeof issue.body === "string").map((issue) => [issue.id, issue]));
  for (const issue of fold.issues) {
    const source = fresh.get(issue.githubIssueId);
    if (source !== undefined) {
      issue.doneWhen = sponsorDoneWhen(source, sponsor);
      issue.agentPrompt = sponsorAgentPrompt(source, sponsor);
      issue.recommendedModel = sponsorRecommendedModel(source, sponsor);
    }
  }
}
