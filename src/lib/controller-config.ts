/**
 * The controller identity and request channels the legal pages render are
 * operator configuration (issue 1077): an instance must show whoever operates
 * it — or state plainly that it is not the hosted instance. The values default
 * to the hosted instance's, so an env-less deploy shows the maintainer's text,
 * and they render ONLY on the hosted instance: on any other origin the
 * defaults would publish someone else's controller and channels, which is the
 * defect this module exists to fix, so a non-hosted deployment renders the
 * plain self-hosted statement and no channel its operator never configured.
 *
 * The determination is the deployment's own `APP_URL` origin against
 * `HOSTED_INSTANCE_ORIGIN`. `APP_URL` is already the deployment's
 * self-declared origin — the same value drives the browser-mutation origin
 * guard (`readTrustedOrigin`), Auth.js's trusted-host derivation
 * (`authTrustHost`), and now the legal pages' self-identification — so one
 * value decides, and a copy that claims the hosted origin while serving users
 * at another breaks every browser mutation and sign-in on itself: the claim is
 * self-punishing. The root layout is `force-dynamic`, so the pages' reads are
 * serve-time reads, never values baked at build time.
 */
import { readTrustedOrigin } from "@/lib/security/request-origin";

/** The hosted instance's origin: what the maintainer defaults describe. */
export const HOSTED_INSTANCE_ORIGIN = "https://overflow.nitjsefni.eu";

/** The hosted instance's public request channel, rendered by default there. */
export const HOSTED_ISSUES_URL = "https://github.com/Nitjsefnie/Overflow/issues";

/** The hosted instance's private sensitive-request route, likewise default. */
export const HOSTED_SENSITIVE_URL =
  "https://github.com/Nitjsefnie/Overflow/security/advisories/new";

const HOSTED_CONTROLLER_NAME = "the maintainer of the Nitjsefnie/Overflow project, personally";

/**
 * The controller identity and channels one deployment renders on its legal
 * pages. A field is null when the instance publishes none: the hosted
 * instance always publishes all three (its defaults), and any other instance
 * publishes exactly what its operator configured, so the pages never invent a
 * contact detail the operator has not set.
 */
export type ControllerIdentity = {
  /** The controller's display name, or null when none is published. */
  name: string | null;
  /** The public issues channel, or null when none is published. */
  issuesUrl: string | null;
  /** The sensitive-request route, or null when none is published. */
  sensitiveUrl: string | null;
  /** Whether this deployment is the hosted instance the defaults describe. */
  isHosted: boolean;
};

function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? null : trimmed;
}

/**
 * Whether this deployment is the hosted instance: its `APP_URL` origin equals
 * `HOSTED_INSTANCE_ORIGIN`. A missing or malformed `APP_URL` fails closed —
 * the deployment is treated as not hosted, so it renders the honest
 * self-hosted statement rather than claiming the hosted identity.
 */
export function isHostedInstance(env: NodeJS.ProcessEnv = process.env): boolean {
  return readTrustedOrigin(env) === HOSTED_INSTANCE_ORIGIN;
}

/**
 * The identity one deployment renders. Each `CONTROLLER_*` variable, when set
 * to a non-blank value, replaces its default; an unset variable publishes the
 * default only on the hosted instance, and nothing anywhere else.
 */
export function readControllerIdentity(env: NodeJS.ProcessEnv = process.env): ControllerIdentity {
  const hosted = isHostedInstance(env);
  return {
    name: configured(env.CONTROLLER_NAME) ?? (hosted ? HOSTED_CONTROLLER_NAME : null),
    issuesUrl: configured(env.CONTROLLER_ISSUES_URL) ?? (hosted ? HOSTED_ISSUES_URL : null),
    sensitiveUrl:
      configured(env.CONTROLLER_SENSITIVE_URL) ?? (hosted ? HOSTED_SENSITIVE_URL : null),
    isHosted: hosted,
  };
}
