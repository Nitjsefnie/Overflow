import { StagedPassDataUnreadable, type SweepPass } from "@/lib/fold/sweep-pass";
import type { GitHubSubject } from "@/lib/github/types";
import type { WalkSubject } from "@/lib/forge/subject-listing";

export type StagedRow = Awaited<ReturnType<SweepPass["readStaged"]>>[number];

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => value !== null && typeof value === "object";
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isBigint = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && Math.abs(value) < 2 ** 63;
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
  ensure(issue.history.every((event) => isFields(event)
    && (event.actorLogin === null || typeof event.actorLogin === "string")));
  ensure(issue.comments.every((comment) => typeof comment?.body === "string"
    && (comment.authorLogin === null || typeof comment.authorLogin === "string")));
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
    && isId(subject.id) && isId(subject.number) && isBigint(subject.generation));
}

export type ListedSubject = WalkSubject & { anchor: string };
const listedKey = (record: number) => `absence-listing:${record}`;
/** The subjects earlier runs of this pass saw in the absence listing, one record per run, kept beside the pass's cached pages. */
export async function readListedSubjects(pass: SweepPass): Promise<{ records: number; subjects: ListedSubject[] }> {
  const subjects: ListedSubject[] = [];
  let records = 0;
  for (let record; (record = await pass.read(listedKey(records))) !== undefined; records++) {
    ensure(Array.isArray(record));
    for (const row of record) {
      ensure(isFields(row) && typeof row.anchor === "string" && (row.kind === "issue" || row.kind === "pull_request")
        && isId(row.id) && isId(row.number) && typeof row.updatedAt === "string" && Number.isFinite(Date.parse(row.updatedAt)));
      subjects.push({ anchor: row.anchor, kind: row.kind, id: row.id, number: row.number, updatedAt: new Date(row.updatedAt) });
    }
  }
  return { records, subjects };
}
/** A dropped record (the page ceiling) only makes the next run list those subjects again. */
export async function recordListedSubjects(pass: SweepPass, record: number, subjects: ListedSubject[]): Promise<void> {
  if (subjects.length > 0) await pass.write(listedKey(record), subjects.map((subject) => ({ ...subject, updatedAt: subject.updatedAt.toISOString() })));
}
