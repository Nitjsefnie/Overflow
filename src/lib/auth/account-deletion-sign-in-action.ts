"use server";

import { GITHUB_CONTRIBUTOR_SCOPE } from "@/lib/auth/github-oauth-scopes";

/** Reconfirm GitHub identity before the member deletes their account. */
export async function confirmSignInForAccountDeletion(): Promise<void> {
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/dashboard" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
}
