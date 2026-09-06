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
    const server = await serve((request, response) => {
      response.writeHead(200);
      if (stall === "listing" || !request.url?.endsWith("/workflows")) {
        response.flushHeaders();
        response.write(stall === "listing" ? "[" : "on:");
      } else {
        response.end(JSON.stringify(listing));
      }
    });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl: server.apiUrl, timeoutMs: 500 });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        gateway.listWorkflowFiles(repository).then(() => "completed", (error: Error) => error.message),
        new Promise<string>((resolve) => { watchdog = setTimeout(() => resolve("still pending"), 1500); }),
      ]);
      expect(outcome).toBe("GitHub workflow read timed out.");
    } finally {
      clearTimeout(watchdog);
      await server.close();
    }
  });

  it("completes a normal listing and streamed file read before the deadline", async () => {
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
      const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl: server.apiUrl });
      await expect(gateway.listWorkflowFiles(repository)).resolves.toEqual([
        { path: ".github/workflows/claim.yml", content: "on: issue_comment" },
      ]);
    } finally {
      await server.close();
    }
  });

  it("bounds cumulative read time even when each body arrives within the request timeout", async () => {
    vi.useFakeTimers();
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      // A larger per-request timeout must not extend the overall advisory wait.
      timeoutMs: 60_000,
      fetch: async (input) => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            const content = String(input).endsWith("/workflows") ? JSON.stringify(listing) : "on: issue_comment";
            controller.enqueue(new TextEncoder().encode(content));
            controller.close();
          }, 6000);
        },
      })),
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
