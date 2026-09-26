"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { API_TOKEN_LIFETIME_DAYS } from "@/lib/tokens/lifetime";

type ApiTokenSummary = { createdAt: string; expiresAt: string };

type ApiTokenPanelProps = {
  summary: ApiTokenSummary | null;
};

export function ApiTokenPanel({ summary }: ApiTokenPanelProps) {
  const router = useRouter();
  const [issued, setIssued] = useState<({ token: string } & ApiTokenSummary) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const currentSummary = issued ?? summary;
  // Display only: the server refuses an expired token by the database clock
  // whatever this comparison says.
  const expired = currentSummary !== null && Date.parse(currentSummary.expiresAt) <= Date.now();

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
      const body = await response.json() as { token: string } & ApiTokenSummary;
      setIssued({ token: body.token, createdAt: body.createdAt, expiresAt: body.expiresAt });
      router.refresh();
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
      <p>
        An Overflow API token authenticates as your account. A script holding it can do anything
        your role permits over the API, including moderation and override decisions if you are a
        moderator. It expires {API_TOKEN_LIFETIME_DAYS} days after it is generated.
      </p>
      {currentSummary ? (
        <>
          <p>
            Generated <time dateTime={currentSummary.createdAt}>{formatUtc(currentSummary.createdAt)}</time>.
            {" "}{expired ? "Expired" : "Expires"} <time dateTime={currentSummary.expiresAt}>
              {formatUtc(currentSummary.expiresAt)}
            </time>.
          </p>
          {expired ? (
            <p id="api-token-expired" className="feedback error">
              This token has expired and no longer authenticates. Regenerate it to keep using the API.
            </p>
          ) : null}
          <p id="api-token-revocation">Regenerating means your existing token stops working immediately.</p>
        </>
      ) : <p>You have no API token.</p>}
      <button
        className="action-button"
        type="button"
        disabled={pending}
        aria-describedby={
          currentSummary ? (expired ? "api-token-expired api-token-revocation" : "api-token-revocation") : undefined
        }
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

function formatUtc(instant: string): string {
  return instant.replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}
