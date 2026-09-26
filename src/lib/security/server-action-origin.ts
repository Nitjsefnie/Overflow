import { headers } from "next/headers";
import { readTrustedOrigin } from "@/lib/security/request-origin";

/**
 * Server actions are the one mutation surface `rejectUntrustedRequest` cannot
 * cover: they are dispatched by Next's action handler, which compares only the
 * Origin HOST against the request's (forwarded) host, so a client that names a
 * foreign host in `Host` or `X-Forwarded-Host` reaches the action under a
 * foreign Origin (issue 700). Reading the trusted origin from `APP_URL` here,
 * inside the action, closes that gap with the same rule the route handlers
 * apply — and fails closed like them: a missing or malformed `APP_URL` refuses
 * the action rather than trusting whatever the request carries.
 */
export async function assertTrustedServerActionOrigin(): Promise<void> {
  const trustedOrigin = readTrustedOrigin();
  const requestOrigin = (await headers()).get("origin");
  if (trustedOrigin === null || requestOrigin !== trustedOrigin) {
    throw new Error("The request origin is not allowed.");
  }
}
