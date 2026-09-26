import { headers } from "next/headers";
import { readTrustedOrigin } from "@/lib/security/request-origin";

/** Thrown for a request whose Origin is not the `APP_URL` origin. */
export const ORIGIN_REFUSED_MESSAGE = "The request origin is not allowed.";

/**
 * Thrown when `APP_URL` is missing or malformed, so an operator can tell a bad
 * deploy from a foreign request. Neither message ever carries the received
 * Origin.
 */
export const ORIGIN_MISCONFIGURED_MESSAGE = "The server is not configured to accept this request.";

/**
 * Server actions are the one mutation surface `rejectUntrustedRequest` cannot
 * cover: they are dispatched by Next's action handler, which compares only the
 * Origin HOST against the request's (forwarded) host, so a client that names a
 * foreign host in `Host` or `X-Forwarded-Host` reaches the action under a
 * foreign Origin (issue 700). Reading the trusted origin from `APP_URL` here,
 * inside the action, closes that gap with the same rule the route handlers
 * apply — and fails closed like them: a missing or malformed `APP_URL` refuses
 * the action rather than trusting whatever the request carries.
 *
 * An action must call this first and let its error propagate. Catching it to
 * return form state would run the refusal path as a success, and the coverage
 * test requires every exported action to reject with the guard's exact message.
 */
export async function assertTrustedServerActionOrigin(): Promise<void> {
  const trustedOrigin = readTrustedOrigin();
  if (trustedOrigin === null) {
    throw new Error(ORIGIN_MISCONFIGURED_MESSAGE);
  }
  const requestOrigin = (await headers()).get("origin");
  if (requestOrigin !== trustedOrigin) {
    throw new Error(ORIGIN_REFUSED_MESSAGE);
  }
}
