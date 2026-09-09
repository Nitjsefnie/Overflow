/**
 * The sign-in decision for GitHub identities, extracted from `src/auth.ts` so
 * the classification of a refusal — and the diagnostic each cause emits — is
 * exported and unit-testable without a NextAuth instance.
 */
import type { Profile } from "next-auth";
import type { UserRole } from "@/lib/db/types";

/**
 * Stable reason codes for a GitHub sign-in refusal. Operators grep logs for
 * these; renaming one shows the wrong diagnostic, so the classification and
 * the log line share this declaration.
 */
export const SIGN_IN_REFUSAL_REASONS = {
  /** The GitHub profile failed identity validation (no usable id/login). */
  identity: "SIGNIN_IDENTITY_INVALID",
  /** The OAuth account carried no usable access token, or an empty one. */
  accessToken: "SIGNIN_ACCESS_TOKEN_MISSING",
  /** Persisting the identity threw. The error itself is logged alongside. */
  persistence: "SIGNIN_PERSIST_FAILED",
} as const;

export type SignInRefusalReason = (typeof SIGN_IN_REFUSAL_REASONS)[keyof typeof SIGN_IN_REFUSAL_REASONS];

export type GitHubIdentity = {
  githubUserId: number;
  login: string;
  avatarUrl: string | null;
};

export type PersistedGitHubUser = {
  id: string;
  role: UserRole;
};

export type PersistGitHubIdentity = (
  identity: GitHubIdentity,
  accessToken: string,
) => Promise<PersistedGitHubUser>;

/**
 * Validates the GitHub profile and returns the identity Overflow persists, or
 * null when the profile cannot be trusted. Moved verbatim from `src/auth.ts`.
 */
export function readGitHubIdentity(profile: Profile | undefined): GitHubIdentity | null {
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

/**
 * Decides a GitHub sign-in: validates the profile identity, requires an access
 * token, and attempts persistence — emitting a stable reason-code diagnostic
 * for whichever cause refuses the sign-in. The return value stays the
 * sanitized refusal/allowance (`false`/`true`) and nothing else.
 */
export async function decideGitHubSignIn(input: {
  profile: Profile | undefined;
  accessToken: unknown;
  persist: PersistGitHubIdentity;
}): Promise<boolean> {
  const identity = readGitHubIdentity(input.profile);
  if (identity === null) {
    return refuse(SIGN_IN_REFUSAL_REASONS.identity);
  }
  if (typeof input.accessToken !== "string" || input.accessToken.length === 0) {
    return refuse(SIGN_IN_REFUSAL_REASONS.accessToken);
  }
  try {
    await input.persist(identity, input.accessToken);
    return true;
  } catch (error) {
    return refuse(SIGN_IN_REFUSAL_REASONS.persistence, error);
  }
}

function refuse(reason: SignInRefusalReason, error?: unknown): false {
  if (error === undefined) {
    console.error(`GitHub sign-in refused: ${reason}`);
  } else {
    console.error(`GitHub sign-in refused: ${reason}`, error);
  }
  return false;
}
