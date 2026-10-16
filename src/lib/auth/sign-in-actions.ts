"use server";

import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
} from "@/lib/auth/github-oauth-scopes";
import { assertTrustedServerActionOrigin } from "@/lib/security/server-action-origin";

/**
 * The GitHub sign-ins (issue 599). Each names its scope per call, which
 * overrides the provider default; the provider default is itself the
 * contributor's empty scope, so an unlabelled `signIn("github")` anywhere
 * else stays least-privilege.
 */

/** Public identity only; lands on the member destination. */
export async function signInAsContributor(): Promise<void> {
  await assertTrustedServerActionOrigin();
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/dashboard" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
}

/**
 * Webhook administration for repository registration; lands on the
 * registration page. Also the widening step a signed-in contributor takes
 * from that page: GitHub sends an already-authorized account straight back
 * without a consent screen, carrying only the scopes this sign-in requested.
 * A narrower stored token survives that replacement through the storage
 * path's continuity ruling (src/auth.ts), not through any scope union.
 */
export async function signInForRepositoryRegistration(): Promise<void> {
  await assertTrustedServerActionOrigin();
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/repositories/new" }, { scope: GITHUB_REPOSITORY_REGISTRATION_SCOPE });
}

/**
 * Public-identity sign-in for GitHub App repository registration, also used
 * to re-confirm a member before minting an API token (src/app/api/tokens/route.ts).
 * Both request no scope and return to the registration page with the token panel.
 * GitHub issues the
 * new authorization with only the scopes this sign-in requested — none — so
 * webhook administration a member granted earlier survives only through the
 * storage path's continuity ruling (src/auth.ts).
 */
export async function confirmSignInForApiToken(): Promise<void> {
  await assertTrustedServerActionOrigin();
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/repositories/new" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
}
