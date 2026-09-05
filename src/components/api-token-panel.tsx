"use client";

import { useRef, useState } from "react";

type ApiTokenPanelProps = {
  summary: { createdAt: string } | null;
};

export function ApiTokenPanel({ summary }: ApiTokenPanelProps) {
  const [issued, setIssued] = useState<{ token: string; createdAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const currentSummary = issued ?? summary;

  async function generateToken() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/tokens", { method: "POST", credentials: "same-origin" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Unable to issue an API token.");
        return;
      }
      const body = await response.json() as { token: string; createdAt: string };
      setIssued({ token: body.token, createdAt: body.createdAt });
    } catch {
      setError("The request could not reach Overflow. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="override-card surface shadow-offset" aria-labelledby="api-token-heading">
      <p className="eyebrow">Programmatic access</p>
      <h2 id="api-token-heading">Overflow API token</h2>
      <p>Use an Overflow-issued API token to register repositories programmatically.</p>
      {currentSummary ? (
        <>
          <p>
            Generated <time dateTime={currentSummary.createdAt}>
              {currentSummary.createdAt.replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}
            </time>.
          </p>
          <p id="api-token-revocation">Regenerating means your existing token stops working immediately.</p>
        </>
      ) : <p>You have no API token.</p>}
      <button
        className="action-button"
        type="button"
        disabled={pending}
        aria-describedby={currentSummary ? "api-token-revocation" : undefined}
        onClick={() => void generateToken()}
      >
        {currentSummary ? "Regenerate token" : "Generate token"}
      </button>
      {error ? <p className="feedback error" role="alert">{error}</p> : null}
      {issued ? (
        <div role="status" className="feedback success">
          <p><strong>Copy this token now. It will not be shown again after you leave or reload this page.</strong></p>
          <code style={{ display: "block", userSelect: "all", overflowWrap: "anywhere" }} tabIndex={0}>{issued.token}</code>
        </div>
      ) : null}
    </section>
  );
}
