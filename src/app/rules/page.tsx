import Link from "next/link";
import { AppShell, PublicAppShell } from "@/components/app-shell";
import { DISPUTE_CONTESTABLE_CASE, DISPUTE_RULES, SANCTION_CONTEST_RULES } from "@/lib/disputes";
import { RULES_REVISION } from "@/lib/legal-revisions";
import { SANCTION_EFFECT_RULES } from "@/lib/sanctions";

type RulesContentProps = {
  memberName: string;
  isModerator: boolean;
};

export function RulesContent({ memberName, isModerator }: RulesContentProps) {
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <RulesSections />
    </AppShell>
  );
}

/**
 * The rules for a visitor with no session. PublicAppShell supplies no main of
 * its own, so this renders the main.page-content the skip link targets, the
 * way the account-data notice does.
 */
export function PublicRulesContent() {
  return (
    <PublicAppShell>
      <main className="page-content" id="main-content">
        <RulesSections />
      </main>
    </PublicAppShell>
  );
}

function RulesSections() {
  return (
    <>
      <section className="page-heading" aria-labelledby="rules-title">
        <h1 id="rules-title">Rules</h1>
        <p
          className="mono-meta"
          data-legal-revision={RULES_REVISION.document}
          data-version={RULES_REVISION.version}
          data-effective-date={RULES_REVISION.effectiveDate}
        >
          These rules are version {RULES_REVISION.version}, in effect from{" "}
          {RULES_REVISION.effectiveDate}. A correction to{" "}
          <span data-dispute-case>{DISPUTE_CONTESTABLE_CASE}</span> is decided under the Disputes
          section of this page, and cites that date — it is what fixes the text you are held to.
        </p>
        <p>How work earns credits and how accounts are reviewed.</p>
        <p>
          The <Link href="/terms">terms page</Link> is the short version, with the hosted
          instance&apos;s terms.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-maintainers-heading">
        <h2 id="rules-maintainers-heading">Maintainers</h2>
        <ul className="rules-list">
          <li>
            Have a claim system in place — build your own, or use{" "}
            <a href="https://github.com/Nitjsefnie-Actions/claim" rel="noreferrer">
              Nitjsefnie-Actions/claim
            </a>
            , which provides /claim, /unclaim and /release for any repository.
          </li>
          <li>Apply the label and rationale comment within 15 minutes of merge.</li>
        </ul>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-contributors-heading">
        <h2 id="rules-contributors-heading">Contributors</h2>
        <ul className="rules-list">
          <li>Claim your issue.</li>
          <li>Follow the repository&apos;s own rules — read its README, CONTRIBUTING and issue templates.</li>
          <li>Send a pull request with &quot;Fixes #N&quot;.</li>
        </ul>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-credits-heading">
        <h2 id="rules-credits-heading">Credits</h2>
        <p className="rules-formula">Credits = final difficulty points − distinct review rounds, with a minimum of 0.</p>
        <ul className="rules-list">
          <li>Review rounds are changes-requested reviews, counted as they stood at merge.</li>
          <li>Work in a repository you sponsor does not change balances.</li>
          <li>Open issues assigned to outside contributors reserve points from your balance.</li>
          <li>Available headroom is your settled balance minus those reservations; it can be negative.</li>
          <li>Credits earned before signing in wait until you claim your GitHub identity.</li>
        </ul>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-disputes-heading">
        <h2 id="rules-disputes-heading">Disputes</h2>
        <ul className="rules-list">
          {DISPUTE_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <h3>Contesting a sanction</h3>
        <ul className="rules-list">
          {SANCTION_CONTEST_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p>
          The sanctioned account asks on the <Link href="/contests">contest page</Link>.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-moderation-heading">
        <h2 id="rules-moderation-heading">Moderation</h2>
        <p className="rules-formula">Audit → warn → recalibrate → ban</p>
        <ul className="rules-list">
          <li>Moderation applies to accounts, and every step requires supporting evidence.</li>
          {SANCTION_EFFECT_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default async function RulesPage() {
  const { auth } = await import("@/auth");
  // Resolve the ledger lookup at call time, like @/auth above: the suite runs
  // with `isolate: false`, and a static import here freezes to the real module
  // when another test file (legal-revisions-marker) renders this page first in
  // the shared worker — the member-view flake of issues 953 and 964.
  const { getCurrentUserRole } = await import("@/lib/moderation/current-role");
  const session = await auth();
  const user = session?.user as { id?: unknown; name?: unknown } | undefined;
  // The rendered chrome follows the ledger's current role, not the JWT's role
  // claim: the claim freezes whatever the session carried at sign-in, so a
  // demoted moderator's live session would keep showing the Moderation link
  // (issue 810). A null role (account gone or pseudonymised) or a failed
  // lookup falls back to the public view rather than crashing the page.
  if (typeof user?.id === "string") {
    const currentRole = await getCurrentUserRole(user.id).catch(() => null);
    if (currentRole !== null) {
      return (
        <RulesContent
          memberName={displayName(user.name)}
          isModerator={currentRole === "MODERATOR"}
        />
      );
    }
  }
  return <PublicRulesContent />;
}

function displayName(name: unknown): string {
  if (typeof name === "string" && name.trim().length > 0) {
    return name;
  }
  return "Member";
}
