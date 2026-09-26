/**
 * Auth.js trusts the request's host only when its configuration says so, and
 * answers every auth route `500 [auth][error] UntrustedHost` when it does not.
 * Issue 649: a deployment configured from only the documented settings
 * (`.env.example`) answered every sign-in route 500 while readiness answered
 * 200, because `@auth/core`'s own derivation trusts no host in production
 * without `AUTH_URL`, `AUTH_TRUST_HOST`, `VERCEL` or `CF_PAGES`.
 *
 * The trusted host therefore derives from `APP_URL` — the same origin the
 * origin guard (`readTrustedOrigin`) enforces for browser mutations — so one
 * origin decides both, and the documented environment signs in. An operator's
 * own trust configuration keeps precedence exactly as `@auth/core` reads it:
 * when `AUTH_URL`, `AUTH_TRUST_HOST`, `VERCEL` or `CF_PAGES` is set, this
 * returns what `@auth/core`'s own derivation (`lib/utils/env.js`,
 * `setEnvDefaults`) returns for them — a set-but-blank value reads as
 * distrust, as it would without this module. The derivation is consulted only
 * when none of those is set, and it trusts a production deployment exactly
 * when `APP_URL` parses to a real origin.
 */
import { readTrustedOrigin } from "@/lib/security/request-origin";

export function authTrustHost(env: NodeJS.ProcessEnv = process.env): boolean {
  const operatorSet = env.AUTH_URL ?? env.AUTH_TRUST_HOST ?? env.VERCEL ?? env.CF_PAGES;
  if (operatorSet !== undefined) {
    // The chain omits @auth/core's NODE_ENV tail on purpose: that tail is
    // unreachable in its own derivation whenever any of the four above is
    // set, so the return value stays equal to what @auth/core derives alone.
    return Boolean(operatorSet);
  }
  return env.NODE_ENV !== "production" || readTrustedOrigin(env) !== null;
}
