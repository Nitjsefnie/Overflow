import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import type { UserRole } from "@/lib/db/types";
import { getSql } from "@/lib/db/client";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { normalizeModeratorGitHubUserIds } from "@/lib/moderation/roles";
import { credentialBinding, encryptToken } from "@/lib/security/token-cipher";
import {
  decideGitHubSignIn,
  readGitHubIdentity,
  type GitHubIdentity,
  type PersistedGitHubUser,
} from "@/lib/auth/sign-in-decision";
import { requestGitHubPublicIdentity } from "@/lib/auth/github-userinfo";
import {
  findGitHubAccount,
  findSessionAccountState,
  refreshSessionToken,
  upsertGitHubAccount,
} from "@/lib/auth/account-store";
import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
  grantsWebhookAdministration,
  parseGrantedScopes,
} from "@/lib/auth/github-oauth-scopes";
import { authTrustHost } from "@/lib/auth/trusted-host";
import { boundedAuthErrorLine } from "@/lib/auth/bounded-logger";

export { GITHUB_CONTRIBUTOR_SCOPE, GITHUB_REPOSITORY_REGISTRATION_SCOPE };

export const { handlers: { GET, POST }, auth, signIn, signOut } = NextAuth({
  // Auth.js trusts the request's host only when its configuration says so, and
  // answers every auth route `500 [auth][error] UntrustedHost` otherwise. Left
  // unset, `@auth/core` derives trust from `AUTH_URL`/`AUTH_TRUST_HOST`/
  // `VERCEL`/`CF_PAGES` (or non-production NODE_ENV) — so a deployment
  // configured from only the documented settings answered every sign-in route
  // 500 while readiness answered 200 (issue 649). Derive the flag from APP_URL
  // instead, the origin the origin guard already enforces, so the documented
  // environment signs in; an operator-set AUTH_URL or AUTH_TRUST_HOST keeps
  // the precedence it has under @auth/core's own derivation.
  trustHost: authTrustHost(),
  // The service journal is size-bounded and shared with the privileged-action
  // audit lines, and a request whose session cookie cannot be decrypted used
  // to cost it a multi-line, ANSI-coloured error block per request: the
  // @auth/core default logger prints the error, then the cause's stack, then
  // the cause's details. The `logger` option is the single lever for every
  // @auth/core error path, so the error member emits exactly one bounded
  // line (src/lib/auth/bounded-logger.ts): the class name and the cause's
  // message, control-escaped and capped, no stack, no details, and never any
  // cookie material. No error path is silenced — every error still logs,
  // bounded; `warn` and `debug` keep @auth/core's defaults.
  logger: {
    error(error: unknown) {
      console.error(boundedAuthErrorLine(error));
    },
  },
  providers: [
    GitHub({
      // The least-privilege default (issue 599): public identity only, so any
      // unlabelled signIn("github") grants nothing. The repository-registration
      // sign-in passes GITHUB_REPOSITORY_REGISTRATION_SCOPE per call, which
      // overrides this. Explicitly empty, never omitted — see
      // src/lib/auth/github-oauth-scopes.ts.
      authorization: { params: { scope: GITHUB_CONTRIBUTOR_SCOPE } },
      // GitHub's default userinfo request also hits /user/emails whenever the
      // profile has no public email. Overflow reads no email anywhere, so the
      // override fetches only the public identity fields. Reverting it
      // re-activates the stock fallback — see "Why `@auth/core` is not
      // patched" in patches/README.md.
      userinfo: {
        url: "https://api.github.com/user",
        request: requestGitHubPublicIdentity,
      },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ account, profile }) {
      return decideGitHubSignIn({
        profile,
        accessToken: account?.access_token,
        persist: upsertGitHubIdentity,
      });
    },
    async jwt({ token, profile, account }) {
      // The cookie holds only what the account-data page states (issue 678):
      // the public GitHub identity and Overflow's hints. The e-mail a token
      // minted before this change still carries leaves here, on every
      // invocation, so one refresh strips it.
      delete token.email;
      // The scopes GitHub reports granting arrive once, on the initial OAuth
      // callback (account.scope). Reduced to one boolean hint: it decides
      // whether the registration page shows its form or the widening
      // sign-in, never whether registration proceeds — the route re-reads
      // the grant from GitHub. A JWT issued before the hint existed carries
      // nothing here and reads as not capable.
      if (account?.provider === "github") {
        token.canAdministerWebhooks = grantsWebhookAdministration(parseGrantedScopes(account.scope));
        // When the holder last completed a GitHub sign-in, in whole epoch
        // seconds. Written here and nowhere else: only the OAuth callback
        // carries an account, so a session read or update carries the
        // instant forward and holding the cookie never refreshes it. Minting
        // an API token requires it to be recent (src/app/api/tokens/route.ts).
        token.authenticatedAt = Math.floor(Date.now() / 1000);
      }

      const identity = readGitHubIdentity(profile);
      if (identity === null) {
        // Every non-sign-in call lands here. The token survives only while its
        // account row is not DELETED: a pseudonymised account's session ends
        // at the next jwt refresh, which is the single choke point covering
        // every session-user resolution site. (The intersection cast is the
        // framework's `JWT` record meeting the store's token shape.)
        return await refreshSessionToken(token as typeof token & { userId?: unknown }, (id) =>
          findSessionAccountState(id),
        );
      }

      // The sign-in path names the token with the login from the profile —
      // the display name never enters the token, and the provider's default
      // profile() mapping (name: profile.name ?? profile.login) already
      // carries the login after the userinfo projection; this makes it
      // explicit and independent of that mapping.
      token.name = identity.login;
      try {
        const user = await findGitHubAccount(identity.githubUserId);
        if (user !== null) {
          token.userId = user.id;
          token.role = user.role;
        }
      } catch {
        delete token.userId;
        delete token.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (
        session.user !== undefined &&
        typeof token.userId === "string" &&
        (token.role === "MEMBER" || token.role === "MODERATOR")
      ) {
        session.user.id = token.userId;
        (session.user as typeof session.user & { role?: UserRole }).role = token.role;
        (session.user as typeof session.user & { canAdministerWebhooks?: boolean }).canAdministerWebhooks =
          token.canAdministerWebhooks === true;
        // A JWT issued before the claim existed carries none, and reads as a
        // sign-in too old to mint a token.
        if (typeof token.authenticatedAt === "number" && Number.isFinite(token.authenticatedAt)) {
          (session.user as typeof session.user & { authenticatedAt?: number }).authenticatedAt =
            token.authenticatedAt;
        }
      }
      return session;
    },
  },
});


async function upsertGitHubIdentity(identity: GitHubIdentity, accessToken: string): Promise<PersistedGitHubUser> {
  const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
    throw new Error("Token encryption key must be configured.");
  }

  const role = normalizeModeratorGitHubUserIds(process.env.MODERATOR_GITHUB_USER_IDS).has(identity.githubUserId)
    ? "MODERATOR"
    : "MEMBER";
  const encryptedAccessToken = Buffer.from(encryptToken(
    accessToken, tokenEncryptionKey, credentialBinding.userOAuthToken(identity.githubUserId),
  ), "utf8");
  const user = await upsertGitHubAccount({
    githubUserId: identity.githubUserId,
    login: identity.login,
    avatarUrl: identity.avatarUrl,
    role,
    encryptedAccessToken,
  });

  await claimGitHubIdentity(getSql(), user.id, identity.githubUserId);

  return user;
}
