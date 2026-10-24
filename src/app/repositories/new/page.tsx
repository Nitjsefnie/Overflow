import { AppShell } from "@/components/app-shell";
import { ApiTokenPanel } from "@/components/api-token-panel";
import { RepositoryForm } from "@/components/repository-form";
import { confirmSignInForApiToken, signInForRepositoryRegistration } from "@/lib/auth/sign-in-actions";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { registrationAppConfigured, registrationAppInstallUrl } from "@/lib/github/registration-app-display";
import { readEnv } from "@/lib/env";

export default async function NewRepositoryPage() {
  const session = await requireMemberPageSession();
  const tokenSummary = await new PostgresApiTokenStore().getTokenSummary(session.user.id);
  const appConfigured = registrationAppConfigured(process.env);
  return (
    <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
      <RepositoryForm
        registrationAppConfigured={appConfigured}
        registrationAppInstallUrl={appConfigured ? registrationAppInstallUrl(readEnv("GITHUB_REGISTRATION_APP_SLUG")) : null}
        canAdministerGitHubWebhooks={session.user.canAdministerWebhooks}
        reauthorizeAction={signInForRepositoryRegistration}
        appSignInAction={confirmSignInForApiToken}
      />
      <RepositoryForm variant="catalog-change" />
      <ApiTokenPanel
        reauthenticateAction={confirmSignInForApiToken}
        summary={tokenSummary
          ? {
            createdAt: tokenSummary.createdAt.toISOString(),
            expiresAt: tokenSummary.expiresAt.toISOString(),
            confirmedAt: tokenSummary.confirmedAt?.toISOString() ?? null,
            expired: tokenSummary.expired,
          }
          : null}
      />
    </AppShell>
  );
}
