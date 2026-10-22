import { AppShell } from "@/components/app-shell";
import { ClosedPrDisputeRequestForm } from "@/components/closed-pr-dispute-request";
import { ClosedPrDisputeList } from "@/components/closed-pr-dispute-list";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { ClosedPrDisputeService, type ClosedPrDisputeRequest } from "@/lib/moderation/closed-pr-dispute-service";
import { PostgresClosedPrDisputeStore } from "@/lib/moderation/closed-pr-dispute-store";

export function ClosedPrDisputesContent({ memberName, isModerator, requests }: {
  memberName: string; isModerator: boolean; requests: readonly ClosedPrDisputeRequest[] | null;
}) {
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="closed-pr-disputes-title">
        <p className="eyebrow">Recourse</p>
        <h1 id="closed-pr-disputes-title">Dispute a closed PR whose change landed elsewhere.</h1>
        <p>The stored author of a closed, unmerged PR can request credit when the change lands elsewhere. One open dispute per PR is allowed.</p>
        <p>A moderator decides. A sponsor, contributor or landing author cannot decide while another moderator exists; a sole-moderator decision is recorded.</p>
        <p>A grant uses a figure from 1 to 10, minus stored review rounds, floored at zero. Stored review evidence is required to grant it.</p>
      </section>
      <section className="surface" aria-labelledby="closed-pr-dispute-form-heading">
        <h2 id="closed-pr-dispute-form-heading">Request a closed PR dispute</h2>
        <ClosedPrDisputeRequestForm />
      </section>
      <section className="surface" aria-labelledby="closed-pr-dispute-history-heading">
        <h2 id="closed-pr-dispute-history-heading">Your closed PR disputes</h2>
        {requests === null ? <p role="alert">Your closed PR dispute history could not be loaded.</p> : <ClosedPrDisputeList requests={requests} />}
      </section>
    </AppShell>
  );
}

export default async function ClosedPrDisputesPage() {
  const session = await requireMemberPageSession();
  let requests: ClosedPrDisputeRequest[] | null = null;
  try {
    const service = new ClosedPrDisputeService(new PostgresClosedPrDisputeStore());
    requests = await service.listDisputes({ id: session.user.id });
  } catch {
    // A failed history read leaves filing available.
  }
  return <ClosedPrDisputesContent memberName={session.user.name} isModerator={isModeratorSession(session)} requests={requests} />;
}
