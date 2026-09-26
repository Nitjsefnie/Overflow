"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { API_TOKEN_LIFETIME_DAYS } from "@/lib/tokens/lifetime";

type ApiTokenSummary = { createdAt: string; expiresAt: string };

/** `expired` is the database's verdict, decided when the page rendered. */
type ApiTokenStatus = ApiTokenSummary & { expired: boolean };

/** The route's refusal when the session's GitHub sign-in is too old to mint. */
const REAUTHENTICATION_REQUIRED_CODE = "REAUTHENTICATION_REQUIRED";

type ApiTokenPanelProps = {
  summary: ApiTokenStatus | null;
  /**
   * The GitHub sign-in that makes the session fresh enough to mint, offered
   * beside a `REAUTHENTICATION_REQUIRED` refusal. The page passes a sign-in
   * that requests no scope and returns to this page.
   */
  reauthenticateAction?: () => Promise<void>;
};

export function ApiTokenPanel({ summary, reauthenticateAction }: ApiTokenPanelProps) {
  const router = useRouter();
  const [issued, setIssued] = useState<({ token: string } & ApiTokenSummary) | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const currentSummary = issued ?? summary;
  // The database's verdict, never this browser's clock: reading the clock
  // here could disagree with the refusal, and with the server render at the
  // expiry instant. A token minted in this view has its full lifetime ahead.
  const expired = issued === null && summary !== null && summary.expired;

  async function generateToken() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/tokens", { method: "POST", credentials: "same-origin" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
        setError({ message: body?.error?.message ?? "Unable to issue an API token.", code: body?.error?.code });
        return;
      }
      const body = await response.json() as { token: string } & ApiTokenSummary;
      setIssued({ token: body.token, createdAt: body.createdAt, expiresAt: body.expiresAt });
      router.refresh();
    } catch {
      setError({ message: "The request could not reach Overflow. Check your connection and try again." });
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
        your role permits on the routes that accept an API token, including moderation and override
        decisions if you are a moderator; it cannot generate tokens or manage linked forge
        identities. It expires {API_TOKEN_LIFETIME_DAYS} days after it is generated.
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
      {error ? <p className="feedback error" role="alert">{error.message}</p> : null}
      {error?.code === REAUTHENTICATION_REQUIRED_CODE && reauthenticateAction !== undefined ? (
        <form id="api-token-reauthenticate" action={reauthenticateAction}>
          <button className="action-button" type="submit">Confirm GitHub sign-in</button>
        </form>
      ) : null}
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
