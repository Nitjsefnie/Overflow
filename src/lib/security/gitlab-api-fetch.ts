import { createPublicFetch } from "@/lib/security/public-destination";

/**
 * The GitLab API gateway's default transport: the same refusal of non-public
 * destinations and redirects as every other request to a member-supplied
 * instance, with a larger body cap. A 100-item list page whose issues or
 * merge requests carry long descriptions can exceed the default 1 MiB, and a
 * reconciliation read must not fail on an ordinary page; 64 MiB still bounds
 * what one answer may hold in memory.
 */
export const gitlabApiFetch: typeof fetch = createPublicFetch({ maxBodyBytes: 64 * 1024 * 1024 });
