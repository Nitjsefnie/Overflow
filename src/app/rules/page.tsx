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

      <section className="surface rules-card" aria-labelledby="rules-opening-heading">
        <h2 id="rules-opening-heading">Before work starts</h2>
        <p>
          Repositories choose their own difficulty labels, worth 1–10 points. The issue owner&apos;s earliest
          starting-difficulty label before the first assignment sets the opening estimate.
        </p>
        <p>
          Open issues assigned to outside contributors reserve points from the sponsor&apos;s balance. Your
          available balance is your settled balance minus these reservations; it can be negative.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-settlement-heading">
        <h2 id="rules-settlement-heading">When work counts</h2>
        <ol className="rules-list">
          <li>A merged pull request must close the issue in GitHub. A link alone does not count.</li>
          <li>
            Between the pull request&apos;s final commit and merge, the issue owner must apply exactly one
            final-difficulty label to the issue and leave a comment naming it.
          </li>
          <li>Only issue labels count; pull request labels do not. A 15-minute tolerance applies to timing.</li>
        </ol>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-credits-heading">
        <h2 id="rules-credits-heading">Credits</h2>
        <p className="rules-formula">Credits = final difficulty points − distinct review rounds, with a minimum of 0.</p>
        <p>
          Work in a repository you sponsor earns no credits; it is calibration evidence that helps check that
          difficulty ratings are consistent.
        </p>
        <p>
          Credits earned before signing in remain unclaimed until the contributor claims their GitHub identity.
        </p>
        <p>Activity and inactivity do not affect your score.</p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-moderation-heading">
        <h2 id="rules-moderation-heading">Moderation</h2>
        <p className="rules-formula">Audit → warn → recalibrate → ban</p>
        <p>
          Moderation applies to accounts. An audit requires examples comparing work you completed in your
          sponsored repositories with work completed there by outside contributors. Warnings require supporting
          evidence. A nonblank recalibration plan to correct difficulty ratings is required before an account is
          reactivated. Bans require confirmed problems that continue.
        </p>
      </section>
    </AppShell>
  );
}

export default async function RulesPage() {
  const session = await requireMemberPageSession();
  return <RulesContent memberName={session.user.name} isModerator={isModeratorSession(session)} />;
}
