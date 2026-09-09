/**
 * The GitHub userinfo request Overflow overrides the pinned provider with, so
 * sign-in fetches only the public identity fields (`/user`) and never GitHub's
 * email endpoint. Overflow neither requires an email address nor requests the
 * `user:email` scope, so the provider's `/user/emails` fallback (in
 * `@auth/core` 0.41.3, `providers/github.ts`) is dead weight that still spends
 * a request against the authenticated API.
 *
 * A non-2xx /user response is refused with a typed error and the
 * `SIGNIN_UPSTREAM_UNAVAILABLE` diagnostic instead of being parsed as a
 * profile, so an outage or rate limit is distinguishable in the sign-in
 * diagnostics from a client-side cause (invalid identity, missing token).
 *
 * The object the provider passes in and the raw profile returned match the
 * `userinfo.request` shape in `@auth/core`'s `providers/oauth.ts`
 * (`UserinfoEndpointHandler`); the result is consumed unchanged by the
 * provider's default `profile()`.
 */
import type { Profile } from "next-auth";
import { SIGN_IN_REFUSAL_REASONS } from "@/lib/auth/sign-in-decision";

const GITHUB_API_USER_URL = "https://api.github.com/user";

/** Longest snippet of GitHub's error message embedded in the diagnostic. */
const UPSTREAM_MESSAGE_SNIPPET_LIMIT = 200;

export type GitHubUserinfoContext = {
  tokens: {
    access_token?: string;
    [claim: string]: unknown;
  };
};

/**
 * Raised when GitHub answers the /user request with a non-2xx status. Carries
 * the numeric status so the sign-in failure distinguishes an upstream problem
 * (rate limit, outage) from a client-side cause.
 */
export class GitHubUserinfoStatusError extends Error {
  readonly status: number;

  constructor(status: number, upstreamMessage: string) {
    super(
      upstreamMessage.length > 0
        ? `GitHub /user responded ${status}: ${upstreamMessage}`
        : `GitHub /user responded ${status}`,
    );
    this.name = "GitHubUserinfoStatusError";
    this.status = status;
  }
}

export async function requestGitHubPublicIdentity({
  tokens,
}: GitHubUserinfoContext): Promise<Profile> {
  const response = await fetch(GITHUB_API_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": "authjs",
    },
  });
  if (!response.ok) {
    throw await refuseUpstreamFailure(response);
  }
  return await response.json();
}

/**
 * Logs the upstream diagnostic and returns the typed error to throw. The body
 * is read only for a bounded message snippet — never parsed as a profile.
 */
async function refuseUpstreamFailure(response: Response): Promise<GitHubUserinfoStatusError> {
  const upstreamMessage = await upstreamMessageSnippet(response);
  const snippet = upstreamMessage.length > 0 ? ` message=${JSON.stringify(upstreamMessage)}` : "";
  console.error(
    `GitHub sign-in refused: ${SIGN_IN_REFUSAL_REASONS.upstream} status=${response.status}${snippet}`,
  );
  return new GitHubUserinfoStatusError(response.status, upstreamMessage);
}

/**
 * The best bounded signal from an error body: GitHub's `message` field when
 * the body is JSON carrying one, otherwise the collapsed raw text. Reading
 * the body never displaces the typed error, and nothing whole is embedded.
 */
async function upstreamMessageSnippet(response: Response): Promise<string> {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    return "";
  }
  const collapsed = bodyText.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(collapsed);
    if (typeof parsed === "object" && parsed !== null && typeof (parsed as { message?: unknown }).message === "string") {
      return truncateSnippet((parsed as { message: string }).message);
    }
  } catch {
    // Not JSON — the collapsed body itself is the signal available.
  }
  return truncateSnippet(collapsed);
}

function truncateSnippet(text: string): string {
  return text.length <= UPSTREAM_MESSAGE_SNIPPET_LIMIT
    ? text
    : `${text.slice(0, UPSTREAM_MESSAGE_SNIPPET_LIMIT)}…`;
}
