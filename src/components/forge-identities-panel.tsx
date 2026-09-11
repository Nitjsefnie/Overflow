"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ForgeIdentityRow = {
  id: string;
  provider: string;
  instanceUrl: string;
  forgeLogin: string;
  verifiedAt: string;
};

/**
 * The dashboard's forge-identity section: the member's linked identities, one
 * link form, one unlink control per row. Scale-honest by design — GitLab is
 * the only provider today, the form is two fields, and there is no wizard.
 * The list is fetched client-side from the session-only API; the section is
 * mounted inside the signed-in dashboard, so an empty list is a normal state.
 */
export function ForgeIdentitiesPanel() {
  const router = useRouter();
  const [identities, setIdentities] = useState<ForgeIdentityRow[] | null>(null);
  const [instanceUrl, setInstanceUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "error" | "success"; message: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/forge-identities", { credentials: "same-origin" });
        if (!response.ok) return;
        const body = (await response.json()) as { identities: ForgeIdentityRow[] };
        if (!cancelled) setIdentities(body.identities);
      } catch {
        // The section renders without the list; a refresh retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function link(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    setBusy(true);
    try {
      const response = await fetch("/api/forge-identities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ instanceUrl, token }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      if (!response.ok) {
        setFeedback({ kind: "error", message: body?.error?.message ?? "The identity could not be linked. Try again." });
        return;
      }
      setToken("");
      setInstanceUrl("");
      setFeedback({ kind: "success", message: "Forge identity linked." });
      router.refresh();
      const list = await fetch("/api/forge-identities", { credentials: "same-origin" });
      if (list.ok) {
        const listBody = (await list.json()) as { identities: ForgeIdentityRow[] };
        setIdentities(listBody.identities);
      }
    } catch {
      setFeedback({ kind: "error", message: "The link request could not reach Overflow. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  async function unlink(id: string) {
    setFeedback(null);
    setBusy(true);
    try {
      const response = await fetch("/api/forge-identities", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ id }),
      });
      if (response.ok) {
        setIdentities((current) => (current ?? []).filter((identity) => identity.id !== id));
        router.refresh();
      } else {
        setFeedback({ kind: "error", message: "The identity could not be unlinked. Try again." });
      }
    } catch {
      setFeedback({ kind: "error", message: "The unlink request could not reach Overflow. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface" aria-labelledby="forge-identities-heading">
      <h2 id="forge-identities-heading">Forge identities</h2>
      <p>
        Link a GitLab account so Overflow can read your repositories there with your token.
        The token is verified before it is stored, and it is stored encrypted — never displayed.
      </p>
      {identities === null ? (
        <p className="empty-copy">Loading linked identities…</p>
      ) : identities.length === 0 ? (
        <p className="empty-copy">No forge identity is linked to this account yet.</p>
      ) : (
        <ul className="facts-list">
          {identities.map((identity) => (
            <li key={identity.id}>
              <dl className="issue-facts">
                <div>
                  <dt>Provider</dt>
                  <dd>{identity.provider}</dd>
                </div>
                <div>
                  <dt>Instance</dt>
                  <dd>{identity.instanceUrl}</dd>
                </div>
                <div>
                  <dt>Forge login</dt>
                  <dd>{identity.forgeLogin}</dd>
                </div>
                <div>
                  <dt>Verified</dt>
                  <dd>{identity.verifiedAt.slice(0, 10)}</dd>
                </div>
                <div>
                  <dt>Unlink</dt>
                  <dd>
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={busy}
                      aria-label={`Unlink ${identity.forgeLogin} on ${identity.instanceUrl}`}
                      onClick={() => {
                        void unlink(identity.id);
                      }}
                    >
                      Unlink
                    </button>
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      <form
        className="forge-link-form"
        onSubmit={(event) => {
          void link(event);
        }}
      >
        <h3>Link a GitLab instance</h3>
        <label className="field">
          <span>Instance URL</span>
          <input
            type="url"
            value={instanceUrl}
            onChange={(event) => setInstanceUrl(event.target.value)}
            placeholder="https://gitlab.com"
            required
          />
        </label>
        <label className="field">
          <span>Personal access token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            autoComplete="off"
            aria-describedby="forge-token-scope"
            required
          />
        </label>
        <p className="field-help" id="forge-token-scope">
          Create the token with the <code>read_api</code> scope. <code>read_user</code> alone is not enough;
          the broader <code>api</code> scope also works.
        </p>
        <button className="quiet-button" type="submit" disabled={busy || instanceUrl === "" || token === ""}>
          Link identity
        </button>
      </form>
      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </section>
  );
}
