"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { formatInstant } from "@/lib/format-instant";
import { API_TOKEN_DELIVERY_WINDOW_MINUTES, API_TOKEN_LIFETIME_DAYS } from "@/lib/tokens/lifetime";
// Type-only, so erased at build time: the store's database client never
// reaches this client bundle.
import type {
  ApiTokenStatus as StoredApiTokenStatus,
  ApiTokenSummary as StoredApiTokenSummary,
} from "@/lib/tokens/postgres-store";

/**
 * A store shape as it crosses to the browser: every instant as an ISO-8601
 * string, and its nullability kept. A bare `T[K] extends Date` maps `Date | null`
 * to `Date | null` — the null instant stays a `Date`, so the serialised type is
 * unreachable from a real one.
 */
type Serialized<T> = {
  [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K];
};

type ApiTokenSummary = Serialized<StoredApiTokenSummary>;

/** `expired` is the database's verdict, decided when the page rendered. */
type ApiTokenStatus = Serialized<StoredApiTokenStatus>;

/**
 * What the member can be told about the token on screen.
 *
 * `expired` alone no longer says what it used to: an unconfirmed token fails its
 * delivery window, a confirmed one reaches the lifetime, and both arrive here as
 * `expired: true` (issue 847). The remedy is the same in both cases, so the panel
 * offers the same remedy — but the reason is not the same, and the states are
 * kept apart here so nothing downstream can fold them back together.
 *
 * Two things make a state observable, and it is worth being exact about which
 * does what. A state marker is a DOM handle: it says which explanation the
 * button points at, and a test can follow it, but a member never sees an id. So
 * the markers alone leave the two dead states — a lapsed window and a reached
 * lifetime — with the same shape and the same `error` colour, differing only in
 * a sentence. What a member can see is the first-use line: a confirmed token
 * says when it was first used, an unconfirmed one has nothing there. That line
 * being absent is the observable difference, and it is what makes the sentences
 * decoration rather than the carrier of the distinction.
 */
type TokenState = "unconfirmed" | "window-lapsed" | "active" | "expired";

const TOKEN_STATE_MARKERS = {
  unconfirmed: { id: "api-token-unconfirmed", tone: "pending" },
  "window-lapsed": { id: "api-token-window-lapsed", tone: "error" },
  active: null,
  expired: { id: "api-token-expired", tone: "error" },
} as const satisfies Record<TokenState, { id: string; tone: string } | null>;

function tokenState(summary: ApiTokenSummary, expired: boolean): TokenState {
  if (summary.confirmedAt === null) {
    return expired ? "window-lapsed" : "unconfirmed";
  }
  return expired ? "expired" : "active";
}

function stateExplanation(state: TokenState): string | null {
  switch (state) {
    case "unconfirmed":
      // No claim about how much of the window is left: this renders again on a
      // reloaded page, where part of it is already spent.
      return `Nobody has used this token yet, so it stops working after its ${API_TOKEN_DELIVERY_WINDOW_MINUTES}-minute delivery window unless your script authenticates with it first — that first request starts its ${API_TOKEN_LIFETIME_DAYS} days.`;
    case "window-lapsed":
      return `Nothing ever used this token, so it stopped working at the end of its ${API_TOKEN_DELIVERY_WINDOW_MINUTES}-minute delivery window rather than reaching ${API_TOKEN_LIFETIME_DAYS} days. Regenerate it if your script never received the earlier value.`;
    case "expired":
      return "This token has expired and no longer authenticates. Regenerate it to keep using the API.";
    case "active":
      return null;
  }
}

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
  // expiry instant. A token minted in this view is unconfirmed and inside its
  // delivery window, and the 201 body says so.
  const expired = issued === null && summary !== null && summary.expired;
  const state = currentSummary === null ? null : tokenState(currentSummary, expired);
  // Two views of one state, non-null together: which element carries the
  // explanation, and what it says. `active` contributes neither.
  const marker = state === null ? null : TOKEN_STATE_MARKERS[state];
  const explanation = state === null ? null : stateExplanation(state);

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
      setIssued({
        token: body.token,
        createdAt: body.createdAt,
        expiresAt: body.expiresAt,
        confirmedAt: body.confirmedAt,
      });
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
        identities. A token nobody has used yet stops working after {API_TOKEN_DELIVERY_WINDOW_MINUTES}{" "}
        minutes; the first request that authenticates with it starts its {API_TOKEN_LIFETIME_DAYS} days.
      </p>
      {currentSummary ? (
        <>
          <p>
            Generated <time dateTime={currentSummary.createdAt}>{formatInstant(currentSummary.createdAt)}</time>.
            {" "}{expired ? "Expired" : "Expires"} <time dateTime={currentSummary.expiresAt}>
              {formatInstant(currentSummary.expiresAt)}
            </time>.
          </p>
          {/* The observable half of the state: present exactly when the token has been
            confirmed, so "never used" is something a member sees rather than
            something a sentence has to tell them. */}
          {currentSummary.confirmedAt === null ? null : (
            <p id="api-token-first-use">
              First used{" "}
              <time id="api-token-first-use-at" dateTime={currentSummary.confirmedAt}>
                {formatInstant(currentSummary.confirmedAt)}
              </time>.
            </p>
          )}
          {marker === null ? null : (
            <p id={marker.id} className={`feedback ${marker.tone}`}>{explanation}</p>
          )}
          <p id="api-token-revocation">Regenerating means your existing token stops working immediately.</p>
        </>
      ) : <p>You have no API token.</p>}
      <button
        className="action-button"
        type="button"
        disabled={pending}
        aria-describedby={
          currentSummary
            ? [marker?.id, "api-token-revocation"].filter((id) => id !== undefined).join(" ")
            : undefined
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
