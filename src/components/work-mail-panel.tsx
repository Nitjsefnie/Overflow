"use client";

import { useEffect, useState } from "react";

type WorkMailState = {
  enabled: boolean;
  subscription: { address: string; confirmed: boolean } | null;
};

type Feedback = { kind: "error" | "success"; message: string };

const ROUTE = "/api/account/work-mail";
const JSON_HEADERS = { "content-type": "application/json" };
const UNREACHABLE = "The request could not reach Overflow. Check your connection and try again.";

/** The mailed link's token, taken off the URL so it stays out of history, bookmarks and the address bar. */
function takeConfirmToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("work-mail-confirm");
  if (token !== null) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return token;
}

async function refusalMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

/**
 * The dashboard's work-mail section: the stored address and its state, a
 * request form while the feature is enabled, and a remove control whenever an
 * address is stored, so opting out never depends on the feature staying on.
 */
export function WorkMailPanel() {
  const [state, setState] = useState<WorkMailState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(ROUTE, { credentials: "same-origin" });
        if (!response.ok) throw new Error("Work mail load failed");
        const body = (await response.json()) as WorkMailState;
        if (!cancelled) {
          setState(body);
          setLoadFailed(false);
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const token = takeConfirmToken();
    if (token === null) return;
    void (async () => {
      try {
        const response = await fetch(`${ROUTE}/confirm`, {
          method: "POST",
          headers: JSON_HEADERS,
          credentials: "same-origin",
          body: JSON.stringify({ token }),
        });
        setFeedback(response.ok
          ? { kind: "success", message: "Address confirmed." }
          : { kind: "error", message: await refusalMessage(response, "The address could not be confirmed.") });
      } catch {
        setFeedback({ kind: "error", message: UNREACHABLE });
      }
      setLoadAttempt((attempt) => attempt + 1);
    })();
  }, []);

  async function requestConfirmation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setBusy(true);
    try {
      const response = await fetch(ROUTE, {
        method: "POST",
        headers: JSON_HEADERS,
        credentials: "same-origin",
        body: JSON.stringify({ address }),
      });
      if (!response.ok) {
        setFeedback({ kind: "error", message: await refusalMessage(response, "The address could not be saved. Try again.") });
        return;
      }
      setAddress("");
      setFeedback({ kind: "success", message: "Open the confirmation link sent to that address within 24 hours." });
      setLoadAttempt((attempt) => attempt + 1);
    } catch {
      setFeedback({ kind: "error", message: UNREACHABLE });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setFeedback(null);
    setBusy(true);
    try {
      const response = await fetch(ROUTE, { method: "DELETE", credentials: "same-origin" });
      if (!response.ok) {
        setFeedback({ kind: "error", message: "The address could not be removed. Try again." });
        return;
      }
      setState((current) => (current === null ? current : { ...current, subscription: null }));
      setFeedback({ kind: "success", message: "Address removed. No more work mail is sent." });
    } catch {
      setFeedback({ kind: "error", message: UNREACHABLE });
    } finally {
      setBusy(false);
    }
  }

  const subscription = state?.subscription ?? null;
  return (
    <section className="surface" aria-labelledby="work-mail-heading">
      <h2 id="work-mail-heading">Work mail</h2>
      <p>
        Overflow can email you when issues you can take newly appear on your board: at most once a day, and only
        after you confirm the address through the link sent to it. Replies are not read; requests go through the
        project&apos;s GitHub issues.
      </p>
      {state === null ? (
        loadFailed ? null : <p className="empty-copy">Loading work mail…</p>
      ) : subscription === null ? (
        <p className="empty-copy" data-testid="work-mail-state" data-work-mail-state="none">
          No address is stored.
        </p>
      ) : (
        <>
          <dl
            className="issue-facts"
            data-testid="work-mail-state"
            data-work-mail-state={subscription.confirmed ? "confirmed" : "pending"}
          >
            <div>
              <dt>Address</dt>
              <dd data-testid="work-mail-address">{subscription.address}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{subscription.confirmed ? "Confirmed" : "Waiting for confirmation"}</dd>
            </div>
          </dl>
          <button className="quiet-button" type="button" disabled={busy} onClick={() => void remove()}>
            Remove address
          </button>
        </>
      )}
      {state?.enabled ? (
        <form
          onSubmit={(event) => {
            void requestConfirmation(event);
          }}
        >
          <label className="field">
            <span>Email address</span>
            <input
              type="email"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <button className="quiet-button" type="submit" disabled={busy || address === ""}>
            Send confirmation link
          </button>
        </form>
      ) : null}
      {loadFailed ? (
        <p className="feedback error" role="alert">Work mail could not be loaded. Refresh the page to try again.</p>
      ) : null}
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
