import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicAppShell } from "@/components/app-shell";
import { signInAsContributor, signInForRepositoryRegistration } from "@/lib/auth/sign-in-actions";
import { registrationAppConfigured, registrationAppInstallUrl } from "@/lib/github/registration-app-display";
import type { RegistrationAppDisplayProps } from "@/components/registration-app-guidance";
import { readEnv } from "@/lib/env";

export function LandingPage({ registrationAppConfigured = false, registrationAppInstallUrl = null }: RegistrationAppDisplayProps) {
  return (
    <main className="landing-page" id="main-content">
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="eyebrow">A cooperative ledger for open-source work</p>
        <h1 id="landing-title">Cooperative credit for open-source work.</h1>
        <p className="landing-lede">
          Overflow records completed contributions, visible proof, and the credit that moves between maintainers
          and contributors.
        </p>
        <form action={signInAsContributor}>
          <button className="action-button" type="submit">
            Sign in with GitHub
          </button>
        </form>
        <p className="landing-action-note">
          {registrationAppConfigured
            ? "Contributing asks GitHub for nothing beyond your public profile. Registering a repository through Overflow's webhook needs webhook administration on it, granted through a separate sign-in:"
            : "Contributing asks GitHub for nothing beyond your public profile. Registering a repository you administer needs webhook administration on it, granted through a separate sign-in:"}
        </p>
        <form action={signInForRepositoryRegistration}>
          <button className="quiet-button" type="submit">
            Sign in to register a repository
          </button>
        </form>
        {registrationAppConfigured ? <p className="landing-action-note">
          Or register without webhook administration: sign in with GitHub above,{" "}
          {registrationAppInstallUrl === null ? "install this instance's registration App"
            : <a href={registrationAppInstallUrl}>install this instance&apos;s registration App</a>}{" "}
          on the repository, and choose &quot;GitHub App&quot; on the registration form.
        </p> : null}
        <Link className="text-link" href="/account-data">
          What Overflow stores about your account
        </Link>
        <Link className="text-link" href="/terms">
          Terms
        </Link>
        <Link className="text-link" href="/rules">
          Rules
        </Link>
      </section>
      <section className="landing-principles" aria-label="How Overflow works">
        <article>
          <h2>Promises are explicit</h2>
          <p>Each repository chooses its own opening and actual catalog language.</p>
        </article>
        <article>
          <h2>Proof closes the loop</h2>
          <p>Linked GitHub issues and pull requests show why a settlement moved.</p>
        </article>
        <article>
          <h2>Calibration stays accountable</h2>
          <p>Samples compare self-work with outsider settlements without turning people into a retention metric.</p>
        </article>
      </section>
    </main>
  );
}

export default async function HomePage() {
  const appConfigured = registrationAppConfigured(process.env);
  const { auth } = await import("@/auth");
  const session = await auth();
  const user = session?.user as { id?: unknown; role?: unknown } | undefined;
  if (typeof user?.id === "string" && (user.role === "MEMBER" || user.role === "MODERATOR")) {
    redirect("/dashboard");
  }
  return (
    <PublicAppShell>
      <LandingPage registrationAppConfigured={appConfigured}
        registrationAppInstallUrl={appConfigured ? registrationAppInstallUrl(readEnv("GITHUB_REGISTRATION_APP_SLUG")) : null} />
    </PublicAppShell>
  );
}
