import { createPublicFetch } from "@/lib/security/public-destination";
import { deploymentDenyCidrs } from "@/lib/security/public-destination-deployment";

/**
 * The identity link's default transport for its verification reads: the same
 * refusal of non-public destinations and redirects as every other request to
 * a member-supplied instance. Those reads answer with one small JSON object
 * each, so 1 MiB is ample and bounds what an instance can make us hold.
 *
 * The deployment's own public addresses are denied alongside the non-public
 * ones, so a member-chosen instance URL cannot name the host itself (issue
 * 899).
 */
export const identityLinkFetch: typeof fetch = createPublicFetch({
  maxBodyBytes: 1024 * 1024,
  denyCidrs: deploymentDenyCidrs(),
});
