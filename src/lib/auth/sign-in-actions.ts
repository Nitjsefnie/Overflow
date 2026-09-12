"use server";

import {
  GITHUB_CONTRIBUTOR_SCOPE,
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
} from "@/lib/auth/github-oauth-scopes";

/**
 * The two GitHub sign-ins (issue 599). Each names its scope per call, which
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
