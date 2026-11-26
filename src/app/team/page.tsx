import { AppShell } from "@/components/app-shell";
import { AddMemberForm, CreateTeamForm, DistributeForm, TeamMemberList } from "@/components/team-forms";
import { isModeratorSession, requireMemberPageSession } from "@/lib/dashboard/session";
import { formatInstant } from "@/lib/format-instant";
import { PostgresTeamStore, type TeamView } from "@/lib/teams/store";

type TeamContentProps = {
  memberName: string;
  isModerator: boolean;
  viewerId: string;
  /** The signed-in account's team, null when it has none, undefined when the read failed. */
  team: TeamView | null | undefined;
};

/**
 * The signed-in account's team: its members, balance and distributions, with
 * the lead's forms for membership and distribution, or a create form when the
 * account is in no team. The store reads only the account the session names.
 */
export function TeamContent({ memberName, isModerator, viewerId, team }: TeamContentProps) {
  const isLead = team != null && team.leadId === viewerId;
  return (
    <AppShell memberName={memberName} isModerator={isModerator}>
      <section className="page-heading" aria-labelledby="team-title">
        <p className="eyebrow">Team</p>
        <h1 id="team-title">{team == null ? "Work as a team." : team.name}</h1>
        <p>
          A team’s lead adds and removes members. Credit for a member’s merged work lands on the team’s balance,
          and only the lead moves whole points from it to members’ own balances.
        </p>
      </section>
      {team === undefined ? (
        <section className="surface" aria-labelledby="team-unavailable-heading">
          <h2 id="team-unavailable-heading">Your team</h2>
          <p role="alert">Your team could not be loaded.</p>
        </section>
      ) : team === null ? (
        <section className="surface" aria-labelledby="team-create-heading">
          <h2 id="team-create-heading">Create a team</h2>
          <p className="mono-meta">You are in no team. Creating one makes you its lead; an account belongs to at most one team.</p>
          <CreateTeamForm />
        </section>
      ) : (
        <>
          <section className="surface" aria-labelledby="team-balance-heading">
            <h2 id="team-balance-heading">Team balance</h2>
            <p><span data-team-balance>{team.balance}</span> points</p>
            <p className="mono-meta">Created {formatInstant(team.createdAt)}</p>
          </section>
          <section className="surface" aria-labelledby="team-members-heading">
            <h2 id="team-members-heading">Members</h2>
            <TeamMemberList members={team.members} leadId={team.leadId} isLead={isLead} />
          </section>
          {isLead ? (
            <>
              <section className="surface" aria-labelledby="team-add-heading">
                <h2 id="team-add-heading">Add a member</h2>
                <AddMemberForm />
              </section>
              <section className="surface" aria-labelledby="team-distribute-heading">
                <h2 id="team-distribute-heading">Distribute points</h2>
                <p className="mono-meta">The team’s balance cannot go below zero through a distribution.</p>
                <DistributeForm members={team.members} />
              </section>
            </>
          ) : null}
          <section className="surface" aria-labelledby="team-distributions-heading">
            <h2 id="team-distributions-heading">Distributions</h2>
            {team.distributions.length === 0 ? (
              <p className="mono-meta">The lead has not distributed any points.</p>
            ) : (
              <ol className="override-history" aria-label="Team distributions">
                {team.distributions.map((distribution) => (
                  <li key={distribution.id}>
                    <p>{distribution.points} to {distribution.memberLogin}</p>
                    <p className="mono-meta">{formatInstant(distribution.createdAt)}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </AppShell>
  );
}

export default async function TeamPage() {
  const session = await requireMemberPageSession();
  let team: TeamView | null | undefined;
  try {
    team = await new PostgresTeamStore().getTeamForAccount(session.user.id);
  } catch {
    // team stays undefined; the page names the failed load instead of offering to create one.
  }
  return (
    <TeamContent
      memberName={session.user.name}
      isModerator={isModeratorSession(session)}
      viewerId={session.user.id}
      team={team}
    />
  );
}
