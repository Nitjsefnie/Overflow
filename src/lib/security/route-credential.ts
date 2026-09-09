import { hashApiToken, readApiTokenCredential } from "@/lib/security/api-token";
import {
  rejectUnsupportedMediaType,
  rejectUntrustedRequest,
} from "@/lib/security/request-origin";

/**
 * The two credential paths a route can take, in one place.
 *
 * A cookie-authenticated request is one the browser authenticates on the
 * client's behalf from whatever page asked, so it is same-origin only. A
 * bearer credential is attached deliberately and never rides along on a
 * cross-site request, so its origin is not consulted — but both paths must be
 * JSON, and both are refused before the token is hashed, the session is read,
 * or the body is parsed. This is the repositories route's established guard,
 * lifted so every credential-widening route shares one spelling of it.
 */

/**
 * The guard a mutation route runs before any credential resolution. Reading
 * the credential is only a header parse, and it decides which guard this
 * request gets — a missing credential leaves the origin guard in place, so
 * widening a route for tokens never weakens its cookie path.
 */
export function guardByCredential(request: Request): Response | null {
  return readApiTokenCredential(request) === null
    ? rejectUntrustedRequest(request)
    : rejectUnsupportedMediaType(request);
}

/**
 * The minimal session shape every gated route resolves to: only the user id is
 * load-bearing, and whatever else the session or the token's account row
 * carries is deliberately not trusted by the gate.
 */
export type RouteCredentialSession = {
  user: { id: string };
};

export type RouteCredentialDependencies = {
  getSession: () => Promise<RouteCredentialSession | null>;
  findAccountByTokenHash: (hash: Buffer) => Promise<{ id: string } | null>;
};

/**
 * Resolves whichever credential the request carries into the account it
 * authenticates as.
 *
 * A bearer token authenticates the request as its OWNER — the account that
 * minted it — and nothing more: the resolved credential deliberately omits the
 * role the account row happens to carry, because the calling gate re-reads the
 * role from the database at request time and that lookup must stay the single
 * role authority for both credential types.
 *
 * The credential rejection is the repositories route's established answer for
 * a malformed or unknown token. Store failures are not answered here at all:
 * they propagate to the caller's own try/catch, which maps them onto the
 * route's established 502 UPSTREAM_FAILURE wording — a moderation route and a
 * settlement-correction route refuse an outage in their own words.
 */
export async function resolveRouteCredential(
  request: Request,
  dependencies: RouteCredentialDependencies,
): Promise<RouteCredentialSession | Response | null> {
  const credential = readApiTokenCredential(request);
  if (credential === null) {
    return await dependencies.getSession();
  }

  const hash = hashApiToken(credential);
  if (hash === null) {
    return credentialRejection();
  }
  const account = await dependencies.findAccountByTokenHash(hash);
  if (account === null) {
    return credentialRejection();
  }
  return { user: { id: account.id } };
}

function credentialRejection(): Response {
  return Response.json(
    {
      error: {
        code: "UNAUTHENTICATED",
        message: "The supplied API token was not accepted.",
      },
    },
    { status: 401 },
  );
}
