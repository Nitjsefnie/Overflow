import { AppShell } from "@/components/app-shell";
import { RepositoryForm } from "@/components/repository-form";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

export default async function NewRepositoryPage() {
  const session = await requireMemberPageSession();
  return (
    <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
      <RepositoryForm />
    </AppShell>
  );
}
