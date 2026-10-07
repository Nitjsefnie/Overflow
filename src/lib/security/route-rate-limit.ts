// Issue 1054: the keyed bound for the expensive routes. The mechanism is the
// webhook token bucket (src/lib/webhooks/rate-limit.ts) generalised per key;
// this module is the route-side wiring: the per-class env-derived bounds, the
// 429 + Retry-After answer, the credential-identity key derivation, and the
// once-per-burst decline log.
//
// The check runs INSIDE each expensive route's handler, after authentication
// (the acting credential identity is known); every auth refusal precedes the
// gate, so refusals never consume a bound. It sits immediately before the
// first unit of the work the bound protects. The per-request detail logging
// is issue 1053's scope and stays out of this one.
//
// The limiter's registry never evicts, so the key space must be bounded: the
// key is the acting credential identity, never a raw request IP or other
// request-derived text.

import { logField } from "@/lib/webhooks/log-field";
import type { RateLimiter } from "@/lib/webhooks/rate-limit";
import type { RouteCredentialReference } from "@/lib/security/route-credential";

/**
 * One expensive-route class: the variable the operator sets and the documented
 * default. `defaultPerHour` is the burst size; the steady refill is
 * `defaultPerHour / 60` tokens per minute, so an hour of steady refilling
 * restores exactly the burst.
 */
export interface RouteRateClassSpec {
  envName: string;
  defaultPerHour: number;
}

/**
 * The five classes (issue 1054), with the basis for each default carried in
 * the docs deliverable (.env.example and OPERATING.md's environment
 * reference); this table is the single source the route files derive from.
 */
export const EXPENSIVE_ROUTE_RATE_CLASSES = {
  export: { envName: "RATE_LIMIT_EXPORT_PER_HOUR", defaultPerHour: 3 },
  repositories: { envName: "RATE_LIMIT_REPOSITORIES_PER_HOUR", defaultPerHour: 10 },
  tokens: { envName: "RATE_LIMIT_TOKENS_PER_HOUR", defaultPerHour: 5 },
  forgeIdentities: { envName: "RATE_LIMIT_FORGE_IDENTITIES_PER_HOUR", defaultPerHour: 5 },
  overrides: { envName: "RATE_LIMIT_OVERRIDES_PER_HOUR", defaultPerHour: 5 },
} as const;

export type ExpensiveRouteRateClass = keyof typeof EXPENSIVE_ROUTE_RATE_CLASSES;

/**
 * The derived bound for one class: the burst size and the steady refill rate
 * the keyed limiter takes per call.
 */
export interface RouteRateLimits {
  capacity: number;
  refillPerMinute: number;
}

/**
 * Reads one class's bound from the environment. A value that is present but
 * not a positive finite number — blank, non-numeric, zero, negative, or an
 * overflow to Infinity — falls back to the documented default: the limiter's
 * math must never see 0 or less (capacity 0 declines forever; refill 0
 * reports an infinite Retry-After).
 */
export function resolveRouteRateLimit(
  env: Record<string, string | undefined>,
  spec: RouteRateClassSpec,
): RouteRateLimits {
  const raw = env[spec.envName];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return { capacity: parsed, refillPerMinute: parsed / 60 };
    }
  }
  return { capacity: spec.defaultPerHour, refillPerMinute: spec.defaultPerHour / 60 };
}

/**
 * The keyed gate one expensive route admits through: it consumes one token
 * for the identity key and returns null to proceed, or the 429 answer the
 * route returns instead of doing the work.
 */
export type RouteRateGate = (identityKey: string) => Response | null;

export interface RouteRateGateOptions {
  /** The operation class named in the decline log. */
  className: string;
  /** The keyed limiter this gate admits through; the route file owns the instance. */
  limiter: RateLimiter;
  /** The class's env-derived bound, resolved once at module scope. */
  limits: RouteRateLimits;
  /**
   * Explicit instants for every admit this gate performs. Production gates
   * omit it, and the limiter then reads its own injected clock; a test
   * injects a controlled one here.
   */
  nowMs?: () => number;
}

/** The fixed 429 envelope text. No request detail rides it (issue 1053 stays out). */
const RATE_LIMITED_MESSAGE =
  "Too many requests of this kind. Retry after the number of seconds the Retry-After header names.";

/**
 * Builds the gate. Over the bound the answer is 429 with `Retry-After` set to
 * the limiter's integer seconds, and a decline is logged once per burst —
 * only when the limiter reports `firstDecline` — naming the class and the
 * identity, never the per-request detail.
 */
export function createRouteRateGate(options: RouteRateGateOptions): RouteRateGate {
  const { className, limiter, limits, nowMs } = options;
  return (identityKey: string): Response | null => {
    const outcome = nowMs === undefined
      ? limiter.admit(identityKey, { capacity: limits.capacity, refillPerMinute: limits.refillPerMinute })
      : limiter.admit(identityKey, {
          capacity: limits.capacity,
          refillPerMinute: limits.refillPerMinute,
          nowMs: nowMs(),
        });
    if (outcome.allowed) {
      return null;
    }
    if (outcome.firstDecline) {
      console.warn(`Rate limit: the ${className} bound is spent for ${logField(identityKey)}; declining until the next token refills.`);
    }
    return new Response(
      JSON.stringify({ error: { code: "RATE_LIMITED", message: RATE_LIMITED_MESSAGE } }),
      { status: 429, headers: { "retry-after": String(outcome.retryAfterSeconds) } },
    );
  };
}

/**
 * The bounded identity a route's bound is keyed by: the session's account id,
 * or the API token's issuance id. Both are bounded by construction — account
 * ids exist once per account, issuance ids once per minting — so the
 * limiter's never-evicting registry stays bounded.
 */
export function routeRateLimitKey(
  credential: RouteCredentialReference,
  userId: string,
): string {
  return credential.kind === "token"
    ? `token:${credential.tokenId}`
    : `user:${userId}`;
}

/**
 * Runs the route's gate when one is wired and answers its refusal; a handler
 * built without a gate — the shape every test factory call takes — stays
 * unbounded, so the wiring sites that serve production are the only places
 * the bound exists. Returns null to proceed.
 */
export function applyRouteRateGate(
  gate: RouteRateGate | undefined,
  credential: RouteCredentialReference,
  userId: string,
): Response | null {
  if (gate === undefined) {
    return null;
  }
  return gate(routeRateLimitKey(credential, userId));
}
