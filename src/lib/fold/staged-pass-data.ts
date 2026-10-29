import { StagedPassDataUnreadable, type SweepPass } from "@/lib/fold/sweep-pass";
import type { GitHubSubject } from "@/lib/github/types";

export type StagedRow = Awaited<ReturnType<SweepPass["readStaged"]>>[number];

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => value !== null && typeof value === "object";
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
function ensure(readable: boolean): asserts readable { if (!readable) throw new StagedPassDataUnreadable(); }

export function stagedIdentity(payload: unknown): GitHubSubject {
  const value = isFields(payload) && "subject" in payload ? payload.subject : payload;
  ensure(isFields(value) && isId(value.id) && isId(value.number));
  return { id: value.id, number: value.number };
}

function ensureClosingPullRequest(value: unknown): void {
  ensure(isFields(value) && isId(value.id) && isId(value.number) && typeof value.state === "string"
    && (value.mergedAt === null || typeof value.mergedAt === "string") && typeof value.repositoryGitHubId === "number");
}

function ensureIssue(issue: Fields): void {
  ensure(Array.isArray(issue.labels) && Array.isArray(issue.history) && Array.isArray(issue.comments)
    && Array.isArray(issue.closingPullRequests));
  issue.closingPullRequests.forEach(ensureClosingPullRequest);
}

function ensurePullRequestRow(row: Fields): void {
  const evidence = row.evidence;
  ensure(evidence === null || (isFields(evidence) && Array.isArray(evidence.reviews) && typeof evidence.rawDiff === "string"));
  if (row.refreshed === true) ensure(typeof row.missing === "boolean" && typeof row.listed === "boolean");
}

/** Rows a pass staged itself that no longer have the shape they were staged in cannot resume the pass. */
export async function readStagedRows(pass: SweepPass): Promise<StagedRow[]> {
  const rows = await pass.readStaged();
  for (const { kind, payload } of rows) {
    stagedIdentity(payload);
    const fields = payload as Fields;
    if (kind === "pull_request") ensurePullRequestRow(fields);
    else if ("number" in fields) ensureIssue(fields);
  }
  return rows;
}

export function isDirtySubjects(value: unknown): boolean {
  return Array.isArray(value) && value.every((subject) => isFields(subject)
    && (subject.kind === "ISSUE" || subject.kind === "PULL_REQUEST")
    && isId(subject.id) && isId(subject.number) && typeof subject.generation === "number");
}
