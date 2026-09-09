import type { UserRole } from "@/lib/db/types";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubApiError } from "@/lib/github/errors";
import { plural } from "@/lib/plural";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";

/**
 * The repository's existing label names, for the registration form's catalog
 * selectboxes (issue 258). Labels are never created here; a catalog may only
 * pick labels the repository already has, and registration verifies that
 * server-side as the backstop.
 */
export async function GET(request: Request): Promise<Response> {
  // rejectUntrustedRequest refuses a request carrying no Origin header, but a
  // same-origin browser fetch() GET sends none, so guarding this verb would
  // refuse the read the registration form makes. The session gate is what
  // limits this route; see the moderation GET routes for the standing pattern.
  try {
    const session = await getSession();
    if (session === null) {
      return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
    }

    const reference = parseLabelsQuery(request);
    if (reference === null) {
      return errorResponse(400, "INVALID_REQUEST", "Invalid repository labels request.");
    }

    const accessToken = await new PostgresRepositoryStore().getGitHubAccessToken(session.user.id);
    if (accessToken === null) {
      return errorResponse(502, "UPSTREAM_FAILURE", "Unable to read the repository labels on GitHub.");
    }

    const gateway = new GitHubGateway({ accessToken, owner: session.user.id });
    const labels = await gateway.listRepositoryLabels(reference);
    return Response.json({ labels: [...labels] });
  } catch (error) {
    // Issue 327: a 401 is GitHub rejecting the authorization Overflow holds —
    // the token expired or was revoked, so retrying cannot fix it. Same
    // credential vocabulary as the registration endpoint's githubSetupError
    // (register.ts); the message names the one remedy that refreshes the token.
    if (error instanceof GitHubApiError && error.status === 401) {
      return errorResponse(401, "GITHUB_CREDENTIALS", "GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to read the repository labels. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry.");
    }
    // Issue 338: a 403 or 404 carrying no rate-limit evidence is GitHub refusing
    // or withholding the labels read — GitHub answers 404 rather than 403 when
    // it will not reveal a resource, and a bare 403 cannot separate a missing
    // application authorization from a secondary rate limit. Same access
    // vocabulary as the registration endpoint's githubSetupError (register.ts);
    // a 403 that does carry rate-limit evidence falls through to the
    // rate-limit arm below.
    if (error instanceof GitHubApiError && !error.rateLimited && (error.status === 403 || error.status === 404)) {
      if (error.status === 404) {
        return errorResponse(
          403,
          "GITHUB_ACCESS",
          "GitHub answered 404 for the request to read the repository labels. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry.",
        );
      }
      return errorResponse(
        403,
        "GITHUB_ACCESS",
        "GitHub refused to read the repository labels (HTTP 403). GitHub answers 403 both when the Overflow OAuth application is not yet authorized and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry before changing anything. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry.",
      );
    }
    if (error instanceof GitHubApiError && (error.rateLimited || error.status === 429)) {
      const delay = error.retryAfterSeconds === null ? "" : ` Retry after ${error.retryAfterSeconds} ${plural(error.retryAfterSeconds, "second")}.`;
      return errorResponse(
        429,
        "GITHUB_RATE_LIMITED",
        `GitHub rate-limited the request to read the repository labels (HTTP ${error.status}).${delay} Please retry later.`,
      );
    }
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to read the repository labels on GitHub.");
  }
}

/**
 * Exactly the `owner` and `name` query parameters, each a GitHub segment: the
 * same segment rules `parseGitHubRepository` applies to a submitted
 * repository, including stripping a `.git` suffix from the name.
 */
function parseLabelsQuery(request: Request): { owner: string; name: string } | null {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (keys.length !== 2 || !keys.includes("owner") || !keys.includes("name")) {
    return null;
  }

  const owner = searchParams.get("owner");
  const name = searchParams.get("name")?.replace(/\.git$/i, "") ?? null;
  if (owner === null || name === null || !isGitHubRepositorySegment(owner) || !isGitHubRepositorySegment(name)) {
    return null;
  }

  return { owner, name };
}

function isGitHubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

async function getSession(): Promise<{ user: { id: string; role: UserRole } } | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) {
    return null;
  }
  return { user: { id: user.id, role: user.role } };
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
