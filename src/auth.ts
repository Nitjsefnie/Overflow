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
  findStoredGitHubToken,
  refreshSessionToken,
  shouldKeepStoredGitHubToken,
  sponsorsActiveRegisteredRepository,
  upsertGitHubAccount,
} from "@/lib/auth/account-store";
import {
  isEpochRejected,
  isSessionExpired,
  readSessionGuardState,
  revokeAccountSessions,
  type SessionGuardSnapshot,
} from "@/lib/auth/session-guard";
import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
  grantsWebhookAdministration,
  parseGrantedScopes,
} from "@/lib/auth/github-oauth-scopes";
import { authTrustHost } from "@/lib/auth/trusted-host";
import { boundedAuthErrorLine } from "@/lib/auth/bounded-logger";
import { readGitHubGrantedScopes } from "@/lib/auth/github-granted-scopes";

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
  events: {
    // The per-account revocation act (issue 1043): for the JWT strategy
    // @auth/core 0.41.3 decodes the cookie's JWT and fires this with it
    // (actions/signout.js), catching handler errors and clearing the cookie
    // regardless — so a database blip at sign-out still clears the cookie but
    // does not revoke server-side, the refresh lookup's documented fail-open
    // shape on a blip.
    async signOut(message) {
      // For the JWT strategy the message is the decoded token; the database
      // strategy's `{ session }` arm never fires here, and narrowing by
      // `"token" in message` keeps the union honest for both.
      const token = "token" in message ? message.token : undefined;
      if (typeof token?.userId === "string") {
        await revokeAccountSessions(token.userId);
      }
    },
  },
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
        // The absolute lifetime first (issue 1043): a token whose sign-in
        // instant is at or past the 30-day maximum dies here, however often
        // the cookie was used in between — the sliding `exp` the framework
        // re-issues can no longer outrun the sign-in. A token with no usable
        // instant dies too: fail-closed, because a pre-claim token is exactly
        // the unbounded cookie the issue is about.
        if (isSessionExpired(token.authenticatedAt, Math.floor(Date.now() / 1000))) {
          return null;
        }
        // Every non-sign-in call lands here. The token survives only while its
        // account row is not DELETED: a pseudonymised account's session ends
        // at the next jwt refresh, which is the single choke point covering
        // every session-user resolution site. (The intersection cast is the
        // framework's `JWT` record meeting the store's token shape.) The
        // lookup reads the guard state — liveness, login and epoch — in one
        // query, and hands what it saw to the epoch gate below even when
        // `refreshSessionToken` fails open on a lookup error, the store's
        // documented database-blip rationale.
        let captured: SessionGuardSnapshot | undefined;
        const refreshed = await refreshSessionToken(token as typeof token & { userId?: unknown }, async (id) => {
          const snapshot = await readSessionGuardState(id);
          captured = snapshot;
          return snapshot;
        });
        if (refreshed === null) {
          return null;
        }
        // A LIVE row compares epochs: a token minted before this account's
        // current session generation (a pre-fix token has no claim at all)
        // ends here. A MISSING row keeps today's pass-through — no epoch to
        // compare against is the stale-session route, not this gate's scope.
        if (captured?.state === "LIVE" && typeof token.userId === "string" && isEpochRejected(token.sessionEpoch, captured.sessionEpoch)) {
          return null;
        }
        return refreshed;
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
      if (typeof token.userId === "string") {
        // Stamp the account's current session epoch (issue 1043): the claim
        // the refresh compares against. Deliberately outside the try above —
        // a failed read errors the sign-in (fail-closed at minting) rather
        // than minting a cookie that dies at its first refresh.
        const guard = await readSessionGuardState(token.userId);
        token.sessionEpoch = guard.sessionEpoch;
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


/**
 * The signIn callback's persistence step: validates the encryption
 * configuration, resolves the role, applies the stored-token continuity
 * ruling (issue 1154), and upserts the account. Exported for the storage-path
 * regression suite (tests/auth/sign-in-token-continuity.test.ts); its only
 * production caller is the signIn callback's `persist` argument — the
 * optional `fetchImpl` parameter stays at its default there.
 */
export async function upsertGitHubIdentity(
  identity: GitHubIdentity,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PersistedGitHubUser> {
  const tokenEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (tokenEncryptionKey === undefined || tokenEncryptionKey.length === 0) {
    throw new Error("Token encryption key must be configured.");
  }

  const role = normalizeModeratorGitHubUserIds(process.env.MODERATOR_GITHUB_USER_IDS).has(identity.githubUserId)
    ? "MODERATOR"
    : "MEMBER";
  const tokenBinding = credentialBinding.userOAuthToken(identity.githubUserId);
  // Stored-token continuity (issue 1154): GitHub issues a new authorization
  // carrying only the scopes the sign-in requested, so a contributor sign-in
  // mints a zero-scope token that must not overwrite the token the sponsor's
  // active registered repositories' webhook repairs still spend. Probe the
  // NEW token only when a stored token exists to protect; the ruling then
  // decides whether the stored bytes stay.
  const existingToken = await findStoredGitHubToken(identity.githubUserId);
  // `Buffer`'s default type parameter is ArrayBufferLike, the bytea read
  // back from the database; Buffer.from narrows to ArrayBuffer.
  let encryptedAccessToken: Buffer = Buffer.from(encryptToken(
    accessToken, tokenEncryptionKey, tokenBinding,
  ), "utf8");
  if (existingToken !== null) {
    const probe = await probeGrantedScopes(accessToken, fetchImpl);
    if (shouldKeepStoredGitHubToken({
      existingToken,
      newTokenGrantedScopes: probe.failed ? [] : probe.grantedScopes,
      probesFailed: probe.failed,
      sponsorsRegisteredRepository: await sponsorsActiveRegisteredRepository(identity.githubUserId),
    })) {
      // The stored bytes are written back unchanged: the upsert's
      // `encrypted_oauth_token = excluded.encrypted_oauth_token` stores the
      // kept token, while the login and avatar still update.
      encryptedAccessToken = existingToken;
    }
  }

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

/**
 * The scopes GitHub grants the sign-in's new token, or the typed failure.
 * Any probe throw — non-2xx, rate limit, deadline, transport — lands in
 * `failed`: the continuity ruling reads a failed probe as "scopes unknown",
 * never as "incapable", and fail-safes to keeping the stored token.
 */
type ScopeProbe = { failed: true } | { failed: false; grantedScopes: string[] };

async function probeGrantedScopes(accessToken: string, fetchImpl: typeof fetch): Promise<ScopeProbe> {
  try {
    return { failed: false, grantedScopes: await readGitHubGrantedScopes(accessToken, fetchImpl) };
  } catch (error) {
    console.error(`GitHub sign-in scope probe failed; continuity falls safe to the stored token. ${boundedAuthErrorLine(error)}`);
    return { failed: true };
  }
}
