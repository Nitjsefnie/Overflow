import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import type { Profile } from "next-auth";
import type { UserRole } from "@/lib/db/types";
import { getSql } from "@/lib/db/client";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { normalizeModeratorGitHubUserIds } from "@/lib/moderation/roles";
import { encryptToken } from "@/lib/security/token-cipher";

export const githubOAuthScope = "public_repo";

type PersistedGitHubUser = {
  id: string;
  role: UserRole;
};

type GitHubIdentity = {
  githubUserId: number;
  login: string;
  avatarUrl: string | null;
};

export const { handlers: { GET, POST }, auth, signIn } = NextAuth({
  providers: [
    GitHub({
      authorization: { params: { scope: githubOAuthScope } },
    }),
  ],
  session: { strategy: "jwt" },
  callbacks: {
    async signIn({ account, profile }) {
      const identity = readGitHubIdentity(profile);
      const accessToken = account?.access_token;
      if (identity === null || typeof accessToken !== "string" || accessToken.length === 0) {
        return false;
      }

      try {
        await upsertGitHubIdentity(identity, accessToken);
        return true;
      } catch {
        return false;
      }
    },
    async jwt({ token, profile }) {
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

function readGitHubIdentity(profile: Profile | undefined): GitHubIdentity | null {
  if (profile === undefined) {
    return null;
  }

  const githubUserId = typeof profile.id === "number" ? profile.id : Number(profile.id);
  const login = profile.login;
  const avatarUrl = profile.avatar_url;
  if (
    !Number.isSafeInteger(githubUserId) ||
    githubUserId <= 0 ||
    typeof login !== "string" ||
    login.trim().length === 0 ||
    (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== "string")
  ) {
    return null;
  }

  return {
    githubUserId,
    login,
    avatarUrl: typeof avatarUrl === "string" ? avatarUrl : null,
  };
}
