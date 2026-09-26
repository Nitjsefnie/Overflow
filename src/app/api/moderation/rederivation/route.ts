import { z } from "zod";
import {
  errorResponse,
  getProductionSession,
  moderationErrorResponse,
} from "@/app/api/moderation/route";
import { requiredModeratorSession, type ModerationRouteSession } from "@/lib/moderation/route-auth";
import type { UserRole } from "@/lib/db/types";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { wasStartupRecoverySkipped } from "@/lib/fold/sweep";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import {
  RepositoryRederivationService,
  type OutstandingRederivationRequest,
  type RederivationOverview,
} from "@/lib/moderation/rederivation-service";
import type { ModerationActor } from "@/lib/moderation/service";
import { logPrivilegedAction, readClientAddress } from "@/lib/security/privileged-action-log";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { readBodyWithinLimit } from "@/lib/http/request-body";

/**
 * The rederivation body is one repository id, so 32 KiB bounds the read with
 * wide margin (issue 661).
 */
const REDERIVATION_BODY_LIMIT_BYTES = 32 * 1024; // 32 KiB

const rederivationRequestSchema = z
  .object({
    repositoryId: z.string().uuid(),
  })
  .strict();

export type RederivationRouteService = {
  listRederivationStatus(actor: ModerationActor): Promise<RederivationOverview>;
  requestRederivation(
    actor: ModerationActor,
    repositoryId: string,
    onCommitted: () => void,
  ): Promise<OutstandingRederivationRequest>;
};

export type RederivationRouteDependencies = {
  getSession: () => Promise<ModerationRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createService: () => Promise<RederivationRouteService>;
};

/**
 * Which derived rows the current fold logic produced and which are still an
 * older revision's output, per repository — issue 197's third obligation.
 */
export function createRederivationGetHandler(dependencies: RederivationRouteDependencies) {
  return async function getRederivationStatus(request: Request): Promise<Response> {
    // This read stays deliberately unorigin-guarded: rejectUntrustedRequest
    // refuses a request carrying no Origin header, but a same-origin browser
    // fetch() GET sends none, so guarding this verb would refuse every read
    // the moderation page makes. The gate still resolves a bearer credential
    // from the headers.
    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    try {
      const rederivation = await (await dependencies.createService()).listRederivationStatus(
        session.user,
      );
      return Response.json({ rederivation, startupRecoverySkipped: wasStartupRecoverySkipped() });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

/** Asks for one repository's derived rows to be recomputed — obligation 2. */
export function createRederivationPostHandler(dependencies: RederivationRouteDependencies) {
  return async function postRederivation(request: Request): Promise<Response> {
    const refusal = guardByCredential(request);
    if (refusal !== null) {
      return refusal;
    }

    const session = await requiredModeratorSession(request, dependencies);
    if (session instanceof Response) {
      return session;
    }

    const input = await parseRederivationRequest(request);
    if (input === "tooLarge") {
      return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
    }
    if (input === null) {
      return errorResponse(422, "INVALID_REQUEST", "Invalid re-derivation request.");
    }

    try {
      // The journal line is written by the service the moment the queue write
      // commits, not after the response is certain: the read-back that follows
      // the commit can still fail (a concurrent deactivation, a dropped
      // connection) and strand a committed request without its line.
      const requested = await (await dependencies.createService()).requestRederivation(
        session.user,
        input.repositoryId,
        () =>
          logPrivilegedAction({
            action: "repository.rederivation-request",
            actorId: session.user.id,
            credential: session.credential,
            clientAddress: readClientAddress(request),
            subject: { repositoryId: input.repositoryId },
          }),
      );
      return Response.json({ request: requested });
    } catch (error) {
      return moderationErrorResponse(error);
    }
  };
}

/**
 * Reads the body through readBodyWithinLimit and parses it with the schema.
 * Returns "tooLarge" when the body crosses the route's limit — the caller
 * answers 413 — and null for an unparsable or schema-invalid body, exactly as
 * request.json()'s rejection did before the bounded reader. A body read that
 * itself fails also keeps the null answer.
 */
async function parseRederivationRequest(
  request: Request,
): Promise<{ repositoryId: string } | "tooLarge" | null> {
  try {
    const body = await readBodyWithinLimit(request, REDERIVATION_BODY_LIMIT_BYTES);
    if (body === null) {
      return "tooLarge";
    }
    const result = rederivationRequestSchema.safeParse(JSON.parse(body.toString("utf8")));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

const productionDependencies: RederivationRouteDependencies = {
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  async createService() {
    return new RepositoryRederivationService(new PostgresFoldStore());
  },
};

export const GET = createRederivationGetHandler(productionDependencies);
export const POST = createRederivationPostHandler(productionDependencies);
