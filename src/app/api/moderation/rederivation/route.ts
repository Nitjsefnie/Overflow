import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  moderationErrorResponse,
  requiredModeratorSession,
  type ModerationRouteSession,
} from "@/app/api/moderation/route";
import type { UserRole } from "@/lib/db/types";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  RepositoryRederivationService,
  type OutstandingRederivationRequest,
  type RederivationOverview,
} from "@/lib/moderation/rederivation-service";
import { rejectUntrustedRequest } from "@/lib/security/request-origin";

const rederivationRequestSchema = z
  .object({
    repositoryId: z.string().uuid(),
  })
  .strict();

export type RederivationRouteActor = { id: string; role: UserRole };

export type RederivationRouteService = {
  listRederivationStatus(actor: RederivationRouteActor): Promise<RederivationOverview>;
  requestRederivation(
    actor: RederivationRouteActor,
    repositoryId: string,
  ): Promise<OutstandingRederivationRequest>;
};

export type RederivationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<RederivationRouteService>;
};

/**
 * Which derived rows the current fold logic produced and which are still an
 * older revision's output, per repository — issue 197's third obligation.
 */
export function createRederivationGetHandler(dependencies: RederivationRouteDependencies) {
  return async function getRederivationStatus(): Promise<Response> {
    // rejectUntrustedRequest refuses a request carrying no Origin header, but a
    // same-origin browser fetch() GET sends none, so guarding this verb would
    // refuse every read the moderation page makes.
    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const rederivation = await (await dependencies.createService()).listRederivationStatus(
        session.user,
      );
      return Response.json({ rederivation });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

/** Asks for one repository's derived rows to be recomputed — obligation 2. */
export function createRederivationPostHandler(dependencies: RederivationRouteDependencies) {
  return async function postRederivation(request: Request): Promise<Response> {
    const untrusted = rejectUntrustedRequest(request);
    if (untrusted !== null) {
      return untrusted;
    }

    const session = await requiredModeratorSession(dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseRederivationRequest(request);
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid re-derivation request.");
    }

    try {
      const requested = await (await dependencies.createService()).requestRederivation(
        session.user,
        input.repositoryId,
      );
      return Response.json({ request: requested });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

async function parseRederivationRequest(request: Request): Promise<{ repositoryId: string } | null> {
  try {
    const result = rederivationRequestSchema.safeParse(await request.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const productionDependencies: RederivationRouteDependencies = {
  getSession: getProductionSession,
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new RepositoryRederivationService(new PostgresFoldStore());
  },
};

export const GET = createRederivationGetHandler(productionDependencies);
export const POST = createRederivationPostHandler(productionDependencies);
