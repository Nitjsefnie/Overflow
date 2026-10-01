/**
 * The deny list a deployment seeds the outbound fetch guard with, so a
 * member-chosen destination cannot name the host itself (issue 899). The
 * host's own public addresses are public, so the address class alone admits
 * them; everything non-public is already refused by the class. This module
 * is the one place that knows what this deployment is, and the guard module
 * stays a host-agnostic pure library.
 *
 * `PUBLIC_DESTINATION_DENY_CIDRS` overrides the seed: a comma-separated list
 * of bare addresses or CIDR subnets, honoured exactly as parsed — an empty
 * value is the explicit opt-out, and an invalid entry throws rather than
 * being dropped, because a silently-ignored entry is a guard that no longer
 * covers what its deployment asked it to cover. Like `APP_URL` in
 * `request-origin`, the environment is read at call time rather than at
 * module load, so a test can arrange it and a deployment cannot bake a stale
 * value in.
 */

import { networkInterfaces } from "node:os";
import { denyListFromCidrs, isPublicAddress } from "@/lib/security/public-destination";

/**
 * The deny list wired into the deployment's `createPublicFetch` transports:
 * the host's own public interface addresses unless
 * `PUBLIC_DESTINATION_DENY_CIDRS` overrides them. Entries are bare addresses
 * or CIDR subnets; an invalid entry throws at the call, which is startup for
 * the singletons. Fail loud; never a silently-dropped entry.
 */
export function deploymentDenyCidrs(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PUBLIC_DESTINATION_DENY_CIDRS;
  if (configured !== undefined) {
    return parseConfiguredCidrs(configured);
  }
  return hostPublicAddresses();
}

function parseConfiguredCidrs(value: string): string[] {
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  // Fail loud at the parse rather than wherever the list first reaches the
  // guard: an entry that never parses must not sit silently out of the list
  // its deployment asked for.
  denyListFromCidrs(entries);
  return entries;
}

function hostPublicAddresses(): string[] {
  const addresses = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isPublicAddress(entry.address)) {
        addresses.add(entry.address);
      }
    }
  }
  return [...addresses];
}
