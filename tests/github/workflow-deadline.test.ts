import { createServer, type RequestListener } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

const repository = { owner: "octo", name: "overflow" };
const listing = [
  { type: "file", name: "claim.yml", path: ".github/workflows/claim.yml", size: 17 },
];

async function serve(listener: RequestListener) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a local HTTP port.");
  }
  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}

describe("GitHubGateway workflow deadline", () => {
  it.each(["listing", "file"])("settles when successful %s headers are followed by a stalled body", async (stall) => {
    let stalledConnectionClosed = false;
    let stalledResponseClosed = false;
    const fetched: Array<{ signal: AbortSignal | null | undefined; response: Response }> = [];
    const server = await serve((request, response) => {
      response.writeHead(200);
      if (stall === "listing" || !request.url?.endsWith("/workflows")) {
        request.socket.on("close", () => { stalledConnectionClosed = true; });
        response.on("close", () => { stalledResponseClosed = true; });
        response.flushHeaders();
        response.write(stall === "listing" ? "[" : "on:");
      } else {
        response.end(JSON.stringify(listing));
      }
    });
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      apiUrl: server.apiUrl,
      timeoutMs: 500,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        fetched.push({ signal: init?.signal, response });
        return response;
      },
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        gateway.listWorkflowFiles(repository).then(() => "completed", (error: Error) => error.message),
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 1500); }),
      ]);
      expect(outcome).toBe("GitHub workflow read timed out.");
      // Observe production cleanup before the test helper can close the socket.
      expect.soft(fetched.at(-1)?.signal?.aborted).toBe(true);
      expect.soft(fetched.at(-1)?.response.body?.locked).toBe(false);
      await expect.poll(() => stalledConnectionClosed && stalledResponseClosed, { timeout: 1000 }).toBe(true);
    } finally {
      clearTimeout(watchdog);
      await server.close();
    }
  });

  it("completes a normal listing and streamed file read before the deadline", async () => {
    const responses: Response[] = [];
    const server = await serve((request, response) => {
      response.writeHead(200);
      if (request.url?.endsWith("/workflows")) {
        response.end(JSON.stringify(listing));
      } else {
        response.write("on: ");
        response.end("issue_comment");
      }
    });
    try {
      const gateway = new GitHubGateway({
        accessToken: "test-token",
        apiUrl: server.apiUrl,
        fetch: async (input, init) => {
          const response = await fetch(input, init);
          responses.push(response);
          return response;
        },
      });
      await expect(gateway.listWorkflowFiles(repository)).resolves.toEqual([
        { path: ".github/workflows/claim.yml", content: "on: issue_comment" },
      ]);
      expect(responses.map((response) => response.body?.locked)).toEqual([false, false]);
    } finally {
      await server.close();
    }
  });

  it.each(["pending", "rejecting", "throwing"] as const)(
    "settles and unlocks a stalled body even when cancellation is %s",
    async (cancellation) => {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
          if (cancellation === "pending") return new Promise<void>(() => {});
          if (cancellation === "rejecting") return Promise.reject(new Error("cancel failed"));
          throw new Error("cancel failed");
        },
      }));
      const gateway = new GitHubGateway({
        accessToken: "test-token",
        timeoutMs: 50,
        // An injected transport may ignore abort; the reader still needs cleanup.
        fetch: async (input) => String(input).endsWith("/workflows") ? Response.json(listing) : response,
      });

      await expect(gateway.listWorkflowFiles(repository)).rejects.toThrow("GitHub workflow read timed out.");
      expect.soft(cancelled).toBe(true);
      expect(response.body?.locked).toBe(false);
    },
  );

  it.each(["pending", "rejecting", "throwing"] as const)(
    "releases an oversized body and reads the next file even when cancellation is %s",
    async (cancellation) => {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(262145)); },
        cancel() {
          cancelled = true;
          if (cancellation === "pending") return new Promise<void>(() => {});
          if (cancellation === "rejecting") return Promise.reject(new Error("cancel failed"));
          throw new Error("cancel failed");
        },
      }, { highWaterMark: 0 }));
      const gateway = new GitHubGateway({
        accessToken: "test-token",
        timeoutMs: 50,
        fetch: async (input) => {
          if (String(input).endsWith("/workflows")) {
            return Response.json([
              { type: "file", name: "a.yml", path: ".github/workflows/a.yml", size: 1 },
              ...listing,
            ]);
          }
          return String(input).endsWith("/a.yml") ? response : new Response("on: issue_comment");
        },
      });

      const outcome = await gateway.listWorkflowFiles(repository).catch((error: Error) => error.message);
      expect.soft(outcome).toEqual([{ path: ".github/workflows/claim.yml", content: "on: issue_comment" }]);
      expect.soft(cancelled).toBe(true);
      expect(response.body?.locked).toBe(false);
    },
  );

  it("releases the body reader when a file stream errors", async () => {
    const failure = new Error("workflow stream failed");
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(failure); },
    }));
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      fetch: async (input) => String(input).endsWith("/workflows") ? Response.json(listing) : response,
    });

    await expect(gateway.listWorkflowFiles(repository)).rejects.toBe(failure);
    expect(response.body?.locked).toBe(false);
  });

  it("bounds cumulative read time even when each body arrives within the request timeout", async () => {
    vi.useFakeTimers();
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      // A larger per-request timeout must not extend the overall advisory wait.
      timeoutMs: 60_000,
      fetch: async (input) => {
        let delivery: ReturnType<typeof setTimeout>;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            delivery = setTimeout(() => {
              const content = String(input).endsWith("/workflows") ? JSON.stringify(listing) : "on: issue_comment";
              controller.enqueue(new TextEncoder().encode(content));
              controller.close();
            }, 6000);
          },
          cancel() { clearTimeout(delivery); },
        }));
      },
    });
    let outcome = "still pending";
    const read = gateway.listWorkflowFiles(repository).then(
      () => { outcome = "completed"; },
      (error: Error) => { outcome = error.message; },
    );
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(outcome).toBe("GitHub workflow read timed out.");
    } finally {
      await vi.runAllTimersAsync();
      await read;
      vi.useRealTimers();
    }
  });
});
