import { timingSafeEqual } from "node:crypto";
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
 *
 * The app listens on loopback only, but loopback is not trust: ANY local
 * process can reach the listener and set any header, `X-Real-IP` included, so
 * an address a request carries is a CLAIM until something that holds the
 * shared proxy secret vouches for it. nginx (and the operator) hold that
 * secret and echo it in `x-privileged-proxy-secret`; an address is recorded
 * verified only when that header is present, equals
 * `PRIVILEGED_PROXY_SECRET`, and the variable is set and non-empty, and the
 * address itself is a single valid IP. Without it — including on every host
 * that has not set the variable yet — the claimed address is still recorded,
 * marked unverified.
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
  | "settlement-override.decline"
  | "sanction.contest.decide"
  | "sanction.contest.decide.already_gone";

export type PrivilegedActionEntry = {
  action: PrivilegedAction;
  actorId: string;
  credential: RouteCredentialReference;
  clientAddress: string | null;
  clientAddressVerified: boolean;
  /** The ids naming what was acted on: an account, an audit, a request… */
  subject: Readonly<Record<string, string>>;
};

/**
 * The client address nginx recorded for this request, or null, and whether
 * it is verified.
 *
 * Only `X-Real-IP` is read: nginx sets it to `$remote_addr` after its
 * Cloudflare real-ip step, and `X-Forwarded-For` is client-appendable and is
 * never consulted. A value that is not a single IPv4 or IPv6 address is
 * discarded rather than logged.
 *
 * The address is verified only when the request also carries
 * `x-privileged-proxy-secret` with exactly the value of
 * `PRIVILEGED_PROXY_SECRET` — set and non-empty — and the address itself is a
 * single valid IP. The comparison is constant-time, the same shape the
 * webhook signature checks use. On a host that has not set the variable, no
 * address can verify, which keeps a pre-deploy host fail-safe: entries are
 * written with the claimed address marked unverified until the operator lands
 * the env var and the nginx line.
 */
export function readClientAddress(request: Request): {
  clientAddress: string | null;
  clientAddressVerified: boolean;
} {
  const value = request.headers.get("x-real-ip")?.trim();
  const clientAddress = value !== undefined && isIP(value) !== 0 ? value : null;
  return {
    clientAddress,
    clientAddressVerified: clientAddress !== null && proxySecretMatches(request),
  };
}

/**
 * Whether the request's `x-privileged-proxy-secret` header equals
 * `PRIVILEGED_PROXY_SECRET`, which must be set and non-empty. The unset
 * variable refuses every header, so a host that has not applied the operator
 * steps cannot be talked into verification; the comparison is constant-time
 * over the secret's bytes, guarding a length mismatch first because
 * `timingSafeEqual` throws on one.
 */
function proxySecretMatches(request: Request): boolean {
  const expected = process.env.PRIVILEGED_PROXY_SECRET;
  if (expected === undefined || expected.length === 0) {
    return false;
  }
  const supplied = request.headers.get("x-privileged-proxy-secret");
  if (supplied === null) {
    return false;
  }
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  if (suppliedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, suppliedBytes);
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
    clientAddressVerified: entry.clientAddressVerified,
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
