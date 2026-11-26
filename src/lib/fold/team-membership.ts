import { moderationInstantToIso, readInstant } from "@/lib/fold/moderation-history";
import type { FoldUser } from "@/lib/fold/repository-fold";

/** One row of an account's team membership history (migration 097), instants at microsecond precision. */
export type FoldTeamMembership = { teamId: string; joinedAt: string; leftAt: string | null };

/**
 * The team whose balance the account's work merged at `at` credits, or null.
 * A member from `joinedAt` (inclusive) until `leftAt` (exclusive), compared at
 * the microsecond precision the rows are stored at. A removal and a re-add in
 * racing transactions can leave two rows covering one instant; the later join
 * decides, so every reader names the same team.
 */
export function teamAt(user: FoldUser | undefined, at: string): string | null {
  return coveringMemberships(user, at).sort((left, right) => (left.joined > right.joined ? -1 : 1))[0]?.teamId ?? null;
}

/**
 * Self-work: the author is the sponsor, or the sponsor was, at the merge, a
 * member of the team the author's merge credits. Work a team does for one of
 * its own members creates no credit, exactly as a sponsor's own work does not.
 */
export function isSelfWorkAt(author: FoldUser | undefined, sponsor: FoldUser, at: string): boolean {
  if (author === undefined) return false;
  const team = teamAt(author, at);
  return author.id === sponsor.id || (team !== null && coveringMemberships(sponsor, at).some((row) => row.teamId === team));
}

/** The settlement field naming the team the author's merge credits: absent for an author in no team then. */
export function settlementTeam(author: FoldUser | undefined, at: string): { teamId?: string } {
  const teamId = teamAt(author, at);
  return teamId === null ? {} : { teamId };
}

function coveringMemberships(user: FoldUser | undefined, at: string): { teamId: string; joined: bigint }[] {
  const instant = readInstant(at);
  if (user === undefined || instant === null) return [];
  return (user.teamMemberships ?? []).flatMap((row) => {
    const joined = readInstant(row.joinedAt);
    const left = row.leftAt === null ? null : readInstant(row.leftAt);
    // An unreadable bound proves no membership, so the work credits its author.
    const covers = joined !== null && joined <= instant && (row.leftAt === null || (left !== null && instant < left));
    return covers ? [{ teamId: row.teamId, joined }] : [];
  });
}

export function teamMembershipsFromJson(value: unknown): FoldTeamMembership[] {
  if (!Array.isArray(value)) {
    throw new Error("Team membership history was invalid.");
  }
  return value.map((candidate) => {
    const { teamId, joinedAt, leftAt } = (typeof candidate === "object" && candidate !== null ? candidate : {}) as Record<string, unknown>;
    if (typeof teamId !== "string" || typeof joinedAt !== "string" || (leftAt !== null && typeof leftAt !== "string")) {
      throw new Error("Team membership history was invalid.");
    }
    try {
      return { teamId, joinedAt: moderationInstantToIso(joinedAt), leftAt: leftAt === null ? null : moderationInstantToIso(leftAt) };
    } catch {
      throw new Error("Team membership history was invalid.");
    }
  });
}
