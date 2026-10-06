"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { FileableSanction } from "@/lib/moderation/sanction-contest-service";
import { MAX_REASON_LENGTH } from "@/lib/validation/reason";

type Feedback = { kind: "error" | "success"; message: string } | null;

type SanctionContestRequestFormProps = {
  sanctions: readonly FileableSanction[];
};

type ContestResponse = {
  error?: { message?: string };
};

/**
 * The sanction side of the disputes framework's filing form: the account picks
 * one of its live sanctions and says why it should be contested.
 *
 * With no live sanction there is nothing to name, so the caller renders the
 * page's explanation instead of this form. The one-open-per-sanction rule is
 * the database's (migration 061's partial unique index), so any withholding in
 * the page around this form is presentation, not enforcement.
 */
export function SanctionContestRequestForm({ sanctions }: SanctionContestRequestFormProps) {
  const router = useRouter();
  const [sanctionEventId, setSanctionEventId] = useState<string>(sanctions[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  // The server owns the fileable list: the refresh after a filing, a decision
  // or a reversal can swap the props under this form. A selection the new
  // list no longer carries would submit a stale event id (or sit blank), so
  // the selection follows the list whenever the entry it holds leaves it.
  useEffect(() => {
    if (!sanctions.some((sanction) => sanction.id === sanctionEventId)) {
      setSanctionEventId(sanctions[0]?.id ?? "");
    }
  }, [sanctions, sanctionEventId]);

  async function fileContest() {
    const trimmedReason = reason.trim();
    setFeedback(null);
    if (sanctionEventId.length === 0) {
      setFeedback({ kind: "error", message: "Pick the sanction you are contesting." });
      return;
    }
    if (trimmedReason.length === 0) {
      setFeedback({ kind: "error", message: "Say why this sanction should be contested." });
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/contests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ sanctionEventId, reason: trimmedReason }),
      });
      const body = (await response.json().catch(() => null)) as ContestResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The filing could not be recorded. Try again.",
        });
        return;
      }
      setFeedback({ kind: "success", message: "A moderator will review this contest." });
      router.refresh();
      setReason("");
    } catch {
      setFeedback({
        kind: "error",
        message: "The filing could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="override-request">
      <label className="field" htmlFor="sanction-contest-sanction">
        <span>Which sanction?</span>
        <select
          id="sanction-contest-sanction"
          name="sanctionEventId"
          value={sanctionEventId}
          onChange={(event) => setSanctionEventId(event.target.value)}
          className="field-input"
        >
          {sanctions.map((sanction) => (
            <option key={sanction.id} value={sanction.id}>
              {sanction.newState} · {sanction.occurredAt.slice(0, 10)} · {sanction.reason}
            </option>
          ))}
        </select>
      </label>
      <label className="field" htmlFor="sanction-contest-reason">
        <span>Why should this sanction be contested?</span>
        <textarea
          id="sanction-contest-reason"
          name="reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={MAX_REASON_LENGTH}
          required
        />
      </label>
      <button
        className="action-button"
        type="button"
        disabled={pending}
        onClick={() => void fileContest()}
      >
        Request the contest
      </button>
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </div>
  );
}
