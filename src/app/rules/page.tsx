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
        <p className="eyebrow">How the ledger decides</p>
        <h1 id="rules-title">The rules you are scored by.</h1>
        <p>
          Every number on your dashboard comes from the rules below. Nothing here is discretionary: the ledger
          reads GitHub and applies them the same way every time.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-opening-heading">
        <p className="eyebrow">Before the work starts</p>
        <h2 id="rules-opening-heading">What work is worth before it starts</h2>
        <p>
          Each repository names its own opening catalog. The labels are the repository&apos;s to choose; the points
          from 1 through 10 are the shared scale everything settles against.
        </p>
        <p>
          Opening difficulty is the earliest opening label the issue owner applied <strong>before the first
          assignment</strong>. Pricing the work has to happen before it is spoken for, so a label applied after
          someone has already taken the issue cannot set its price.
        </p>
        <p>
          Reserve points on an open issue assigned to an outside contributor are held against the sponsor&apos;s
          balance. Available headroom is settled balance minus those reservations, and it is allowed to go
          negative.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-settlement-heading">
        <p className="eyebrow">Closing the loop</p>
        <h2 id="rules-settlement-heading">What makes work settle</h2>
        <p>Work settles only when all of this is true, and every part of it comes from GitHub:</p>
        <ol className="rules-list">
          <li>
            The issue was closed by a merged pull request that GitHub reports through
            <code> closedByPullRequestsReferences</code>. No other link counts.
          </li>
          <li>
            The issue owner applied exactly one actual-catalog label,
            <strong> between the closing pull request&apos;s final commit and its merge</strong>. Two such labels
            active at once settle nothing.
          </li>
          <li>
            The issue owner left a comment in that same window whose text <strong>names that label</strong>. A
            blank comment, or one that does not name it, does not count.
          </li>
        </ol>
        <p>
          <strong>Pull request labels never price work.</strong> Only labels on the issue, applied by its owner,
          decide anything.
        </p>
        <p>
          Those orderings are checked with a tolerance of <strong>fifteen minutes</strong>, because they are a
          sequence people perform by hand and the order things land in is routinely off by a little. Evidence
          outside that tolerance is still rejected.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-credits-heading">
        <p className="eyebrow">What you earn</p>
        <h2 id="rules-credits-heading">How credits are calculated</h2>
        <p className="rules-formula">credits = max(0, actual points − distinct review rounds)</p>
        <p>
          Each distinct round of review on the closing pull request subtracts one point. Credits never go below
          zero, so heavy review costs you the credit for the work but never puts you in debt for it.
        </p>
        <p>
          There is no churn metric and no activity measure. Nothing you do outside a settled issue changes your
          balance.
        </p>
        <p>
          Work you complete in a repository you sponsor is <strong>self-work</strong>. It is recorded as
          calibration evidence and <strong>creates no ledger entry</strong> — you cannot pay yourself.
        </p>
        <p>
          If the contributor has not signed in yet, the settlement is held as unclaimed until someone claims that
          GitHub identity.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="rules-moderation-heading">
        <p className="eyebrow">When something is wrong</p>
        <h2 id="rules-moderation-heading">Moderation</h2>
        <p className="rules-formula">audit → warn → recalibrate → ban</p>
        <p>
          Moderation is account-level and evidence-led. An audit compares paired samples of your self-work against
          your outsider settlements, and may only be opened when those paired samples exist.
        </p>
        <p>
          A warning is issued only when the record supports it. Recalibration is required before an account is
          reactivated. A ban follows only after confirmed patterns persist.
        </p>
        <p>
          Calibration compares those paired samples. It does not measure how active you are, and being quiet is
          not evidence of anything.
        </p>
      </section>
    </AppShell>
  );
}

export default async function RulesPage() {
  const session = await requireMemberPageSession();
  return <RulesContent memberName={session.user.name} isModerator={isModeratorSession(session)} />;
}
