/**
 * The GitHub userinfo request Overflow overrides the pinned provider with, so
 * sign-in fetches only the public identity fields (`/user`) and never GitHub's
 * email endpoint. Overflow neither requires an email address nor requests the
 * `user:email` scope, so the provider's `/user/emails` fallback (in
 * `@auth/core` 0.41.3, `providers/github.ts`) is dead weight that still spends
 * a request against the authenticated API.
 *
 * The object the provider passes in and the raw profile returned match the
 * `userinfo.request` shape in `@auth/core`'s `providers/oauth.ts`
 * (`UserinfoEndpointHandler`); the result is consumed unchanged by the
 * provider's default `profile()`.
 */
import type { Profile } from "next-auth";

const GITHUB_API_USER_URL = "https://api.github.com/user";

export type GitHubUserinfoContext = {
  tokens: {
    access_token?: string;
    [claim: string]: unknown;
  };
};

export async function requestGitHubPublicIdentity({
  tokens,
}: GitHubUserinfoContext): Promise<Profile> {
  const response = await fetch(GITHUB_API_USER_URL, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "User-Agent": "authjs",
    },
  });
  return await response.json();
}
