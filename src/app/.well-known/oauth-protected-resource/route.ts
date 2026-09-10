import { errorResponse } from "@/lib/security/member-route-auth";
import { protectedResourceMetadata } from "@/lib/security/protected-resource-metadata";

/**
 * The RFC 9728 protected-resource document at the location RFC 9728 §3.1
 * names. Public and unauthenticated by design: a client that reads it is
 * precisely the client that holds no credential yet. A deployment with no
 * parsable `APP_URL` has no resource to name, so the answer is the same
 * misconfiguration refusal the guarded routes give.
 */
export async function GET(): Promise<Response> {
  const document = protectedResourceMetadata();
  if (document === null) {
    return errorResponse(
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  }

  return Response.json(document);
}
