import { AppShell } from "@/components/app-shell";
import { SanctionContestRequestForm } from "@/components/sanction-contest-request";
import { SANCTION_CONTESTABLE_CASE, SANCTION_CONTEST_RULES } from "@/lib/disputes";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { PostgresSanctionContestStore } from "@/lib/moderation/sanction-contest-store";
import type {
  FileableSanction,
  SanctionContestRequest,
} from "@/lib/moderation/sanction-contest-service";

type SanctionContestsContentProps = {
  memberName: string;
  isModerator: boolean;
  sanctions: readonly FileableSanction[];
  requests: readonly SanctionContestRequest[] | null;
};

/**
 * The sanctioned person's filing route: the rules the account files under, the
 * filing form over its live sanctions, and its own request history with
 * outcomes. Session-gated to the signed-in account — the store reads only the
 * account the session names, so the page cannot show another account's
 * contests.
 */
export function SanctionContestsContent({
  memberName,
  isModerator,
  sanctions,
  requests,
}: SanctionContestsContentProps) {
  const openRequest = requests?.find(
    (request) =>
      request.state === "OPEN" && sanctions.some((sanction) => sanction.id === request.sanctionEventId),
  );
  const formAvailable = sanctions.length > 0 && openRequest === undefined;

  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="sanction-contests-title">
        <p className="eyebrow">Recourse</p>
        <h1 id="sanction-contests-title">Contest a sanction.</h1>
        <p>
          You can contest <span data-sanction-contest>{SANCTION_CONTESTABLE_CASE}</span> you are living under when
          you believe it is wrong: the sanctioned account asks, a moderator decides, and the answer is recorded
          as moderation history.
        </p>
      </section>

      <section className="surface rules-card" aria-labelledby="sanction-contest-rules-heading">
        <h2 id="sanction-contest-rules-heading">The sanction contest rules</h2>
        <ul className="rules-list" aria-label="The sanction contest rules">
          {SANCTION_CONTEST_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ul>
      </section>

      <section className="surface" aria-labelledby="sanction-contest-form-heading">
        <h2 id="sanction-contest-form-heading">Request a contest</h2>
        {sanctions.length === 0 ? (
          <p className="mono-meta">
            There is no live sanction on this account — nothing to contest. A contest targets the sanction
            you are under now, not one a reversal already lifted.
          </p>
        ) : formAvailable ? (
          <SanctionContestRequestForm sanctions={sanctions} />
        ) : (
          <p className="mono-meta">
            One open request at a time; this one is still with a moderator. A decided request allows a
            fresh one on the same sanction.
          </p>
        )}
      </section>

      <section className="surface" aria-labelledby="sanction-contest-history-heading">
        <h2 id="sanction-contest-history-heading">Your contest requests</h2>
        {requests === null ? (
          <p className="mono-meta">Your contest history could not be loaded.</p>
        ) : requests.length === 0 ? (
          <p className="mono-meta">You have not requested a contest.</p>
        ) : (
          <ol className="override-history" aria-label="Your contest requests">
            {requests.map((request) => (
              <li key={request.id}>
                <p className="override-state">{request.state === "OPEN" ? "Open — still with a moderator" : `Decided — ${request.decision}`}</p>
                <p>Filed {request.createdAt}: “{request.requestReason}”</p>
                {request.decidedReason === null ? null : (
                  <p className="mono-meta">
                    Decided {request.decidedAt ?? "at an unknown time"}: “{request.decidedReason}”
                    {request.decidedBySoleModerator ? " — by the only live moderator" : ""}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </AppShell>
  );
}

export default async function SanctionContestsPage() {
  const session = await requireMemberPageSession();
  const store = new PostgresSanctionContestStore();
  let sanctions: FileableSanction[] = [];
  let requests: SanctionContestRequest[] | null = null;
  try {
    sanctions = await store.listFileableSanctions(session.user.id);
    requests = await store.listRequestsForAccount(session.user.id);
  } catch {
    requests = null;
  }
  return (
    <SanctionContestsContent
      memberName={session.user.name}
      isModerator={isModeratorSession(session)}
      sanctions={sanctions}
      requests={requests}
    />
  );
}
