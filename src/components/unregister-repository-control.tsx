"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const keepRegisteredRef = useRef<HTMLButtonElement>(null);
  const wasConfirmingRef = useRef(false);

  /**
   * A confirm swap that happens under the user's focus is silent to assistive
   * tech: the focused control is what a screen reader announces and where a
   * keyboard user's place is. Move focus onto the non-destructive choice when
   * the confirmation opens (WAI-ARIA practice for destructive confirmations)
   * and back onto the trigger when it is declined. The previous-value guard
   * keeps the effect off the initial mount — and off StrictMode's second
   * invocation of it — so rendering the control never steals focus; after a
   * confirmed submit the declined branch targets a trigger that isSubmitting
   * has disabled, where focus() is a silent no-op.
   */
  useEffect(() => {
    if (confirming === wasConfirmingRef.current) {
      return;
    }
    wasConfirmingRef.current = confirming;
    if (confirming) {
      keepRegisteredRef.current?.focus();
    } else {
      triggerRef.current?.focus();
    }
  }, [confirming]);

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
            ref={keepRegisteredRef}
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
          ref={triggerRef}
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
