import Link from "next/link";
import { PublicAppShell } from "@/components/app-shell";

export function TermsNotice() {
  return (
    <main className="page-content" id="main-content">
      <section className="page-heading" aria-labelledby="terms-title">
        <h1 id="terms-title">Terms</h1>
        <p>
          The terms of Overflow — the hosted instance at https://overflow.nitjsefni.eu — in short: what
          an account is, how work earns credits, how moderation works, and how to ask for a correction.
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
        <p>
          An account presupposes that you are old enough to hold one. Because sign-up is GitHub
          authentication and nothing else, that floor is GitHub&apos;s, not Overflow&apos;s: the{" "}
          <a href="https://docs.github.com/en/site-policy/github-terms/github-terms-of-service" rel="noreferrer">
            GitHub terms of service
          </a>{" "}
          require you to be age 13 or older — and to be older where your country&apos;s own minimum age
          is higher. Overflow sets no floor of its own and does not check one of its own — it relies
          on GitHub not issuing an account to someone below that floor.
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
      </section>

      <section className="surface" aria-labelledby="terms-disputes-heading">
        <h2 id="terms-disputes-heading">Contesting a sanction or a settlement</h2>
        <p>
          Ask for a correction. If a settlement is wrong — including when review rounds cost you credits
          through a maintainer&apos;s mistake — or a sanction is, you can ask for it to be corrected. The
          settlement&apos;s creditor or the sponsor can ask; a moderator decides. One open request per
          issue at a time.
        </p>
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
