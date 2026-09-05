import { AppShell } from "@/components/app-shell";
import { ApiTokenPanel } from "@/components/api-token-panel";
import { RepositoryForm } from "@/components/repository-form";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export default async function NewRepositoryPage() {
  const session = await requireMemberPageSession();
  const tokenSummary = await new PostgresApiTokenStore().getTokenSummary(session.user.id);
  return (
    <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
      <RepositoryForm />
      <ApiTokenPanel summary={tokenSummary ? { createdAt: tokenSummary.createdAt.toISOString() } : null} />
    </AppShell>
  );
}
