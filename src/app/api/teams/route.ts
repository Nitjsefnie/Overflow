import { z } from "zod";
import { handleTeamRead, handleTeamWrite, productionTeamDependencies, type TeamRouteDependencies } from "@/lib/teams/route";

/** The cap bounds what the page and the lead's distribution list must render; the store trims the name. */
const createTeamSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

export function createTeamGetHandler(dependencies: TeamRouteDependencies) {
  return (request: Request): Promise<Response> => handleTeamRead(request, dependencies);
}

export function createTeamPostHandler(dependencies: TeamRouteDependencies) {
  return (request: Request): Promise<Response> =>
    handleTeamWrite(request, dependencies, createTeamSchema,
      (store, userId, input) => store.createTeam(userId, input.name),
      (team) => Response.json({ team }, { status: 201 }));
}

export const GET = createTeamGetHandler(productionTeamDependencies);
export const POST = createTeamPostHandler(productionTeamDependencies);
