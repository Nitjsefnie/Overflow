import { z } from "zod";
import { handleTeamWrite, productionTeamDependencies, type TeamRouteDependencies } from "@/lib/teams/route";

/** A GitHub login is at most 39 characters. */
const addMemberSchema = z.object({ githubLogin: z.string().trim().min(1).max(39) }).strict();
const removeMemberSchema = z.object({ memberId: z.string().uuid() }).strict();

export function createTeamMemberPostHandler(dependencies: TeamRouteDependencies) {
  return (request: Request): Promise<Response> =>
    handleTeamWrite(request, dependencies, addMemberSchema,
      (store, userId, input) => store.addTeamMember(userId, input.githubLogin),
      (member) => Response.json({ member }, { status: 201 }));
}

export function createTeamMemberDeleteHandler(dependencies: TeamRouteDependencies) {
  return (request: Request): Promise<Response> =>
    handleTeamWrite(request, dependencies, removeMemberSchema,
      (store, userId, input) => store.removeTeamMember(userId, input.memberId),
      () => Response.json({ removed: true }));
}

export const POST = createTeamMemberPostHandler(productionTeamDependencies);
export const DELETE = createTeamMemberDeleteHandler(productionTeamDependencies);
