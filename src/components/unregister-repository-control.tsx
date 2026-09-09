"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type UnregisterRepositoryControlProps = {
  /** The stored owner/name path the DELETE submission carries. */
  ownerName: string;
};

type UnregisterResponse = {
  error?: { message?: string };
};

/**
 * The sponsor's unregister control on a registered-repositories row (issue
 * 48). The DELETE behind it is idempotent and the row stays listed after it
 * (the dashboard's projection cannot expose the unregistration instant), so
 * the control never removes itself: a confirmed press fires the deletion, and
 * on success the sponsor reads the departure and the refreshed ledger hands
 * the row back with the control still offered — which is exactly what makes a
 * retry converge.
 */
export function UnregisterRepositoryControl({ ownerName }: UnregisterRepositoryControlProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  async function submit() {
    setFeedback(null);
    setIsSubmitting(true);
    try {
      const response = await fetch("/api/repositories", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ repositoryUrl: ownerName }),
      });
      const body = (await response.json().catch(() => null)) as UnregisterResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The repository could not be unregistered. Try again.",
        });
        return;
      }
      setFeedback({
        kind: "success",
        message: `${ownerName} is no longer registered.`,
      });
      router.refresh();
    } catch {
      setFeedback({
        kind: "error",
        message: "The unregister request could not reach Overflow. Check your connection and try again.",
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      {confirming ? (
        <>
          <button
            className="quiet-button"
            type="button"
            disabled={isSubmitting}
            onClick={() => {
              setConfirming(false);
              void submit();
            }}
          >
            Confirm unregister
          </button>
          <button
            className="quiet-button"
            type="button"
            disabled={isSubmitting}
            onClick={() => setConfirming(false)}
          >
            Keep registered
          </button>
        </>
      ) : (
        <button
          className="quiet-button"
          type="button"
          disabled={isSubmitting}
          aria-label={`Unregister ${ownerName}`}
          onClick={() => setConfirming(true)}
        >
          Unregister
        </button>
      )}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </>
  );
}
