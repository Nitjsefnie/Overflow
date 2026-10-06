"use client";

import Link from "next/link";
import { useRef, useState } from "react";

/** The route's refusals this panel reads a branch from. */
const REAUTHENTICATION_REQUIRED = "REAUTHENTICATION_REQUIRED";
const SPONSOR_BLOCKED = "SPONSOR_BLOCKED";

/** The export route names the download in its content disposition; the browser download matches it. */
const EXPORT_FILE_NAME = "overflow-account-export.json";

/** A sponsored registration the deletion refused on, as the route reports it. */
type BlockedRepository = {
  ownerName: string;
  provider: string;
  instanceUrl: string | null;
};

type Refusal = {
  code?: string;
  message?: string;
  repositories?: BlockedRepository[];
};

type AccountControlsPanelProps = {
  /**
   * The GitHub sign-in that makes the session fresh enough to delete, offered
   * beside a `REAUTHENTICATION_REQUIRED` refusal. The dashboard passes a
   * sign-in that requests no scope and returns to the dashboard.
   */
  reauthenticateAction: () => Promise<void>;
  /**
   * Whether the signed-in account is the instance's last live moderator
   * (`role = 'MODERATOR' and deleted_at is null`, with no other live
   * moderator). When true, the deletion section warns before the confirm
   * field that no in-product moderator will remain. The deletion itself is
   * never blocked: this shapes a warning, not a gate (issue 1122).
   */
  isLastLiveModerator?: boolean;
  /**
   * Whether `MODERATOR_GITHUB_USER_IDS` names any GitHub user id. Shapes the
   * last-moderator warning's closing sentence: an absent floor is named
   * plainly, because it is the operator's recovery path and there is none
   * configured yet.
   */
  moderatorFloorConfigured?: boolean;
};

/**
 * The dashboard's self-service account-data section: download the stored
 * export, or delete the account after typing its login as the confirmation.
 * Both controls call the session-only API routes; nothing here opens a public
 * request.
 */
export function AccountControlsPanel({
  reauthenticateAction,
  isLastLiveModerator = false,
  moderatorFloorConfigured = false,
}: AccountControlsPanelProps) {
  const [confirmLogin, setConfirmLogin] = useState("");
  const [exportError, setExportError] = useState<string | null>(null);
  const [deletionError, setDeletionError] = useState<string | null>(null);
  const [blockedRepositories, setBlockedRepositories] = useState<BlockedRepository[] | null>(null);
  const [needsReauthentication, setNeedsReauthentication] = useState(false);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  async function downloadExport() {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setExportError(null);
    try {
      const response = await fetch("/api/account/export", { method: "POST", credentials: "same-origin" });
      if (!response.ok) {
        const refusal = await refusalOf(response);
        setExportError(refusal?.message ?? "Unable to export the account data. Try again.");
        return;
      }
      triggerDownload(await response.blob());
    } catch {
      setExportError("The export request could not reach Overflow. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  async function deleteAccount() {
    // A blank confirmation arms nothing, so it can never send a request.
    if (inFlight.current || confirmLogin.trim() === "") return;
    inFlight.current = true;
    setPending(true);
    setDeletionError(null);
    setBlockedRepositories(null);
    setNeedsReauthentication(false);
    try {
      const response = await fetch("/api/account", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmLogin }),
      });
      if (response.ok) {
        // The session may already be gone, so no in-app route follows the deletion.
        window.location.assign("/");
        return;
      }
      const refusal = await refusalOf(response);
      if (refusal?.code === REAUTHENTICATION_REQUIRED) {
        setNeedsReauthentication(true);
        setDeletionError(refusal.message ?? "Confirm your GitHub sign-in to delete your account.");
        return;
      }
      if (refusal?.code === SPONSOR_BLOCKED) {
        setBlockedRepositories(refusal.repositories ?? []);
        setDeletionError(refusal.message ?? "Unregister your sponsored repositories before deleting your account.");
        return;
      }
      setDeletionError(refusal?.message ?? "Unable to delete the account. Try again.");
    } catch {
      setDeletionError("The deletion request could not reach Overflow. Check your connection and try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="surface" aria-labelledby="account-controls-heading">
      <h2 id="account-controls-heading">Your account data</h2>
      <h3>Download an export</h3>
      <p>
        The export holds the fields Overflow stores about your account — each stored secret appears
        only as present or absent, never as its value.
      </p>
      <button
        className="quiet-button"
        type="button"
        disabled={pending}
        onClick={() => void downloadExport()}
      >
        Download export
      </button>
      {exportError ? <p className="feedback error" role="alert">{exportError}</p> : null}
      <h3>Delete your account</h3>
      <p>
        Deletion is pseudonymisation: the account row survives with what the shared ledger attributes
        work by, and nothing that would let anyone act as you survives with it.{" "}
        <Link href="/account-data#account-data-deletion-heading">What deletion means</Link>
      </p>
      {isLastLiveModerator ? (
        <p className="feedback warning" role="status">
          You are the only moderator left on this instance. Deleting your account leaves Overflow with
          no in-product moderator. Recovery is manual: an operator adds a GitHub user id to
          MODERATOR_GITHUB_USER_IDS and the account it names becomes a moderator the next time it
          signs in — the list promotes on sign-in and never restores a role by itself.
          {moderatorFloorConfigured
            ? ""
            : " No GitHub user id is configured in MODERATOR_GITHUB_USER_IDS right now."}
        </p>
      ) : null}
      <label className="field">
        <span>Type your GitHub login to confirm</span>
        <input
          type="text"
          value={confirmLogin}
          onChange={(event) => setConfirmLogin(event.target.value)}
          autoComplete="off"
        />
      </label>
      <button
        className="action-button"
        type="button"
        disabled={pending || confirmLogin.trim() === ""}
        onClick={() => void deleteAccount()}
      >
        Delete account
      </button>
      {deletionError ? <p className="feedback error" role="alert">{deletionError}</p> : null}
      {blockedRepositories !== null ? (
        <ul className="facts-list">
          {blockedRepositories.map((repository) => (
            <li key={`${repository.provider} ${repository.instanceUrl ?? ""} ${repository.ownerName}`}>
              {repository.ownerName}
              {repository.instanceUrl === null ? "" : ` · ${repository.instanceUrl}`}
            </li>
          ))}
        </ul>
      ) : null}
      {needsReauthentication ? (
        <form id="account-delete-reauthenticate" action={reauthenticateAction}>
          <button className="action-button" type="submit">Confirm GitHub sign-in</button>
        </form>
      ) : null}
    </section>
  );
}

/** The route's error body when it parses as one, null otherwise. */
async function refusalOf(response: Response): Promise<Refusal | null> {
  const body = await response.json().catch(() => null) as { error?: Refusal } | null;
  return body?.error ?? null;
}

/** Offers the blob to the browser as a file download under the export's documented name. */
function triggerDownload(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = EXPORT_FILE_NAME;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoking in the click's own tick can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
