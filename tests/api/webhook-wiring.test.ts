import { describe, expect, it, vi } from "vitest";
import { POST as githubPost } from "@/app/api/github/webhooks/route";
import { POST as gitlabPost } from "@/app/api/gitlab/webhooks/route";
import { WEBHOOK_RATE_LIMIT_CAPACITY } from "@/lib/webhooks/rate-limit";

/**
 * Pins the production wiring itself (issue 1053's review minor): the module
 * the server actually mounts must wire the LOGGING rate limiter into its POST
 * handler, not merely any boolean gate. A revert of the wiring to a
 * non-logging engine would otherwise answer the same 429s with no test red —
 * the factory tests drive their own bucket, so only a drive through the real
 * module export sees the difference. Each receiver's drive runs in this
 * file's own module registry, so the drained gate outlives nothing.
 */
describe.each([
  { receiver: "github", post: githubPost },
  { receiver: "gitlab", post: gitlabPost },
] as const)("the production $receiver receiver wires the logging rate limiter", ({ receiver, post }) => {
  it("journals the decline burst's start when the mounted gate declines", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A headerless delivery is the cheapest request the mounted handler
      // can answer: the gate is consulted before any header read, and an
      // admitted one is refused next by the missing headers (400), so
      // admission and decline stay distinguishable without a database. The
      // first `capacity` calls cannot decline — the bucket starts full and a
      // refill only adds tokens — so the drive runs until the first 429,
      // bounded well beyond any refill this loop could earn.
      let declined: Response | undefined;
      for (let sent = 0; sent < WEBHOOK_RATE_LIMIT_CAPACITY + 120 && declined === undefined; sent += 1) {
        const response = await post(headerlessRequest(receiver));
        if (response.status === 429) declined = response;
      }

      // The gate declined, with the response the factory has always mapped:
      // 429 and the fixed retry-after (issue 852's answer, unchanged).
      expect(declined, `no 429 within ${WEBHOOK_RATE_LIMIT_CAPACITY + 120} drives`).toBeDefined();
      expect(declined!.headers.get("retry-after")).toBe("1");
      // The wiring is the point: the mounted gate journaled the burst's
      // start exactly once, in the template the runbook documents.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]![0]).toBe(
        `Webhook rate limit engaged for the ${receiver} receiver (declines so far: 1).`,
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

function headerlessRequest(receiver: "github" | "gitlab"): Request {
  return new Request(`https://overflow.test/api/${receiver}/webhooks?hook=181a4fbb-64d1-44fd-82da-cd191613798c`, {
    method: "POST",
    body: "{}",
  });
}
