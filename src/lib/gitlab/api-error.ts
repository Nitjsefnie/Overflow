import type { GitLabRestResponse } from "@/lib/gitlab/client";

/**
 * The gateway's error taxonomy, extracted verbatim from client.ts (issue 871):
 * every upstream failure shape the module recognizes folds into this class —
 * an HTTP status, or status 0 with a fixed diagnostic body for a transport
 * failure or, now, a structurally wrong success response. `message` carries
 * only the status; the diagnostic travels in `.body`, truncated to 500.
 */
export class GitLabApiError extends Error {
  public readonly body: string | null;

  public constructor(
    public readonly status: number,
    body: string | null = null,
  ) {
    super(`GitLab API request failed with status ${status}.`);
    this.name = "GitLabApiError";
    this.body = body === null ? null : body.slice(0, 500);
  }

  // Keep response diagnostics in service logs, out of serialized API errors.
  public toJSON() {
    return { name: this.name, status: this.status };
  }
}

/**
 * Whether no arm of the labels route's GitLab classification explains this
 * failure, and it is therefore worth recording (issue 892).
 *
 * The classified set is exactly what the repository-labels route's GitLab arm
 * maps to a structured answer (route.ts, `gitlabLabelsResponse`'s catch):
 * 401 and 403 → 403 FORBIDDEN, 404 → 404 NOT_FOUND, 429 → 429 RATE_LIMITED. A
 * failure no arm classified reaches the submitter as a fixed generic 502 that
 * names nothing but the step that failed — the collection-walk bound's plain
 * `Error`, or a status GitLab answered with that the route has no arm for, a
 * 500 among them — so this is the gate that lets the error reach an operator's
 * log. Status 0 is the module's transport rank (an unreachable instance, an
 * unparsable or structurally wrong success body), never a status GitLab sent,
 * so it is unclassified here like any other status the route does not answer
 * for.
 *
 * A classified failure is not silent by omission: the message the route
 * answered with already named the remedy for what GitLab reported about the
 * submitter's own identity or its own availability.
 *
 * This set is the LABELS ROUTE's classification, not the module's: a future
 * consumer classifying a different set must parameterize this gate rather than
 * widen it silently.
 */
export function isUnclassifiedGitLabFailure(error: unknown): boolean {
  return !(error instanceof GitLabApiError) || ![401, 403, 404, 429].includes(error.status);
}

/**
 * A 200 whose body fails to parse as JSON at all — an HTML error page from an
 * intermediary, or an empty body (issue 879) — is the instance misbehaving,
 * one step earlier than 871's non-array body: the parse throws a raw
 * SyntaxError outside the taxonomy (no status, no endpoint). The failure is
 * recognized here and folded into the same typed rank as a transport failure:
 * status 0 — never a fabricated HTTP status the server never sent — with the
 * endpoint in `.body`, so run failure records name the failed boundary. The
 * endpoint arrives explicitly from each caller; no other part of the request
 * contract changes.
 */
function parseJsonBody(response: GitLabRestResponse, path: string): unknown {
  try {
    return JSON.parse(response.body);
  } catch {
    throw new GitLabApiError(0, `GitLab returned an unparsable body from ${path}.`);
  }
}

/**
 * Issue 871: a 200 whose JSON body parses but is not an array — an object,
 * or the JSON literal null — is an instance misbehaving, not a shape the
 * walker can consume. Letting it reach `CollectionWalkBound.add` dies with a
 * raw TypeError outside the taxonomy (no status, no endpoint), so it is
 * recognized here and folded into the same typed rank as a transport failure:
 * status 0 — never a fabricated HTTP status the server never sent — with the
 * endpoint in `.body`, so run failure records name the failed boundary. The
 * endpoint arrives explicitly from the walker; the walk's ceilings contract
 * in CollectionWalkBound is not changed by it. A body that fails to parse at
 * all takes the same rank through `parseJsonBody` (issue 879).
 */
export async function responseJsonArray<T>(response: GitLabRestResponse, path: string): Promise<T[]> {
  const parsed = parseJsonBody(response, path);
  if (!Array.isArray(parsed)) {
    throw new GitLabApiError(0, `GitLab returned a non-array body from ${path}.`);
  }
  return parsed as T[];
}

/**
 * The single-object counterpart of `responseJsonArray`, moved here from
 * client.ts (issue 879): the repository, issue, merge-request and hook reads
 * all parse their 200 bodies through it. Issue 886: a body that parses but is
 * not an object — the literal null, a quoted string, a number — reaches the
 * mappers and dies as a raw TypeError outside the taxonomy (no status, no
 * endpoint), so like the array walker it is recognized here and folded into
 * the same typed rank as a transport failure: status 0 — never a fabricated
 * HTTP status the server never sent — with the endpoint in `.body`, so run
 * failure records name the failed boundary. Every single-object read in the
 * module consumes a non-null object (GitLabProject, GitLabIssueObject,
 * GitLabMergeRequestObject, the `{ id: number }` hook lookup, GitLabHookObject),
 * so the guard cannot reject a body any caller consumes. Like the walker, it
 * names the endpoint in `.body`.
 */
export async function responseJson<T>(response: GitLabRestResponse, path: string): Promise<T> {
  const parsed = parseJsonBody(response, path);
  if (typeof parsed !== "object" || parsed === null) {
    throw new GitLabApiError(0, `GitLab returned a non-object body from ${path}.`);
  }
  return parsed as T;
}
