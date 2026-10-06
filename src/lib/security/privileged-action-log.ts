import { isIP } from "node:net";
import type { RouteCredentialReference } from "@/lib/security/route-credential";

/**
 * One journal line per successful privileged action, naming who acted, with
 * which credential, from which client address, on what.
 *
 * The line is the only place the client address is recorded: it never reaches
 * a database column, so the journal's own retention is the address's
 * retention. The credential is the persisted-safe reference only — a session
 * kind, or a token kind with its issuance id — and never a bearer token, its
 * hash, a cookie value or a session JWT.
 */

/** The fixed name of each privileged route decision, one per journal line. */
export type PrivilegedAction =
  | "moderator-role.grant"
  | "moderator-role.revoke"
  | "audit.open"
  | "audit.dismiss"
  | "audit.substantiate"
  | "recalibration.close"
  | "ban.reverse"
  | "credit-adjustment.create"
  | "credit-adjustment.reverse"
  | "repository.rederivation-request"
  | "settlement-override.grant"
  | "settlement-override.decline";

export type PrivilegedActionEntry = {
  action: PrivilegedAction;
  actorId: string;
  credential: RouteCredentialReference;
  clientAddress: string | null;
  /** The ids naming what was acted on: an account, an audit, a request… */
  subject: Readonly<Record<string, string>>;
};

/**
 * The client address nginx recorded for this request, or null.
 *
 * Only `X-Real-IP` is read: nginx sets it to `$remote_addr` after its
 * Cloudflare real-ip step, and the app listens on loopback only, so no client
 * can supply it directly. `X-Forwarded-For` is client-appendable and is never
 * consulted. A value that is not a single IPv4 or IPv6 address is discarded
 * rather than logged.
 */
export function readClientAddress(request: Request): string | null {
  const value = request.headers.get("x-real-ip")?.trim();
  if (value === undefined || isIP(value) === 0) {
    return null;
  }
  return value;
}

/**
 * Writes the journal line. Call it once, after the mutation has succeeded, so
 * a refused or failed request leaves no line claiming it happened.
 */
export function logPrivilegedAction(entry: PrivilegedActionEntry): void {
  console.info("Privileged action", {
    action: entry.action,
    actorId: entry.actorId,
    credential: credentialReference(entry.credential),
    clientAddress: entry.clientAddress,
    subject: entry.subject,
  });
}

/**
 * Rebuilds the reference from its own fields, so a caller handing over a wider
 * object than the type admits cannot widen the journal line with it.
 */
function credentialReference(credential: RouteCredentialReference): RouteCredentialReference {
  return credential.kind === "token"
    ? { kind: "token", tokenId: credential.tokenId }
    : { kind: "session" };
}
