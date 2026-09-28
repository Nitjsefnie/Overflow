import { SERVER_VERSION } from "@/lib/version";

/**
 * Advertised server version endpoint — issue 654.
 *
 * Answers the single version that covers both the HTTP API and the MCP
 * endpoint, so a client can pin what it was built against with one number.
 * Unauthenticated like `/api/readiness`: the value is not a secret and a
 * version probe must not require credentials. `no-store` because a stale
 * cached answer would advertise a version the deployment no longer runs
 * after a deploy.
 */
export async function GET(): Promise<Response> {
  return Response.json(
    { version: SERVER_VERSION },
    { headers: { "cache-control": "no-store" } },
  );
}
