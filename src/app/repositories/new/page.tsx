import { AppShell } from "@/components/app-shell";
import { ApiTokenPanel } from "@/components/api-token-panel";
import { RepositoryForm } from "@/components/repository-form";
import { signInForRepositoryRegistration } from "@/lib/auth/sign-in-actions";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export default async function NewRepositoryPage() {
  const session = await requireMemberPageSession();
  const tokenSummary = await new PostgresApiTokenStore().getTokenSummary(session.user.id);
  return (
    <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
      <RepositoryForm
        canAdministerGitHubWebhooks={session.user.canAdministerWebhooks}
        reauthorizeAction={signInForRepositoryRegistration}
      />
      <RepositoryForm variant="catalog-change" />
      <ApiTokenPanel summary={tokenSummary ? { createdAt: tokenSummary.createdAt.toISOString() } : null} />
    </AppShell>
  );
}
