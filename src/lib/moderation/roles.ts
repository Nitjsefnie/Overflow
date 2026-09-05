import type { UserRole } from "@/lib/db/types";

/**
 * The role an account gets when it signs in.
 *
 * `MODERATOR_GITHUB_LOGINS` is a FLOOR, not an override. It used to be the sole
 * source of truth, written over the stored role on every sign-in, so a
 * moderator granted inside the product was silently demoted the next time they
 * signed in — which is what made granting the role impossible to build.
 *
 * A configured login is always promoted, so an operator editing the environment
 * can always recover access, including to an instance whose last moderator was
 * revoked. A stored moderator is never demoted by absence from that list.
 * Revoking someone who is still named in the environment therefore lasts only
 * until their next sign-in; the list is the bootstrap, and removing them from
 * it is part of revoking them for good.
 */
export function resolveSignInRole(
  storedRole: UserRole | null,
  isConfiguredModerator: boolean,
): UserRole {
  if (isConfiguredModerator || storedRole === "MODERATOR") {
    return "MODERATOR";
  }
  return "MEMBER";
}

/**
 * The configured moderator logins, lowercased.
 *
 * Lives here rather than in auth.ts so that data-layer code can read it without
 * importing NextAuth: pulling `@/auth` into the moderation store dragged the
 * Next server runtime into a module the database tests import directly, and
 * they could no longer load.
 */
export function normalizeModeratorGitHubLogins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );
}
