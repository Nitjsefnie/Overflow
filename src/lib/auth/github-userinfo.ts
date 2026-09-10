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
 * The request also carries an application-owned deadline — the same 10
 * seconds the GitHub REST and GraphQL clients apply. Expiry aborts the
 * transport and fails the call through this same diagnostic, so a transport
 * that never settles (or ignores the abort signal) cannot hold sign-in open
 * past the deadline.
 *
 * The stock fallback this override routes around is defective as installed.
 * When the profile has no public email, `@auth/core` 0.41.3
 * (`providers/github.js`) reads `(emails.find((e) => e.primary) ?? emails[0]).email`
 * unguarded, so a `200` with an empty list throws
 * `TypeError: Cannot read properties of undefined (reading 'email')` and the sign-in dies mid-handshake. Runtime-reproduced against both
 * this installed build and the published package; reported upstream at
 * https://github.com/nextauthjs/next-auth/issues/13495. Removing this
 * override re-opens the stock fallback for email-less accounts, so the
 * replacement is pinned by tests (tests/auth/,
 * tests/security/github-oauth-scope.test.ts) rather than by this comment.
 *
 * The object the provider passes in and the raw profile returned match the
 * `userinfo.request` shape in `@auth/core`'s `providers/oauth.ts`
 * (`UserinfoEndpointHandler`); the result is consumed unchanged by the
 * provider's default `profile()`.
 */
import type { Profile } from "next-auth";
import { SIGN_IN_REFUSAL_REASONS } from "@/lib/auth/sign-in-decision";

const GITHUB_API_USER_URL = "https://api.github.com/user";

/** The same deadline the GitHub REST and GraphQL clients give every request. */
const defaultTimeoutMs = 10_000;

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
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // One absolute deadline covers the response headers and the body read: the
  // expiry aborts the transport, and the race below settles the call even
  // against a transport that ignores the abort signal.
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("GitHub /user request timed out.");
      controller.abort(error);
      reject(error);
    }, defaultTimeoutMs);
  });
  try {
    const response = await Promise.race([
      fetch(GITHUB_API_USER_URL, {
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "User-Agent": "authjs",
        },
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      throw await refuseUpstreamFailure(response);
    }
    return await response.json();
  } catch (error) {
    // A deadline expiry the transport honored surfaces here as an abort
    // rejection; one that ignored it surfaces as the deadline's own
    // rejection. Either way the call fails through the existing
    // upstream-unavailable diagnostic — unless the failure was already
    // refused with one (the non-2xx path below), which logged as it threw.
    if (controller.signal.aborted && !(error instanceof GitHubUserinfoStatusError)) {
      console.error(
        `GitHub sign-in refused: ${SIGN_IN_REFUSAL_REASONS.upstream} timeout after ${defaultTimeoutMs}ms`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
