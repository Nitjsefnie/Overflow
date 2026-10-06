import type { UserRole } from "@/lib/db/types";

/**
 * The role an account gets when it signs in.
 *
 * `MODERATOR_GITHUB_USER_IDS` is a FLOOR, not an override. It used to be the sole
 * source of truth, written over the stored role on every sign-in, so a
 * moderator granted inside the product was silently demoted the next time they
 * signed in — which is what made granting the role impossible to build.
 *
 * A configured account id is always promoted, so an operator editing the environment
 * can always recover access, including to an instance whose last moderator was
 * revoked. A stored moderator on a LIVE row is never demoted by absence from
 * that list. Revoking someone who is still named in the environment therefore
 * lasts only until their next sign-in; the list is the bootstrap, and removing
 * them from it is part of revoking them for good.
 *
 * A deleted row's stored role is NOT a floor: deletion resets it (issue 1080;
 * see the sign-in upsert's case in src/lib/auth/account-store.ts), so a
 * deleted stored moderator resolves to MEMBER unless the configured floor
 * grants.
 */
export function resolveSignInRole(
  storedRole: UserRole | null,
  isConfiguredModerator: boolean,
  isDeleted = false,
): UserRole {
  if (isConfiguredModerator) {
    return "MODERATOR";
  }
  // The stored role floors against sign-in demotion for LIVE rows only,
  // mirroring the sign-in upsert's case in src/lib/auth/account-store.ts.
  if (!isDeleted && storedRole === "MODERATOR") {
    return "MODERATOR";
  }
  return "MEMBER";
}

/**
 * The configured moderator GitHub account ids.
 *
 * Ids, not logins: a GitHub login is mutable and reusable, so a login in the
 * environment can name a different person than the operator meant. The
 * numeric account id never changes hands. Find it with
 * `gh api users/<login> --jq .id`.
 *
 * Anything that is not a positive safe integer is ignored, so a login pasted
 * here by mistake can never match an account.
 *
 * Lives here rather than in auth.ts so that data-layer code can read it without
 * importing NextAuth: pulling `@/auth` into the moderation store dragged the
 * Next server runtime into a module the database tests import directly, and
 * they could no longer load.
 */
export function normalizeModeratorGitHubUserIds(value: string | undefined): Set<number> {
  const ids = new Set<number>();
  for (const entry of (value ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) {
      continue;
    }
    const id = Number(trimmed);
    if (Number.isSafeInteger(id)) {
      ids.add(id);
    }
  }
  return ids;
}
