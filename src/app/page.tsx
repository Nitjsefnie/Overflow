import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PublicAppShell } from "@/components/app-shell";
import { signInAsContributor, signInForRepositoryRegistration } from "@/lib/auth/sign-in-actions";
import { registrationAppConfigured, registrationAppInstallUrl } from "@/lib/github/registration-app-display";
import type { RegistrationAppDisplayProps } from "@/components/registration-app-guidance";
import { readEnv } from "@/lib/env";
import { STARTING_CREDIT_LIMIT } from "@/lib/domain/credit-limit";
import { OVERFLOW_OPENING_CATALOG } from "@/lib/opening-catalog-examples";
import "./landing.css";

export const metadata: Metadata = {
  title: "Overflow — cooperative points",
};

export function LandingPage({ registrationAppConfigured = false, registrationAppInstallUrl = null }: RegistrationAppDisplayProps) {
  return (
    <main className="landing-page" id="main-content">
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="eyebrow">A cooperative ledger for open-source work</p>
        <h1 id="landing-title">Cooperative points for open-source work.</h1>
        <p className="landing-lede">
          Overflow records completed work, its proof, and points.
        </p>
        <p className="landing-trade">
          You start at 0 points; take an issue and earn its points when your pull request merges; spend points on issues you post, which stay on offer until you are {STARTING_CREDIT_LIMIT} points below zero.
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
      <section aria-labelledby="landing-examples-title">
        <h2 id="landing-examples-title">Examples of issue sizes</h2>
        <p>These examples use Overflow&apos;s own opening catalog; each repository chooses its own.</p>
        <p>While an issue is assigned to an outside contributor, its listed points are reserved from the sponsor&apos;s balance; on merge, the contributor earns the settled points minus one per distinct changes-requested review round, with a minimum of zero.</p>
        <div className="landing-principles landing-examples">
          {OVERFLOW_OPENING_CATALOG.map((entry) => (
            <article key={entry.label}>
              <h3>{entry.label}</h3>
              <p><strong>{entry.reservePoints}</strong> {entry.reservePoints === 1 ? "point" : "points"}</p>
              <p>{entry.example}</p>
            </article>
          ))}
        </div>
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
