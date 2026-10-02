import { getSql } from "@/lib/db/client";
import type { UserRole } from "@/lib/db/types";
import { ForgeIdentityError, normalizeInstanceUrl } from "@/lib/forge/identities";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubApiError, classifyGitHubApiFailure, isUnclassifiedGitHubFailure } from "@/lib/github/errors";
import { isUnclassifiedGitLabFailure } from "@/lib/gitlab/api-error";
import { GitLabApiError, GitLabGateway } from "@/lib/gitlab/client";
import { plural } from "@/lib/plural";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";

/**
 * The gateway surface the labels read uses — the full GitHubGateway satisfies
 * it, and a derivation (or test) can supply the one method structurally.
 */
export type LabelsRouteGateway = Pick<GitHubGateway, "listRepositoryLabels">;

/** The forge-identity store surface the GitLab arm reads its credential through. */
export type LabelsRouteForgeIdentityStore = Pick<PostgresForgeIdentityStore, "getForgeToken">;

export type LabelsRouteSession = {
  user: { id: string; role: UserRole };
};

export type LabelsRouteDependencies = {
  getSession: () => Promise<LabelsRouteSession | null>;
  getGitHubAccessToken: (userId: string) => Promise<string | null>;
  createGitHubGateway: (accessToken: string, owner: string) => LabelsRouteGateway;
  createForgeIdentityStore: (tokenEncryptionKey: string) => LabelsRouteForgeIdentityStore;
};

/**
 * The repository's existing label names, for the registration form's catalog
 * selectboxes (issue 258). Labels are never created here; a catalog may only
 * pick labels the repository already has, and registration verifies that
 * server-side as the backstop.
 */
export function createLabelsGetHandler(dependencies: LabelsRouteDependencies) {
  return async function getRepositoryLabels(request: Request): Promise<Response> {
    // rejectUntrustedRequest refuses a request carrying no Origin header, but a
    // same-origin browser fetch() GET sends none, so guarding this verb would
    // refuse the read the registration form makes. The session gate is what
    // limits this route; see the moderation GET routes for the standing pattern.
    try {
      const session = await dependencies.getSession();
      if (session === null) {
        return errorResponse(401, "UNAUTHENTICATED", "Sign in is required.");
      }

      const reference = parseLabelsQuery(request);
      if (reference === null) {
        return errorResponse(400, "INVALID_REQUEST", "Invalid repository labels request.");
      }
      if ("provider" in reference) {
        return await gitlabLabelsResponse(dependencies, session.user.id, reference);
      }

      const accessToken = await dependencies.getGitHubAccessToken(session.user.id);
      if (accessToken === null) {
        return errorResponse(502, "UPSTREAM_FAILURE", "Unable to read the repository labels on GitHub.");
      }

      const gateway = dependencies.createGitHubGateway(accessToken, session.user.id);
      const labels = await readRepositoryLabels(gateway, reference);
      return Response.json({ labels: [...labels] });
    } catch (error) {
    // Issue 327: a 401 is GitHub rejecting the authorization Overflow holds —
    // the token expired or was revoked, so retrying cannot fix it. Same
    // credential vocabulary as the registration endpoint's githubSetupError
    // (register.ts); the message names the one remedy that refreshes the token.
    if (error instanceof GitHubApiError && classifyGitHubApiFailure(error) === "CREDENTIALS") {
      return errorResponse(401, "GITHUB_CREDENTIALS", "GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to read the repository labels. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry.");
    }
    // Issue 338: a 403 or 404 carrying no rate-limit evidence is GitHub refusing
    // or withholding the labels read — GitHub answers 404 rather than 403 when
    // it will not reveal a resource, and a bare 403 cannot separate a missing
    // application authorization from a secondary rate limit. Same access
    // vocabulary as the registration endpoint's githubSetupError (register.ts);
    // a 403 that does carry rate-limit evidence falls through to the
    // rate-limit arm below.
    if (error instanceof GitHubApiError && classifyGitHubApiFailure(error) === "ACCESS") {
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
    if (error instanceof GitHubApiError && classifyGitHubApiFailure(error) === "RATE_LIMITED") {
      const delay = error.retryAfterSeconds === null ? "" : ` Retry after ${error.retryAfterSeconds} ${plural(error.retryAfterSeconds, "second")}.`;
      return errorResponse(
        429,
        "GITHUB_RATE_LIMITED",
        `GitHub rate-limited the request to read the repository labels (HTTP ${error.status}).${delay} Please retry later.`,
      );
    }
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to read the repository labels on GitHub.");
    }
  };
}

/**
 * The GitHub label walk, with the failures this route records before it maps
 * them (issues 883, 890).
 *
 * The bound on this walk is the collection-walk bound: it throws a plain `Error`
 * naming the collection and the ceiling the walk stopped at. It is not a
 * `GitHubApiError` at all — no status, no rate-limit evidence — so it matches no
 * arm the caller's catch classifies.
 *
 * The gate here is exactly "no arm classified this" (issue 890), which is those
 * two failures together: the walk's own bound, and a `GitHubApiError` whose
 * status none of the caller's arms can explain, a 500 among them. Both reach the
 * generic 502, a fixed string that names neither the collection and ceiling nor
 * the status, so the error object is the only carrier of either to an operator —
 * and a GitHub 5xx used to be recorded nowhere at all. The classified arms stay
 * silent, and that is the whole of their exemption: each already answered the
 * submitter with a message naming the remedy for what GitHub reported about its
 * own authorization or its own availability.
 *
 * What this line is handed, and what it must not be handed. The error goes to the
 * log WHOLE, not rendered: `GitHubApiError` carries the upstream response text as
 * its own `body` property, capped at 500 characters by its constructor, and what
 * GitHub actually said about the failure is the part an operator cannot get from
 * the status. That is the standing design (errors.ts: response diagnostics belong
 * in service logs and out of serialized API errors), so the sibling registration
 * diagnostic's redacting, 200-capped rendering is deliberately NOT applied here,
 * and a test pins both halves — the argument is the error, and its status and body
 * ride along.
 *
 * What must not arrive is a narrower set still. The read is wrapped here rather
 * than logged in the caller's catch because the credential read ahead of the walk
 * happens in that catch, and its error can carry the stored token; nothing
 * between the two gets to log it. The wrap is therefore the only place on this
 * route where a GitHub failure can be recorded, and what it admits is exactly the
 * gate above — the walk's bound, or a status no arm classified.
 */
async function readRepositoryLabels(
  gateway: LabelsRouteGateway,
  reference: { owner: string; name: string },
): Promise<Set<string>> {
  try {
    return await gateway.listRepositoryLabels(reference);
  } catch (error) {
    if (isUnclassifiedGitHubFailure(error)) {
      console.error("Reading the repository labels on GitHub failed.", error);
    }
    throw error;
  }
}

/**
 * The labels read recognizes exactly two query shapes: the GitHub
 * `owner`/`name` pair and the GitLab `provider=gitlab&instance&project`
 * triple. Anything else — any other key set, any other provider value — is
 * unrecognized and reads as the route's structured 400.
 */
type LabelsQueryReference = { owner: string; name: string } | {
  provider: "gitlab";
  instance: string;
  project: string;
};

/**
 * Exactly the `owner` and `name` query parameters, each a GitHub segment: the
 * same segment rules `parseGitHubRepository` applies to a submitted
 * repository, including stripping a `.git` suffix from the name. A GitLab
 * read names its instance and project instead; the instance's value is
 * validated (and normalized) by the GitLab arm, the project's by
 * `parseGitLabProjectReference`.
 */
function parseLabelsQuery(request: Request): LabelsQueryReference | null {
  const searchParams = new URL(request.url).searchParams;
  const keys = [...searchParams.keys()];
  if (keys.length === 2 && keys.includes("owner") && keys.includes("name")) {
    const owner = searchParams.get("owner");
    const name = searchParams.get("name")?.replace(/\.git$/i, "") ?? null;
    if (owner === null || name === null || !isGitHubRepositorySegment(owner) || !isGitHubRepositorySegment(name)) {
      return null;
    }

    return { owner, name };
  }
  if (keys.length === 3 && keys.includes("provider") && keys.includes("instance") && keys.includes("project")) {
    const provider = searchParams.get("provider");
    const instance = searchParams.get("instance");
    const project = searchParams.get("project");
    if (provider !== "gitlab" || instance === null || project === null) {
      return null;
    }

    return { provider, instance, project };
  }
  return null;
}

/**
 * The submitted project reference, in the shape the gateway call consumes:
 * a numeric id is resolved through `getRepositoryById` first (the working
 * call the registration path makes, register.ts), a `group/project` path
 * splits owner-first exactly as the registration path splits it — the
 * gateway builds one URL-encoded path segment from `owner/name`.
 */
function parseGitLabProjectReference(project: string): { id: number } | { owner: string; name: string } | null {
  if (/^\d+$/.test(project)) {
    const id = Number(project);
    if (!Number.isSafeInteger(id) || id <= 0) {
      return null;
    }
    return { id };
  }
  const segments = project.split("/");
  if (segments.length < 2) {
    return null;
  }
  return { owner: segments.slice(0, -1).join("/"), name: segments[segments.length - 1]! };
}

const gitlabProjectNotFoundMessage = "No GitLab project with that id or path is visible through your linked identity. Check the project id or path and that the identity still has access, then retry.";

/**
 * The GitLab arm of the labels read (issue 546): the catalog selectboxes read
 * a GitLab project's labels through the submitter's verified linked identity
 * — its decrypted PAT is the gateway credential, exactly as on the
 * registration path. The resolution order is fixed: the cipher key gate, the
 * instance normalization, the project reference, the identity lookup, then
 * the gateway call whose upstream statuses map onto the route's structured
 * errors.
 */
async function gitlabLabelsResponse(
  dependencies: LabelsRouteDependencies,
  userId: string,
  reference: { provider: "gitlab"; instance: string; project: string },
): Promise<Response> {
  const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
    return errorResponse(503, "CONFIGURATION", "Token encryption is not configured.");
  }

  // The same normalization the link flow stores under: one input cannot be
  // valid here and invalid there (or vice versa).
  let instanceUrl: string;
  try {
    instanceUrl = normalizeInstanceUrl(reference.instance);
  } catch (error) {
    if (error instanceof ForgeIdentityError) {
      return errorResponse(400, "INVALID_REQUEST", error.message);
    }
    throw error;
  }

  const project = parseGitLabProjectReference(reference.project);
  if (project === null) {
    // The same split the registration rule makes (register.ts): a numeric
    // reference that is not a positive integer names the id rule, and only a
    // non-numeric, slash-less reference reads as a malformed path.
    return errorResponse(
      400,
      "INVALID_REQUEST",
      /^\d+$/.test(reference.project)
        ? "The GitLab project id must be a positive integer."
        : "Submit the GitLab project as a positive numeric id or a path with namespace, like group/project.",
    );
  }

  let credential: { token: string; identityId: string } | null;
  try {
    credential = await dependencies.createForgeIdentityStore(tokenEncryptionKey).getForgeToken(userId, instanceUrl);
  } catch {
    // The identity read is this arm's store read; a failure of it is an
    // upstream problem of the GitLab arm and must not answer with the
    // GitHub-worded 502 the outer catch fall-through would give it.
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to read the repository labels on GitLab.");
  }
  if (credential === null) {
    return errorResponse(
      404,
      "NOT_FOUND",
      `No GitLab identity is linked for ${instanceUrl}. Link one on the dashboard's Forge identities page, then retry.`,
    );
  }

  const gateway = new GitLabGateway({ instanceUrl, token: credential.token });
  try {
    const labels = await readGitLabLabels(gateway, project);
    if (labels === null) {
      // The numeric form's `null` is the gateway's "unreachable project"
      // verdict — answered exactly like the labels read's own 404.
      return errorResponse(404, "NOT_FOUND", gitlabProjectNotFoundMessage);
    }
    return Response.json({ labels: [...labels] });
  } catch (error) {
    if (error instanceof GitLabApiError && (error.status === 401 || error.status === 403)) {
      return errorResponse(
        403,
        "FORBIDDEN",
        `GitLab refused the labels read through your linked identity (HTTP ${error.status}). The identity may have been revoked; re-link it on the dashboard's Forge identities page, then retry.`,
      );
    }
    if (error instanceof GitLabApiError && error.status === 404) {
      return errorResponse(404, "NOT_FOUND", gitlabProjectNotFoundMessage);
    }
    if (error instanceof GitLabApiError && error.status === 429) {
      return errorResponse(
        429,
        "RATE_LIMITED",
        `GitLab rate-limited the labels read (HTTP ${error.status}). Please retry later.`,
      );
    }
    return errorResponse(502, "UPSTREAM_FAILURE", "Unable to read the repository labels on GitLab.");
  }
}

/**
 * The GitLab label walk, with the failures this route records before it maps
 * them (issue 892).
 *
 * The bound on this walk is the collection-walk bound: it throws a plain `Error`
 * naming the collection and the ceiling the walk stopped at. It is not a
 * `GitLabApiError` at all — no status, no endpoint — so it matches no arm the
 * caller's catch classifies.
 *
 * The gate here is exactly "no arm classified this", which is those two
 * failures together: the walk's own bound, and a `GitLabApiError` whose status
 * none of the caller's arms can explain, a 500 among them. Both reach the
 * generic 502, a fixed string that names neither the collection and ceiling
 * nor the status, so the error object is the only carrier of either to an
 * operator — and a GitLab 5xx used to be recorded nowhere at all. The
 * classified arms stay silent, and that is the whole of their exemption: each
 * already answered the submitter with a message naming the remedy for what
 * GitLab reported about its own identity or its own availability.
 *
 * What this line is handed, and what it must not be handed. The error goes to
 * the log WHOLE, not rendered: `GitLabApiError` carries the upstream response
 * text as its own `body` property, capped at 500 characters by its
 * constructor, and what GitLab actually said about the failure is the part an
 * operator cannot get from the status. That is the standing design (api-error:
 * response diagnostics belong in service logs and out of serialized API
 * errors), so the diagnostic rides along unredacted, and a test pins both
 * halves — the argument is the error, and its status and body ride along.
 *
 * The wrap is where the walk lives, and the only place its unclassified
 * failures are recorded. This arm's credential read — the linked identity's
 * token lookup — sits ahead of the try in its own catch, whose failure
 * answers the GitLab-worded 502 itself, so nothing sensitive can pass through
 * the caller's catch here.
 *
 * The numeric form's `null` repository verdict is returned as `null`, not
 * thrown: it is the gateway's "unreachable project" answer — a verdict about
 * the project, not a failure of the read — and the caller keeps its 404
 * mapping for it. It logs as nothing.
 */
async function readGitLabLabels(
  gateway: GitLabGateway,
  project: { id: number } | { owner: string; name: string },
): Promise<Set<string> | null> {
  try {
    if ("id" in project) {
      // The numeric form has no owner/name until the id resolves; a null is
      // the gateway's "unreachable project" verdict, returned as null so the
      // caller answers it with the labels read's own 404.
      const repository = await gateway.getRepositoryById(project.id);
      if (repository === null) {
        return null;
      }
      return await gateway.listRepositoryLabels({ owner: repository.owner, name: repository.name });
    }
    return await gateway.listRepositoryLabels(project);
  } catch (error) {
    if (isUnclassifiedGitLabFailure(error)) {
      console.error("Reading the repository labels on GitLab failed.", error);
    }
    throw error;
  }
}

function isGitHubRepositorySegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

async function getSession(): Promise<LabelsRouteSession | null> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (typeof user?.id !== "string" || (user.role !== "MEMBER" && user.role !== "MODERATOR")) {
    return null;
  }
  return { user: { id: user.id, role: user.role } };
}

/**
 * The direct export Next.js routes on: a thin wrapper delegating to the
 * factory with the production dependency functions — the same construction
 * sites the pre-refactor handler used. The arrows build their store or
 * gateway per call, and nothing they build is retained between requests; the
 * database client behind them is the shared pooled getSql() client, which
 * outlives requests by design.
 */
export const GET = createLabelsGetHandler({
  getSession,
  getGitHubAccessToken: (userId) => new PostgresRepositoryStore().getGitHubAccessToken(userId),
  createGitHubGateway: (accessToken, owner) => new GitHubGateway({ accessToken, owner }),
  createForgeIdentityStore: (tokenEncryptionKey) => new PostgresForgeIdentityStore(getSql(), tokenEncryptionKey),
});

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
