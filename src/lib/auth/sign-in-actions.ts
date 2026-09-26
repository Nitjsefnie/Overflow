"use server";

import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
} from "@/lib/auth/github-oauth-scopes";

/**
 * The GitHub sign-ins (issue 599). Each names its scope per call, which
 * overrides the provider default; the provider default is itself the
 * contributor's empty scope, so an unlabelled `signIn("github")` anywhere
 * else stays least-privilege.
 */

/** Public identity only; lands on the member destination. */
export async function signInAsContributor(): Promise<void> {
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/dashboard" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
}

/**
 * Webhook administration for repository registration; lands on the
 * registration page. Also the widening step a signed-in contributor takes
 * from that page: GitHub sends an already-authorized account straight back
 * with the union of scopes, so the same account continues after callback.
 */
export async function signInForRepositoryRegistration(): Promise<void> {
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/repositories/new" }, { scope: GITHUB_REPOSITORY_REGISTRATION_SCOPE });
}

/**
 * Re-confirms a signed-in member's identity so the session may mint an API
 * token (src/app/api/tokens/route.ts), without requesting any scope; lands
 * back on the registration page that holds the token panel. GitHub returns an
 * already-authorized account with the union of the scopes it granted, so a
 * member who already granted webhook administration keeps it.
 */
export async function confirmSignInForApiToken(): Promise<void> {
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/repositories/new" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
}
