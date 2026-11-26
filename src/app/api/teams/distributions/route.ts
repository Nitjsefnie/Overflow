import { z } from "zod";
import { handleTeamWrite, productionTeamDependencies, type TeamRouteDependencies } from "@/lib/teams/route";

const distributionSchema = z.object({ memberId: z.string().uuid(), points: z.number().int().min(1) }).strict();

export function createTeamDistributionPostHandler(dependencies: TeamRouteDependencies) {
  return (request: Request): Promise<Response> =>
    handleTeamWrite(request, dependencies, distributionSchema,
      (store, userId, input) => store.distributeTeamPoints(userId, input.memberId, input.points),
      (distribution) => Response.json({ distribution }, { status: 201 }));
}

export const POST = createTeamDistributionPostHandler(productionTeamDependencies);
