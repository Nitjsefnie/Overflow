"use server";

import { assertTrustedServerActionOrigin } from "@/lib/security/server-action-origin";

export async function signOutAction(): Promise<void> {
  await assertTrustedServerActionOrigin();
  const { signOut } = await import("@/auth");
  await signOut({ redirectTo: "/" });
}
