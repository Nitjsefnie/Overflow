import Link from "next/link";
import { PublicAppShell } from "@/components/app-shell";
import { HOSTED_INSTANCE_ORIGIN, readControllerIdentity } from "@/lib/controller-config";
import { DISPUTE_CONTESTABLE_CASE, DISPUTE_RULES } from "@/lib/disputes";
import { TERMS_REVISION } from "@/lib/legal-revisions";
import { SANCTION_EFFECT_RULES } from "@/lib/sanctions";

export function TermsNotice() {
  const identity = readControllerIdentity();
  return (
    <main className="page-content" id="main-content">
      <section className="page-heading" aria-labelledby="terms-title">
        <h1 id="terms-title">Terms</h1>
        <p
          className="mono-meta"
          data-legal-revision={TERMS_REVISION.document}
          data-version={TERMS_REVISION.version}
          data-effective-date={TERMS_REVISION.effectiveDate}
        >
          These terms are version {TERMS_REVISION.version}, in effect from {TERMS_REVISION.effectiveDate}.
          Contesting{" "}
          <span data-dispute-case>{DISPUTE_CONTESTABLE_CASE}</span> cites that date — it is what
          fixes the text you are held to.
        </p>
        <p className={identity.isHosted ? undefined : "self-hosted-statement"}>
          {identity.isHosted ? (
            <>
              The terms of Overflow — the hosted instance at {HOSTED_INSTANCE_ORIGIN} — in short:
              what an account is, how work earns credits, how moderation works, and how to ask for a
              correction.{" "}
            </>
          ) : (
            <>
              These terms serve this deployment of Overflow
              {identity.name !== null && <>, operated by {identity.name}</>}, a self-hosted copy —
              not the hosted instance at {HOSTED_INSTANCE_ORIGIN}. The terms in short: what an
              account is, how work earns credits, how moderation works, and how to ask for a
              correction.{" "}
            </>
          )}
          The full rules are on the <Link href="/rules">rules page</Link>.
        </p>
      </section>

      <section className="surface" aria-labelledby="terms-account-heading">
        <h2 id="terms-account-heading">What an account is</h2>
        <p>
          Your account is created on your first sign-in with GitHub, and it is one account per person —
          the shared ledger attributes work to it by your GitHub identity. What Overflow stores about your
          account is described on the <Link href="/account-data">account data page</Link>.
        </p>
        <p className="account-age-floor">
          An account presupposes that you are old enough to hold one. Because sign-up is GitHub
          authentication and nothing else, that floor is GitHub&apos;s, not Overflow&apos;s: the{" "}
          <a href="https://docs.github.com/en/site-policy/github-terms/github-terms-of-service" rel="noreferrer">
            GitHub terms of service
          </a>{" "}
          require you to be age 13 or older. Where your country sets a minimum age higher than 13, it
          is on you to meet it: GitHub&apos;s terms leave you responsible for complying with your own
          country&apos;s laws. Overflow sets no floor of its own and does not check one of its own —
          it relies on GitHub not issuing an account to someone below that floor.
        </p>
      </section>

      <section className="surface" aria-labelledby="terms-scoring-heading">
        <h2 id="terms-scoring-heading">How scoring works</h2>
        <p>
          An issue carries its opening price from the day it is filed — the <code>offered:</code> label
          its owner sets. When a merged pull request closes the issue, it settles at the{" "}
          <code>settled:</code> label the work finally earned.
        </p>
        <p>
          Credits for a settlement are the final difficulty points minus the distinct review rounds it
          took, with a minimum of 0. Work in a repository you sponsor does not change balances. Credits
          earned before you sign in wait until you claim your GitHub identity — every one of them.
        </p>
      </section>

      <section className="surface" aria-labelledby="terms-sanctions-heading">
        <h2 id="terms-sanctions-heading">How sanctions work</h2>
        <p>
          Moderation applies to accounts. The ladder is audit → warn → recalibrate → ban, and every step
          requires supporting evidence. How people treat each other in the project&apos;s spaces is the
          subject of the{" "}
          <a href="https://github.com/Nitjsefnie/Overflow/blob/main/CODE_OF_CONDUCT.md" rel="noreferrer">
            Code of Conduct
          </a>
          .
        </p>
        <ul className="rules-list">
          {SANCTION_EFFECT_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p>
          A sanction can be contested: the <Link href="/rules">Disputes section of the rules page</Link>{" "}
          is the source of truth for how, and the sanctioned account asks on the{" "}
          <Link href="/contests">contest page</Link>.
        </p>
      </section>

      <section className="surface" aria-labelledby="terms-disputes-heading">
        <h2 id="terms-disputes-heading">Contesting a settlement</h2>
        <ul className="rules-list">
          {DISPUTE_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
        <p>
          The <Link href="/rules">Disputes section of the rules page</Link> is the source of truth for how
          correction requests work.
        </p>
      </section>
    </main>
  );
}

export default function TermsPage() {
  return (
    <PublicAppShell>
      <TermsNotice />
    </PublicAppShell>
  );
}
