import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import type { UserRole } from "@/lib/db/types";
import { getSql } from "@/lib/db/client";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { normalizeModeratorGitHubUserIds } from "@/lib/moderation/roles";
import { encryptToken } from "@/lib/security/token-cipher";
import {
  decideGitHubSignIn,
  readGitHubIdentity,
  type GitHubIdentity,
  type PersistedGitHubUser,
} from "@/lib/auth/sign-in-decision";
import { requestGitHubPublicIdentity } from "@/lib/auth/github-userinfo";
import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
  grantsWebhookAdministration,
  parseGrantedScopes,
} from "@/lib/auth/github-oauth-scopes";

export { GITHUB_CONTRIBUTOR_SCOPE, GITHUB_REPOSITORY_REGISTRATION_SCOPE };

export const { handlers: { GET, POST }, auth, signIn, signOut } = NextAuth({
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
      // The scopes GitHub reports granting arrive once, on the initial OAuth
      // callback (account.scope). Reduced to one boolean hint: it decides
      // whether the registration page shows its form or the widening
      // sign-in, never whether registration proceeds — the route re-reads
      // the grant from GitHub. A JWT issued before the hint existed carries
      // nothing here and reads as not capable.
      if (account?.provider === "github") {
        token.canAdministerWebhooks = grantsWebhookAdministration(parseGrantedScopes(account.scope));
      }

      const identity = readGitHubIdentity(profile);
      if (identity === null) {
        return token;
      }

      try {
        const user = await findGitHubUser(identity.githubUserId);
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
  const encryptedAccessToken = Buffer.from(encryptToken(accessToken, tokenEncryptionKey), "utf8");
  const [user] = await getSql()<PersistedGitHubUser[]>`
    insert into users (
      github_user_id,
      github_login,
      avatar_url,
      role,
      encrypted_oauth_token
    )
    values (
      ${identity.githubUserId},
      ${identity.login},
      ${identity.avatarUrl},
      ${role},
      ${encryptedAccessToken}
    )
    on conflict (github_user_id) do update
    set
      github_login = excluded.github_login,
      avatar_url = excluded.avatar_url,
      -- A FLOOR, never an override. Writing excluded.role unconditionally meant
      -- a moderator granted inside the product was demoted at their next
      -- sign-in, which is what made the role ungrantable. See resolveSignInRole.
      role = case
        when excluded.role = 'MODERATOR' or users.role = 'MODERATOR' then 'MODERATOR'
        else 'MEMBER'
      end::user_role,
      encrypted_oauth_token = excluded.encrypted_oauth_token,
      updated_at = now()
    returning id, role
  `;
  if (user === undefined) {
    throw new Error("GitHub identity upsert returned no user.");
  }

  await claimGitHubIdentity(getSql(), user.id, identity.githubUserId);

  return user;
}

async function findGitHubUser(githubUserId: number): Promise<PersistedGitHubUser | null> {
  const [user] = await getSql()<PersistedGitHubUser[]>`
    select id, role
    from users
    where github_user_id = ${githubUserId}
    limit 1
  `;
  return user ?? null;
}
