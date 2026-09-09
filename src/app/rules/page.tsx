import { AppShell } from "@/components/app-shell";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";

type RulesContentProps = {
  memberName: string;
  isModerator: boolean;
};

export function RulesContent({ memberName, isModerator }: RulesContentProps) {
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="rules-title">
        <h1 id="rules-title">Rules</h1>
        <p>How work earns credits and how accounts are reviewed.</p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-maintainers-heading">
        <h2 id="rules-maintainers-heading">Maintainers</h2>
        <ul className="rules-list">
          <li>
            Have a claim system in place —{" "}
            <a href="https://github.com/Nitjsefnie-Actions/claim" rel="noreferrer">
              Nitjsefnie-Actions/claim
            </a>{" "}
            provides /claim, /unclaim and /release for any repository.
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
          <li>Credits earned before signing in wait until you claim your GitHub identity.</li>
        </ul>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-disputes-heading">
        <h2 id="rules-disputes-heading">Disputes</h2>
        <ul className="rules-list">
          <li>
            Ask for a correction if a settlement is wrong — including when review rounds cost you credits
            through a maintainer&apos;s mistake.
          </li>
          <li>The settlement&apos;s creditor or the sponsor can ask; a moderator decides.</li>
          <li>One open request per issue at a time.</li>
        </ul>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-moderation-heading">
        <h2 id="rules-moderation-heading">Moderation</h2>
        <p className="rules-formula">Audit → warn → recalibrate → ban</p>
        <ul className="rules-list">
          <li>Moderation applies to accounts, and every step requires supporting evidence.</li>
        </ul>
      </section>
    </AppShell>
  );
}

export default async function RulesPage() {
  const session = await requireMemberPageSession();
  return <RulesContent memberName={session.user.name} isModerator={isModeratorSession(session)} />;
}
