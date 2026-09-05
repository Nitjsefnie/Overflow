import { redirect } from "next/navigation";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";

export type MemberPageSession = {
  user: {
    id: string;
    role: UserRole;
    name: string;
  };
};

export async function requireMemberPageSession(): Promise<MemberPageSession> {
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; name?: unknown; email?: unknown } | undefined;
  if (typeof user?.id !== "string") {
    redirect("/");
  }

  // Not the landing page: it sends any session carrying an id and a member role
  // straight back to /dashboard, so bouncing there on a JWT the ledger cannot
  // vouch for produces an endless /dashboard -> / -> /dashboard loop. /session
  // is terminal and carries the sign-out that clears the JWT.
  let currentRole: UserRole | null;
  try {
    currentRole = await getCurrentUserRole(user.id);
  } catch {
    redirect("/session?reason=unavailable");
  }
  if (currentRole === null) {
    redirect("/session?reason=stale");
  }

  return {
    user: {
      id: user.id,
      role: currentRole,
      name: displayName(user.name, user.email),
    },
  };
}

export function isModeratorSession(session: MemberPageSession): boolean {
  return session.user.role === "MODERATOR";
}

function displayName(name: unknown, email: unknown): string {
  if (typeof name === "string" && name.trim().length > 0) {
    return name;
  }
  if (typeof email === "string" && email.trim().length > 0) {
    return email;
  }
  return "Member";
}
