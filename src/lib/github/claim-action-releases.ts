import { z } from "zod";
import type { GitHubGateway } from "@/lib/github/client";

// Gateways without the optional REST capability can still supply text evidence.
export type ClaimActionReleaseGateway = Partial<Pick<GitHubGateway, "request">>;

const claimGitPath = "/repos/Nitjsefnie-Actions/claim/git";
const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const gitObject = z.object({ sha, type: z.enum(["commit", "tag"]) });
const releaseRef = z.object({ ref: z.string().startsWith("refs/tags/v"), object: gitObject });
const refsEnvelope = z.object({ prefix: z.literal("refs/tags/"), refs: z.array(z.unknown()) });
const peeledCommit = z.object({ object: z.object({ sha, type: z.literal("commit") }) });

/** Resolve fresh for each registration; callers share the result across its workflows. */
export async function resolveClaimActionReleases(gateway: ClaimActionReleaseGateway): Promise<ReadonlySet<string>> {
  try {
    if (gateway.request === undefined) return new Set();
    const response = await gateway.request(`${claimGitPath}/matching-refs/tags/v`);
    const body: unknown = JSON.parse(response.body);
    // GitHub REST returns an array; the prefixed envelope is also accepted.
    const refs = Array.isArray(body) ? body : refsEnvelope.parse(body).refs;
    const released = new Set<string>();
    for (const entry of refs) {
      const ref = releaseRef.safeParse(entry);
      if (!ref.success) continue;
      if (ref.data.object.type === "commit") {
        released.add(ref.data.object.sha);
      } else {
        // A tag object's SHA cannot be used as a commit pin. Require its commit target.
        const tag = await gateway.request(`${claimGitPath}/tags/${ref.data.object.sha}`);
        const commit = peeledCommit.safeParse(JSON.parse(tag.body));
        if (commit.success) released.add(commit.data.object.sha);
      }
    }
    return released;
  } catch {
    // Optional evidence must never fail registration; text evidence remains available.
    return new Set();
  }
}
