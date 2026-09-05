/**
 * Cookie-authenticated mutation routes are reachable from any page a browser
 * loads: the session cookie rides along on a cross-site form post or fetch. The
 * guard here is what makes those routes same-origin only.
 *
 * `APP_URL` is read at call time rather than at module load so that a test can
 * stub it and so that a deployment cannot bake a stale value into the bundle.
 * A missing or unparsable `APP_URL` fails closed: an unconfigured server
 * refuses the mutation instead of trusting an arbitrary origin.
 */

const jsonMediaType = "application/json";
const opaqueOrigin = "null";

export function readTrustedOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.APP_URL?.trim();
  if (configured === undefined || configured === "") {
    return null;
  }

  let origin: string;
  try {
    origin = new URL(configured).origin;
  } catch {
    return null;
  }

  // A scheme without a tuple origin (`data:`, `file:`) serializes to "null",
  // which no request could ever legitimately match.
  return origin === opaqueOrigin ? null : origin;
}

export function rejectUntrustedRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Response | null {
  const trustedOrigin = readTrustedOrigin(env);
  if (trustedOrigin === null) {
    return errorResponse(
      500,
      "MISCONFIGURED",
      "The server is not configured to accept this request.",
    );
  }

  // Checked before the content type on purpose: a foreign origin learns nothing
  // about what Overflow would otherwise have accepted. A missing header is a
  // rejection — browsers send `Origin` on every POST, PATCH and DELETE, the
  // same-origin ones included.
  if (request.headers.get("origin") !== trustedOrigin) {
    return errorResponse(403, "FORBIDDEN", "The request origin is not allowed.");
  }

  // No content type at all is allowed: `POST /api/tokens` legitimately sends no
  // body, and a body-carrying request that omits the header still fails its own
  // schema parse.
  const contentType = request.headers.get("content-type");
  if (contentType !== null && !isJsonMediaType(contentType)) {
    return errorResponse(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "The request must use the application/json content type.",
    );
  }

  return null;
}

function isJsonMediaType(contentType: string): boolean {
  const mediaType = contentType.split(";", 1)[0].trim().toLowerCase();

  return mediaType === jsonMediaType;
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}
