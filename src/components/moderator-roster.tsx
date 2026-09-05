"use client";

import { useState } from "react";

type Moderator = {
  accountId: string;
  githubLogin: string;
  isConfigured: boolean;
};

type Feedback = { kind: "error" | "success"; message: string } | null;

type ModeratorRosterProps = {
  moderators: Moderator[];
  currentAccountId: string;
};

type RoleChangeResponse = {
  change?: { targetGitHubLogin?: string; role?: string };
  error?: { message?: string };
};

export function ModeratorRoster({ moderators, currentAccountId }: ModeratorRosterProps) {
  const [targetAccountId, setTargetAccountId] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pending, setPending] = useState<string | null>(null);

  async function changeRole(id: string, moderator: boolean) {
    setFeedback(null);
    setPending(id);
    try {
      const response = await fetch("/api/moderation/moderators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ targetAccountId: id, moderator }),
      });
      const body = (await response.json().catch(() => null)) as RoleChangeResponse | null;
      if (!response.ok) {
        setFeedback({
          kind: "error",
          message: body?.error?.message ?? "The moderator change could not be completed.",
        });
        return;
      }
      const login = body?.change?.targetGitHubLogin ?? "The account";
      setFeedback({
        kind: "success",
        message: moderator ? `${login} is now a moderator.` : `${login} is no longer a moderator.`,
      });
    } catch {
      setFeedback({ kind: "error", message: "The moderator change could not reach Overflow." });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="moderator-roster">
      <ul className="moderator-list">
        {moderators.map((moderator) => (
          <li key={moderator.accountId}>
            <span>{moderator.githubLogin}</span>
            {moderator.isConfigured ? (
              <span className="mono-meta">named in the deployment configuration</span>
            ) : null}
            {moderator.accountId === currentAccountId ? (
              <span className="mono-meta">you</span>
            ) : (
              <button
                className="quiet-button"
                type="button"
                disabled={pending !== null}
                onClick={() => changeRole(moderator.accountId, false)}
              >
                Revoke {moderator.githubLogin}
              </button>
            )}
          </li>
        ))}
      </ul>

      <label className="field">
        <span>Account to promote</span>
        <input
          name="targetAccountId"
          value={targetAccountId}
          placeholder="account id"
          onChange={(event) => setTargetAccountId(event.target.value)}
        />
      </label>
      <button
        className="action-button"
        type="button"
        disabled={pending !== null || targetAccountId.trim().length === 0}
        onClick={() => changeRole(targetAccountId.trim(), true)}
      >
        Grant moderator
      </button>

      {feedback?.kind === "error" ? <p className="feedback error" role="alert">{feedback.message}</p> : null}
      {feedback?.kind === "success" ? <p className="feedback success" role="status">{feedback.message}</p> : null}
    </div>
  );
}
