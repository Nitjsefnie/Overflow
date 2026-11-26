import type { z } from "zod";
import type { UserRole } from "@/lib/db/types";
import { errorResponse } from "@/lib/http/error-response";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { getProductionSession, requiredMemberSession, type MemberRouteSession } from "@/lib/security/member-route-auth";
import { guardByCredential } from "@/lib/security/route-credential";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { PostgresTeamStore, type TeamRefusal, type TeamStoreResult } from "@/lib/teams/store";

/** Every team body is one small JSON object: a name, a login, an id or an id and a number. */
const TEAM_BODY_LIMIT_BYTES = 4 * 1024; // 4 KiB

export type TeamRouteStore = Pick<
  PostgresTeamStore,
  "createTeam" | "addTeamMember" | "removeTeamMember" | "distributeTeamPoints" | "getTeamForAccount"
>;

export type TeamRouteDependencies = {
  getSession: () => Promise<MemberRouteSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string; tokenId: string } | null>;
  getCurrentRole: (userId: string) => Promise<UserRole | null>;
  createStore: () => TeamRouteStore;
};

export const productionTeamDependencies: TeamRouteDependencies = {
  getSession: getProductionSession,
  findAccountByTokenHash: (hash) => new PostgresApiTokenStore().findAccountByTokenHash(hash),
  getCurrentRole: getCurrentUserRole,
  createStore: () => new PostgresTeamStore(),
};

function upstreamFailure(): Response {
  return errorResponse(502, "UPSTREAM_FAILURE", "Unable to complete the team request.");
}

/** Each store refusal answers the status and code the sibling member routes use for the same kind of refusal. */
function refusalResponse(refusal: TeamRefusal): Response {
  switch (refusal.kind) {
    case "invalid_name":
      return errorResponse(422, "INVALID_INPUT", "A team needs a nonblank name.");
    case "invalid_points":
      return errorResponse(422, "INVALID_INPUT", "Distribute a whole number of points of at least 1.");
    case "name_taken":
      return errorResponse(409, "CONFLICT", "Another team already has that name.");
    case "already_in_team":
      return errorResponse(409, "CONFLICT", "An account belongs to at most one team.");
    case "lead_cannot_leave":
      return errorResponse(409, "CONFLICT", "The team's lead cannot be removed.");
    case "insufficient_balance":
      return errorResponse(409, "CONFLICT", "The team's balance cannot cover that distribution.");
    case "not_lead":
      return errorResponse(403, "FORBIDDEN", "Only the team's lead can do that.");
    case "not_found":
      return errorResponse(404, "NOT_FOUND", "No active account matches.");
    case "not_member":
      return errorResponse(404, "NOT_FOUND", "That account is not a current member of your team.");
  }
}

/** The body parsed by the schema, "tooLarge" past the limit, or null when it is unreadable or invalid. */
async function readTeamBody<T>(request: Request, schema: z.ZodType<T>): Promise<T | "tooLarge" | null> {
  try {
    const raw = await readBodyWithinLimit(request, TEAM_BODY_LIMIT_BYTES);
    if (raw === null) return "tooLarge";
    const parsed = schema.safeParse(JSON.parse(raw.toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A team write: the credential gate, the body, one store call for the caller's account, each refusal mapped. */
export async function handleTeamWrite<T, V>(
  request: Request,
  dependencies: TeamRouteDependencies,
  schema: z.ZodType<T>,
  act: (store: TeamRouteStore, userId: string, input: T) => Promise<TeamStoreResult<V>>,
  answer: (value: V) => Response,
): Promise<Response> {
  const refusal = guardByCredential(request);
  if (refusal !== null) return refusal;
  const session = await requiredMemberSession(request, dependencies);
  if (session instanceof Response) return session;

  const input = await readTeamBody(request, schema);
  if (input === "tooLarge") return errorResponse(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  if (input === null) return errorResponse(422, "INVALID_REQUEST", "Invalid team request.");

  try {
    const result = await act(dependencies.createStore(), session.user.id, input);
    return result.kind === "ok" ? answer(result.value) : refusalResponse(result);
  } catch {
    return upstreamFailure();
  }
}

/** The signed-in account's own team, or null. */
export async function handleTeamRead(request: Request, dependencies: TeamRouteDependencies): Promise<Response> {
  const session = await requiredMemberSession(request, dependencies);
  if (session instanceof Response) return session;
  try {
    return Response.json({ team: await dependencies.createStore().getTeamForAccount(session.user.id) });
  } catch {
    return upstreamFailure();
  }
}
