"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { MAX_REASON_LENGTH } from "@/lib/validation/reason";

export function ClosedPrDisputeRequestForm() {
  const router = useRouter();
  const [pullRequestUrl, setPullRequestUrl] = useState("");
  const [reason, setReason] = useState("");
  const [landedPullRequestUrl, setLandedPullRequestUrl] = useState("");
  const [landedCommitUrl, setLandedCommitUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  async function fileDispute() {
    setFeedback(null);
    if (!pullRequestUrl.trim() || !reason.trim()) {
      setFeedback({ kind: "error", message: "Enter the closed pull request URL and a nonblank reason." });
      return;
    }
    setPending(true);
    try {
      const response = await fetch("/api/disputes", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ pullRequestUrl: pullRequestUrl.trim(), reason: reason.trim(),
          ...(landedPullRequestUrl.trim() ? { landedPullRequestUrl: landedPullRequestUrl.trim() } : {}),
          ...(landedCommitUrl.trim() ? { landedCommitUrl: landedCommitUrl.trim() } : {}),
        }),
      });
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setFeedback({ kind: "error", message: body?.error?.message ?? "The filing could not be recorded. Try again." });
        return;
      }
      setFeedback({ kind: "success", message: "A moderator will review this dispute." });
      setReason("");
      router.refresh();
    } catch {
      setFeedback({ kind: "error", message: "The filing could not reach Overflow. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="override-request">
      <label className="field" htmlFor="dispute-pull-request">
        <span>Closed pull request URL</span>
        <input id="dispute-pull-request" name="pullRequestUrl" className="field-input" type="url" value={pullRequestUrl}
          onChange={(event) => setPullRequestUrl(event.target.value)} required />
      </label>
      <p className="mono-meta">Paste your closed PR’s URL. Leave both evidence URLs blank when a merged PR for the same issue is already recorded for it; otherwise supply one landed URL. If the closed PR has no recorded issue, supply a landed PR URL so its issue can be credited.</p>
      <label className="field" htmlFor="dispute-landed-pr">
        <span>Landed pull request URL (optional)</span>
        <input id="dispute-landed-pr" name="landedPullRequestUrl" className="field-input" type="url" value={landedPullRequestUrl}
          onChange={(event) => setLandedPullRequestUrl(event.target.value)} />
      </label>
      <label className="field" htmlFor="dispute-landed-commit">
        <span>Landed commit URL (optional)</span>
        <input id="dispute-landed-commit" name="landedCommitUrl" className="field-input" type="url" value={landedCommitUrl}
          onChange={(event) => setLandedCommitUrl(event.target.value)} />
      </label>
      <label className="field" htmlFor="dispute-reason">
        <span>Why should this closed PR be credited?</span>
        <textarea id="dispute-reason" name="reason" value={reason} onChange={(event) => setReason(event.target.value)}
          rows={3} maxLength={MAX_REASON_LENGTH} required />
      </label>
      <button className="action-button" type="button" disabled={pending} onClick={() => void fileDispute()}>Request the dispute</button>
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </div>
  );
}
