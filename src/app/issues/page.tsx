import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { IssueCard } from "@/components/issue-card";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import type { EligibleIssueFilters, EligibleIssueProjection } from "@/lib/dashboard/eligible-issues";

type IssuesPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type IssuesBoardContentProps = {
  memberName: string;
  isModerator: boolean;
  issues: EligibleIssueProjection[];
  /** The resolved page the reader is on, 1-based. */
  page: number;
  /** The resolved rows-per-page the page was served at. */
  pageSize: number;
  /** The raw query state the reader arrived with, carried into the pager links. */
  queryState: Record<string, string | string[] | undefined>;
};

export function IssuesBoardContent({
  memberName,
  isModerator,
  issues,
  page,
  pageSize,
  queryState,
}: IssuesBoardContentProps) {
  const hasPrevious = page > 1;
  // A full page (== pageSize) means a next page may exist; a short page is
  // the last one.
  const hasNext = issues.length === pageSize;
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="eligible-issues-title">
        <p className="eyebrow">External cooperative work</p>
        <h1 id="eligible-issues-title">Eligible issues</h1>
        <p>Higher configured reserves appear first; ties keep the oldest issue first.</p>
      </section>
      <form className="surface" method="get" action="/issues" aria-label="Filter eligible issues">
        <label className="field">
          <span>Repository</span>
          <input name="repository" defaultValue={repositoryValue(queryState)} placeholder="owner/name" />
        </label>
        <label className="field">
          <span>Offered rating label</span>
          <input name="openingLabel" defaultValue={openingLabelValue(queryState)} />
        </label>
        <label className="field">
          <span>Claim state</span>
          <select name="claimState" defaultValue={claimStateValue(queryState)}>
            <option value="OPEN">Unclaimed</option>
            <option value="CLAIMED">Claimed</option>
            <option value="ALL">All</option>
          </select>
        </label>
        <button className="action-button" type="submit">Apply filters</button>
      </form>
      {issues.length > 0 ? (
        <div className="issue-list">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))}
        </div>
      ) : (
        <section className="empty-state" aria-labelledby="no-issues-heading">
          <h2 id="no-issues-heading">No eligible issues are open.</h2>
          <p>Check back after another repository publishes an unassigned issue, or register your own repository.</p>
          <Link className="text-link" href="/repositories/new">
            Register one repository
          </Link>
        </section>
      )}
      {hasPrevious || hasNext ? (
        <nav aria-label="Eligible issue pages">
          {hasPrevious ? (
            <Link className="text-link" href={issuesHref(queryState, page - 1)}>
              Previous page
            </Link>
          ) : null}
          {hasNext ? (
            <Link className="text-link" href={issuesHref(queryState, page + 1)}>
              Next page
            </Link>
          ) : null}
        </nav>
      ) : null}
    </AppShell>
  );
}

function repositoryValue(queryState: Record<string, string | string[] | undefined>): string {
  const value = queryState.repository;
  return typeof value === "string" ? value : "";
}

function openingLabelValue(queryState: Record<string, string | string[] | undefined>): string {
  const value = queryState.openingLabel;
  return typeof value === "string" ? value : "";
}

function claimStateValue(queryState: Record<string, string | string[] | undefined>): string {
  const value = queryState.claimState;
  return value === "CLAIMED" || value === "ALL" ? value : "OPEN";
}

/**
 * The issues page's own reading: a filter reaches the query only when the
 * search params name it exactly once, and any claim state the select cannot
 * produce falls back to the unclaimed board — the same reading the API route
 * applies to its query string.
 */
function readFilters(query: Record<string, string | string[] | undefined>): EligibleIssueFilters {
  const repository = singleValue(query.repository);
  const openingLabel = singleValue(query.openingLabel);
  const requestedClaimState = singleValue(query.claimState);
  const claimState =
    requestedClaimState === "CLAIMED" || requestedClaimState === "ALL" ? requestedClaimState : "OPEN";
  return { repository, openingLabel, claimState };
}

function singleValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function IssuesPage({ searchParams }: IssuesPageProps = {}) {
  const session = await requireMemberPageSession();
  try {
    const {
      listEligibleIssues,
      resolveIssuesBoardPage,
    } = await import("@/lib/dashboard/eligible-issues");
    const query = searchParams === undefined ? {} : await searchParams;
    const filters = readFilters(query);
    const resolved = resolveIssuesBoardPage(numericParam(query.page), numericParam(query.pageSize));
    const issues = await listEligibleIssues(session.user.id, {
      ...filters,
      page: resolved.page,
      pageSize: resolved.pageSize,
    });
    return (
      <IssuesBoardContent
        memberName={session.user.name}
        isModerator={isModeratorSession(session)}
        issues={issues}
        page={resolved.page}
        pageSize={resolved.pageSize}
        queryState={query}
      />
    );
  } catch {
    return (
      <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
        <section className="empty-state" aria-labelledby="issues-error-heading">
          <h1 id="issues-error-heading">Eligible issues could not be loaded.</h1>
          <p>Check the ledger connection, then try this list again.</p>
          <Link className="text-link" href="/issues">
            Retry eligible issues
          </Link>
        </section>
      </AppShell>
    );
  }
}

/**
 * The page window's numbers straight from the query string: anything the
 * query module would not read as a number stays undefined, so the module's
 * own defaults and clamp remain the only page arithmetic.
 */
function numericParam(value: string | string[] | undefined): number | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The pager's href for one page of the current board view: every query
 * parameter the reader arrived with rides along unchanged, and only the page
 * itself is replaced (omitted for the first page).
 */
function issuesHref(queryState: Record<string, string | string[] | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryState)) {
    if (typeof value === "string") {
      params.set(key, value);
    }
  }
  if (page > 1) {
    params.set("page", String(page));
  } else {
    params.delete("page");
  }
  const queryString = params.toString();
  return queryString.length > 0 ? `/issues?${queryString}` : "/issues";
}
