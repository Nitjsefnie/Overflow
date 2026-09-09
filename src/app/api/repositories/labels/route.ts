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
