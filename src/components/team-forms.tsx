"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { TeamMember } from "@/lib/teams/store";

type Feedback = { kind: "error" | "success"; message: string };

/** One JSON request to a team route: true when it succeeded, with the page refreshed to show the change. */
function useTeamRequest() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function send(method: "POST" | "DELETE", url: string, body: unknown, done: string): Promise<boolean> {
    setFeedback(null);
    setPending(true);
    try {
      const response = await fetch(url, {
        method, headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body),
      });
      if (!response.ok) {
        const refusal = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setFeedback({ kind: "error", message: refusal?.error?.message ?? "The request could not be completed. Try again." });
        return false;
      }
      setFeedback({ kind: "success", message: done });
      router.refresh();
      return true;
    } catch {
      setFeedback({ kind: "error", message: "The request could not reach Overflow. Check your connection and try again." });
      return false;
    } finally {
      setPending(false);
    }
  }

  return { pending, feedback, send };
}

function FeedbackLine({ feedback }: { feedback: Feedback | null }): ReactNode {
  if (feedback === null) return null;
  return feedback.kind === "error"
    ? <p className="feedback error" role="alert">{feedback.message}</p>
    : <p className="feedback success" role="status">{feedback.message}</p>;
}

export function CreateTeamForm() {
  const { pending, feedback, send } = useTeamRequest();
  const [name, setName] = useState("");
  return (
    <div className="override-request">
      <label className="field" htmlFor="team-name">
        <span>Team name</span>
        <input id="team-name" className="field-input" type="text" value={name} maxLength={80} required
          onChange={(event) => setName(event.target.value)} />
      </label>
      <button className="action-button" type="button" disabled={pending || name.trim() === ""}
        onClick={() => void send("POST", "/api/teams", { name: name.trim() }, "The team is created.")}>
        Create the team
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

export function AddMemberForm() {
  const { pending, feedback, send } = useTeamRequest();
  const [login, setLogin] = useState("");
  async function add() {
    if (await send("POST", "/api/teams/members", { githubLogin: login.trim() }, "The member is added.")) setLogin("");
  }
  return (
    <div className="override-request">
      <label className="field" htmlFor="team-member-login">
        <span>GitHub login</span>
        <input id="team-member-login" className="field-input" type="text" value={login} maxLength={39} required
          onChange={(event) => setLogin(event.target.value)} />
      </label>
      <button className="action-button" type="button" disabled={pending || login.trim() === ""} onClick={() => void add()}>
        Add the member
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}

export function RemoveMemberButton({ member }: { member: TeamMember }) {
  const { pending, feedback, send } = useTeamRequest();
  return (
    <>
      <button className="quiet-button" type="button" disabled={pending} aria-label={`Remove ${member.githubLogin}`}
        onClick={() => void send("DELETE", "/api/teams/members", { memberId: member.userId }, `${member.githubLogin} is removed.`)}>
        Remove
      </button>
      <FeedbackLine feedback={feedback} />
    </>
  );
}

export function DistributeForm({ members }: { members: readonly TeamMember[] }) {
  const { pending, feedback, send } = useTeamRequest();
  const [memberId, setMemberId] = useState(members[0]?.userId ?? "");
  const [points, setPoints] = useState("");
  const whole = /^[1-9][0-9]*$/.test(points.trim());
  async function distribute() {
    if (await send("POST", "/api/teams/distributions", { memberId, points: Number(points) }, "The points are distributed.")) {
      setPoints("");
    }
  }
  return (
    <div className="override-request">
      <label className="field" htmlFor="team-distribute-member">
        <span>Member</span>
        <select id="team-distribute-member" className="field-input" value={memberId}
          onChange={(event) => setMemberId(event.target.value)}>
          {members.map((member) => <option key={member.userId} value={member.userId}>{member.githubLogin}</option>)}
        </select>
      </label>
      <label className="field" htmlFor="team-distribute-points">
        <span>Points (whole)</span>
        <input id="team-distribute-points" className="field-input" type="number" min={1} step={1} value={points} required
          onChange={(event) => setPoints(event.target.value)} />
      </label>
      <button className="action-button" type="button" disabled={pending || !whole} onClick={() => void distribute()}>
        Distribute the points
      </button>
      <FeedbackLine feedback={feedback} />
    </div>
  );
}
