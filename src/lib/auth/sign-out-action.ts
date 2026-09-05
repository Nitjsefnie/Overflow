"use server";

export async function signOutAction(): Promise<void> {
  const { signOut } = await import("@/auth");
  await signOut({ redirectTo: "/" });
}
