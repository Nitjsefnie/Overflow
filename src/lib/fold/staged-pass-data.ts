import { StagedPassDataUnreadable, type SweepPass } from "@/lib/fold/sweep-pass";
import type { GitHubSubject } from "@/lib/github/types";
import type { WalkSubject } from "@/lib/forge/subject-listing";

export type StagedRow = Awaited<ReturnType<SweepPass["readStaged"]>>[number];

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => value !== null && typeof value === "object";
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
// A generation is its decimal text, or the number a pass stored by an earlier release holds.
const isGeneration = (value: unknown) => (typeof value === "string" ? /^-?\d{1,19}$/.test(value) : Number.isInteger(value))
  && BigInt(value as string | number) === BigInt.asIntN(64, BigInt(value as string | number));
function ensure(readable: boolean): asserts readable { if (!readable) throw new StagedPassDataUnreadable(); }

export function stagedIdentity(payload: unknown): GitHubSubject {
  const value = isFields(payload) && "subject" in payload ? payload.subject : payload;
  ensure(isFields(value) && isId(value.id) && isId(value.number));
  return { id: value.id, number: value.number };
}

type Check = (value: unknown) => boolean;
const isString: Check = (value) => typeof value === "string";
const isBoolean: Check = (value) => typeof value === "boolean";
const orNull = (check: Check): Check => (value) => value === null || check(value);
const oneOf = (...values: string[]): Check => (value) => values.includes(value as string);
const listOf = (check: Check): Check => (value) => Array.isArray(value) && value.every(check);
const shape = (fields: Record<string, Check>): Check => (value) => isFields(value) && Object.entries(fields).every(([name, check]) => check(value[name]));

// The staged fields the walk, the fold, the suppression scrub or a materialized row parse, call a method on, bind in SQL or match an
// account by, typed as their producers emit them. A field every reader takes in any type stays out, so a forge's new value there
// cannot discard every pass that stages it.
const login = orNull(isString), account = orNull(isId), timeOrNull = orNull(isString);
const isClosingPullRequest = shape({ id: isId, number: isId, title: isString, url: isString, state: oneOf("OPEN", "CLOSED", "MERGED"),
  mergedAt: timeOrNull, mergeCommitOid: orNull(isString), finalCommitAt: timeOrNull, authorLogin: login, authorGitHubUserId: account,
  repositoryGitHubId: isId, repositoryNameWithOwner: isString });
const isIssue = shape({ title: isString, body: isString, url: isString, state: oneOf("OPEN", "CLOSED"), createdAt: isString,
  updatedAt: isString, closedAt: timeOrNull, authorLogin: login, authorGitHubUserId: account, labels: Array.isArray,
  claimAssigneeGitHubLogin: login, claimAssigneeGitHubUserId: account,
  history: listOf(shape({ actorLogin: login, actorGitHubUserId: account, createdAt: isString })),
  comments: listOf(shape({ body: isString, authorLogin: login, authorGitHubUserId: account, createdAt: isString, lastEditedAt: timeOrNull })),
  closingPullRequests: listOf(isClosingPullRequest) });
const isReview = shape({ id: isId, submittedAt: timeOrNull, dismissal: orNull(shape({ at: isString })) });
const isPullRequestRow: Check = (row) => shape({ evidence: orNull(shape({ reviews: listOf(isReview), rawDiff: isString })) })(row)
  && ((row as Fields).refreshed !== true || shape({ missing: isBoolean, listed: isBoolean })(row));

/** Rows a pass staged itself that no longer have the shape they were staged in cannot resume the pass. */
export async function readStagedRows(pass: SweepPass): Promise<StagedRow[]> {
  const rows = await pass.readStaged();
  for (const { kind, payload } of rows) {
    stagedIdentity(payload);
    if (kind === "pull_request") ensure(isPullRequestRow(payload));
    else if ("number" in (payload as Fields)) ensure(isIssue(payload));
  }
  return rows;
}

export function isDirtySubjects(value: unknown): boolean {
  return Array.isArray(value) && value.every((subject) => isFields(subject)
    && (subject.kind === "ISSUE" || subject.kind === "PULL_REQUEST")
    && isId(subject.id) && isId(subject.number) && isGeneration(subject.generation));
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
