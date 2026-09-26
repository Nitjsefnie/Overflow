"use server";

import { GITHUB_CONTRIBUTOR_SCOPE } from "@/lib/auth/github-oauth-scopes";
import { assertTrustedServerActionOrigin } from "@/lib/security/server-action-origin";

/** Reconfirm GitHub identity before the member deletes their account. */
export async function confirmSignInForAccountDeletion(): Promise<void> {
  await assertTrustedServerActionOrigin();
  const { signIn } = await import("@/auth");
  await signIn("github", { redirectTo: "/dashboard" }, { scope: GITHUB_CONTRIBUTOR_SCOPE });
}
