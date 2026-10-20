import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubApiError } from "@/lib/github/errors";
import { resolveClaimActionReleases } from "@/lib/github/claim-action-releases";
import { MAX_SUCCESS_BODY_BYTES } from "@/lib/github/response-text";

const current = createHash("sha1").update("claim action fixture").digest("hex");
const previous = createHash("sha1").update("previous claim action fixture").digest("hex");
const tagSha = "a".repeat(40);
const base = "/repos/Nitjsefnie-Actions/claim/git";
const ref = (version: string, sha: string, type = "commit") => ({ ref: `refs/tags/${version}`, object: { sha, type } });
const gateway = (fetch: typeof globalThis.fetch, timeoutMs = 100) => new GitHubGateway({ accessToken: "test-token", fetch, timeoutMs });

describe("released claim action revisions", () => {
  it.each(["array", "envelope"])("collects all lightweight releases from the %s response", async (shape) => {
    const refs = [ref("v2.0.5", current), ref("v2.0.4", previous), ref("v2.0.3", previous)];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(shape === "array" ? refs : { prefix: "refs/tags/", refs }));
    expect(await resolveClaimActionReleases(gateway(fetch))).toEqual(new Set([current, previous]));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://api.github.com${base}/matching-refs/tags/v`);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("peels annotated tags to their commits without recognizing tag object SHAs", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (String(input).endsWith("/matching-refs/tags/v")) return Response.json([ref("v2.0.5", current), ref("v2.0.4", tagSha, "tag")]);
      expect(String(input)).toBe(`https://api.github.com${base}/tags/${tagSha}`);
      return Response.json({ object: { type: "commit", sha: previous } });
    });
    expect(await resolveClaimActionReleases(gateway(fetch))).toEqual(new Set([current, previous]));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { refs: [] }, { prefix: "refs/tags/", refs: {} }, { prefix: "refs/heads/", refs: [ref("v2.0.5", current), { ref: "refs/heads/main", object: { sha: previous, type: "commit" } }] }, "wrong"])(
    "fails closed for malformed collection %j", async (body) => {
      expect(await resolveClaimActionReleases(gateway(async () => Response.json(body)))).toEqual(new Set());
    },
  );

  it.each([
    ["abbreviated", "0123456"],
    ["overlong", "a".repeat(41)],
  ])("rejects an %s hexadecimal commit SHA in matching refs", async (_kind, invalidSha) => {
    const refs = [ref("v2.0.5", current), ref("v2.0.4", invalidSha)];
    expect(await resolveClaimActionReleases(gateway(async () => Response.json(refs))))
      .toEqual(new Set([current]));
  });

  it.each([
    ["abbreviated", "0123456"],
    ["overlong", "a".repeat(41)],
  ])("rejects an %s hexadecimal commit SHA after peeling an annotated tag", async (_kind, invalidSha) => {
    const fetch: typeof globalThis.fetch = async (input) => Response.json(
      String(input).endsWith("/matching-refs/tags/v")
        ? [ref("v2.0.5", current), ref("v2.0.4", tagSha, "tag")]
        : { object: { type: "commit", sha: invalidSha } },
    );
    expect(await resolveClaimActionReleases(gateway(fetch))).toEqual(new Set([current]));
  });

  it("keeps only v-prefixed tag refs from an envelope containing mixed ref prefixes", async () => {
    const refs = [
      { ref: "refs/heads/main", object: { sha: previous, type: "commit" } },
      ref("notv2.0.4", tagSha),
      ref("v2.0.5", current),
    ];
    expect(await resolveClaimActionReleases(gateway(async () => Response.json({ prefix: "refs/tags/", refs }))))
      .toEqual(new Set([current]));
  });

  it("ignores unusable entries, non-v tags and non-commit objects", async () => {
    const body = [ref("v2.0.5", current), null, {}, { ref: "refs/tags/v2", object: {} },
      { object: { sha: previous, type: "commit" } }, ref("main", previous), ref("v2", previous, "tree"),
      ref("v3", "main"), ref("v4", ""), ref("v5", "v2.0.4")];
    expect(await resolveClaimActionReleases(gateway(async () => Response.json(body)))).toEqual(new Set([current]));
  });

  it.each([{}, null, { object: {} }, { object: { type: "tag", sha: previous } },
    { object: { type: "tree", sha: previous } }, { object: { type: "commit", sha: "main" } }])(
    "does not recognize an unresolvable annotated tag %j", async (peeled) => {
      expect(await resolveClaimActionReleases(gateway(async (input) => Response.json(
        String(input).endsWith("/matching-refs/tags/v") ? [ref("v2.0.4", tagSha, "tag")] : peeled,
      )))).toEqual(new Set());
    },
  );

  it.each(["network", "http", "api-error", "invalid-json", "timeout", "stalled-body", "oversized-body"])(
    "fails closed for a %s failure through the injected gateway transport", async (failure) => {
      let cancelled = false;
      const fetch: typeof globalThis.fetch = async () => {
        if (failure === "network") throw new TypeError("offline");
        if (failure === "api-error") throw new GitHubApiError(403, true, 60);
        if (failure === "http") return new Response("secondary rate limit", { status: 403, headers: { "retry-after": "60" } });
        if (failure === "invalid-json") return new Response("{");
        if (failure === "timeout") return new Promise(() => {});
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            if (failure === "oversized-body") controller.enqueue(new Uint8Array(MAX_SUCCESS_BODY_BYTES + 1));
          },
          cancel() { cancelled = true; },
        }));
      };
      expect(await resolveClaimActionReleases(gateway(fetch, 20))).toEqual(new Set());
      if (failure === "stalled-body" || failure === "oversized-body") expect(cancelled).toBe(true);
    },
  );

  it("fails the entire lookup closed when peeling throws after a lightweight release", async () => {
    expect(await resolveClaimActionReleases(gateway(async (input) => {
      if (String(input).endsWith("/matching-refs/tags/v")) return Response.json([ref("v2.0.5", current), ref("v2.0.4", tagSha, "tag")]);
      return new Response("not found", { status: 404 });
    }))).toEqual(new Set());
  });
});
