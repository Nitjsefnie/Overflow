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
          Claim an issue before work begins by commenting /claim on the open, unassigned issue. The comment
          body must be exactly /claim; a sentence containing the command is not a claim. Read the reply on
          the issue and confirm that you are assigned before starting work.
        </p>
        <p>
          GitHub will not accept an assignee who has not interacted with the repository, so nobody can assign
          you in advance; the claim comment makes your account assignable. For contributors without write
          access, that comment is the only self-service claiming route; someone with write access can
          assign you after you have commented.
        </p>
        <p>
          The command is provided by a workflow each repository ships, not by Overflow. Self-service claiming
          works only where the repository provides the command; a repository without it has no self-service
          claiming route.
        </p>
        <p>
          A claim creates the assignment used for the sponsor&apos;s point reservation described below.
          /unclaim and /release are two names for the same command; comment either one on an open issue to
          remove only your own assignment. Release an issue you stop working on before the merge that would
          close it; while you hold it, nobody else can claim it.
        </p>
        <p>
          Repositories choose their own difficulty labels, worth 1–10 points. The repository sponsor&apos;s
          earliest starting-difficulty label before the first assignment sets the opening estimate. Only the
          sponsor prices work: labels and comments from anyone else, including the person who filed the issue,
          never set a price.
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
            Exactly one final-difficulty label must be active on the issue when the window closes. Its standing
            application must be by the repository sponsor between the pull request&apos;s final commit and merge.
            The sponsor must leave a nonblank comment naming it. A comment edited after the window closes does
            not count.
          </li>
          <li>
            Only issue labels count; pull request labels do not. A 15-minute tolerance applies to label and
            comment timing; the settlement window closes 15 minutes after merge.
          </li>
          <li>
            The earliest qualifying comment at or after the standing label is used, including when a label is
            reapplied. If none exists, a comment up to 15 minutes before that label can count.
          </li>
        </ol>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-credits-heading">
        <h2 id="rules-credits-heading">Credits</h2>
        <p className="rules-formula">Credits = final difficulty points − distinct review rounds, with a minimum of 0.</p>
        <p>
          Review rounds are distinct changes-requested reviews submitted before merge, counted as they stood
          when the pull request merged. A review dismissed after the merge still counts; one dismissed before
          the merge does not. A dismissal exactly at merge also leaves the round counted. No timing tolerance
          applies to reviews. A dismissed review counts only if its dismissal history establishes that it
          requested changes; missing history or an unknown previous state does not count.
        </p>
        <p>
          Work you complete in a repository you sponsor does not change balances; it helps check that difficulty
          ratings are consistent.
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
