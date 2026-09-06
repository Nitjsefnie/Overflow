import { SettlementOverrideRequestForm } from "@/components/settlement-override-request";
import type { SettlementOverrideRequest, SettlementOverrideTarget } from "@/lib/overrides/service";

type SettlementCorrectionsProps = {
  target: SettlementOverrideTarget;
  requests: readonly SettlementOverrideRequest[];
};

/**
 * What a member can do about a priced outcome they believe is wrong, and what
 * has already been done about it.
 *
 * The form is withheld while a request is open, because the ledger holds one
 * open request per issue; the reason is stated rather than the button being
 * silently absent.
 *
 * A settlement and a self-work calibration are corrected through the same
 * request, but they are not the same thing to the member reading this: a
 * settlement's corrected figure moves credits between two accounts, while a
 * calibration's moves nothing but the sponsor's own comparison. Saying credits
 * are recomputed on a calibration page would promise a payment that cannot
 * happen, so each kind gets its own sentence.
 */
export function SettlementCorrections({ target, requests }: SettlementCorrectionsProps) {
  const open = requests.find((request) => request.state === "OPEN");
  const settlement = target.kind === "settlement";
  const outcome = settlement ? "settlement" : "calibration";

  return (
    <section className="surface override-card" aria-labelledby="settlement-corrections-heading">
      <p className="eyebrow">Recourse</p>
      <h2 id="settlement-corrections-heading">Is this {outcome} wrong?</h2>
      {settlement ? (
        <p>
          A settlement is rebuilt from GitHub history on every reconciliation, so re-running it changes nothing.
          A moderator can record a corrected settled figure instead; credits are recomputed from it and the
          review rounds already counted.
        </p>
      ) : (
        <p>
          A calibration is rebuilt from GitHub history on every reconciliation, so re-running it changes nothing.
          A moderator can record a corrected actual figure instead; no credits move, because you closed your own
          issue, and the corrected figure is what your calibration comparison is drawn from.
        </p>
      )}
      {requests.length === 0 ? (
        <p className="mono-meta">No correction has been requested for this {outcome}.</p>
      ) : (
        <ol className="override-history">
          {requests.map((request) => (
            <li key={request.id}>
              <p className="override-state">{stateSummary(request, settlement)}</p>
              <p>Reported {request.createdAt}: “{request.reason}”</p>
              {request.decisionReason === null ? null : (
                <p className="mono-meta">
                  Decided {request.decidedAt ?? "unknown"}: “{request.decisionReason}”
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
      {open === undefined ? (
        <SettlementOverrideRequestForm target={target} />
      ) : (
        <p className="mono-meta">One correction request at a time; this one is still with a moderator.</p>
      )}
    </section>
  );
}

/**
 * A decided request in one line.
 *
 * The granted figure is stored as `settledPoints` whichever outcome it corrects,
 * but a calibration has no settled points to speak of — the fold applies the
 * figure as that calibration's actual points, so that is what it is called here.
 */
function stateSummary(request: SettlementOverrideRequest, settlement: boolean): string {
  switch (request.state) {
    case "OPEN":
      return "Awaiting a moderator";
    case "GRANTED":
      return `Granted at ${request.settledPoints ?? "unknown"} ${settlement ? "settled" : "actual"} points`;
    case "DECLINED":
      return "Declined";
  }
}
