"use client";

import { useState, useSyncExternalStore } from "react";

function subscribeToHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/**
 * The one-click opt-out a digest links to. The token travels in the fragment,
 * so it never reaches the server until the reader presses the button: a mail
 * scanner that fetches the link removes nothing.
 */
export function WorkMailUnsubscribe() {
  // The server snapshot is empty: the fragment exists only in the browser.
  const hash = useSyncExternalStore(subscribeToHash, () => window.location.hash, () => "");
  const token = new URLSearchParams(hash.slice(1)).get("token");
  const [outcome, setOutcome] = useState<"idle" | "pending" | "received" | "failed">("idle");

  async function unsubscribe(value: string) {
    setOutcome("pending");
    try {
      const response = await fetch(`/api/work-mail/unsubscribe?token=${encodeURIComponent(value)}`, { method: "POST" });
      setOutcome(response.ok ? "received" : "failed");
    } catch {
      setOutcome("failed");
    }
  }

  return (
    <main className="landing-page" id="main-content">
      <section className="empty-state" aria-labelledby="work-mail-unsubscribe-title">
        <p className="eyebrow">Work mail</p>
        <h1 id="work-mail-unsubscribe-title">Stop work mail to this address.</h1>
        {token === null ? (
          <p>This link is incomplete. Open the full link from the email, or remove the address on your dashboard.</p>
        ) : (
          <>
            <p>Unsubscribing deletes the address from Overflow, and no more work mail is sent to it.</p>
            <button
              className="action-button"
              type="button"
              disabled={outcome === "pending" || outcome === "received"}
              onClick={() => void unsubscribe(token)}
            >
              Unsubscribe
            </button>
          </>
        )}
        <div aria-live="polite">
          {outcome === "received" ? (
            <p className="feedback success">Received. If the link is valid, the address is deleted.</p>
          ) : outcome === "failed" ? (
            <p className="feedback error">The request did not go through. Try again.</p>
          ) : null}
        </div>
      </section>
    </main>
  );
}
