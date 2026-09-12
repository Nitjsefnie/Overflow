import { AppShell } from "@/components/app-shell";
import { ApiTokenPanel } from "@/components/api-token-panel";
import { RepositoryForm } from "@/components/repository-form";
import { signInForRepositoryRegistration } from "@/lib/auth/sign-in-actions";
import { GITHUB_REPOSITORY_REGISTRATION_SCOPE } from "@/lib/auth/github-oauth-scopes";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

export default async function NewRepositoryPage() {
  const session = await requireMemberPageSession();
  const tokenSummary = await new PostgresApiTokenStore().getTokenSummary(session.user.id);
  return (
    <AppShell memberName={session.user.name} isModerator={isModeratorSession(session)}>
      {session.user.canAdministerWebhooks ? (
        <RepositoryForm />
      ) : (
        <WebhookAdministrationRequired />
      )}
      <RepositoryForm variant="catalog-change" />
      <ApiTokenPanel summary={tokenSummary ? { createdAt: tokenSummary.createdAt.toISOString() } : null} />
    </AppShell>
  );
}

/**
 * What a contributor sees in place of the registration form (issue 599): the
 * sign-in they used granted no repository permission, and registration needs
 * webhook administration on the repository. The action sends them through
 * GitHub authorization again for that one scope and returns here; GitHub
 * keeps the same account and adds the grant to what it already holds.
 */
function WebhookAdministrationRequired() {
  return (
    <section className="surface shadow-offset" aria-labelledby="webhook-administration-required-heading">
      <div className="form-intro">
        <p className="eyebrow">Explicit registration</p>
        <h1 id="webhook-administration-required-heading">Webhook administration required</h1>
        <p>
          Registering a repository creates Overflow&apos;s webhook on it, which needs the GitHub{" "}
          <code>{GITHUB_REPOSITORY_REGISTRATION_SCOPE}</code> permission. Your sign-in granted Overflow nothing
          beyond your public profile, which is all contributing needs. Authorize webhook administration with the
          same GitHub account to register a repository you administer; you return to this page afterwards.
        </p>
      </div>
      <form action={signInForRepositoryRegistration}>
        <button className="action-button" type="submit">
          Authorize webhook administration on GitHub
        </button>
      </form>
    </section>
  );
}
