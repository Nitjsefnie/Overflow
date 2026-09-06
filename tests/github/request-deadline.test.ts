import { createServer, type RequestListener, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApiError, GitHubGateway } from "@/lib/github/client";

const repository = { owner: "octo", name: "overflow" };
const configuration = { callbackUrl: "https://example.com/hook", secret: "test-secret" };
const repositoryBody = {
  id: 42, name: "overflow", full_name: "octo/overflow", private: false,
  html_url: "https://github.com/octo/overflow", owner: { login: "octo" },
};
const repositoryResult = {
  id: 42, owner: "octo", ownerType: "USER", name: "overflow", fullName: "octo/overflow",
  visibility: "PUBLIC", url: "https://github.com/octo/overflow", canAdminister: false,
};
const reads = [
  { name: "getRepository", run: (gateway: GitHubGateway) => gateway.getRepository(repository), body: JSON.stringify(repositoryBody), result: repositoryResult },
  { name: "getRepositoryById", run: (gateway: GitHubGateway) => gateway.getRepositoryById(42), body: JSON.stringify(repositoryBody), result: repositoryResult },
  { name: "createWebhook", run: (gateway: GitHubGateway) => gateway.createWebhook(repository, configuration), body: '{"id":42}', result: { id: 42 } },
  { name: "getPullRequestDiff", run: (gateway: GitHubGateway) => gateway.getPullRequestDiff(repository, 42), body: "diff --git a/é b/é\n", result: "diff --git a/é b/é\n" },
  { name: "listLabelNames via ensureDifficultyLabels", run: (gateway: GitHubGateway) => gateway.ensureDifficultyLabels(repository, []), body: "[]", result: undefined },
];

const servers = new Set<Server>();
const sockets = new Set<Socket>();

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function serve(listener: RequestListener) {
  const server = createServer(listener);
  servers.add(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a local HTTP port.");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  vi.clearAllTimers();
  vi.useRealTimers();
  const closed = [...servers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  for (const socket of sockets) socket.destroy();
  await Promise.all(closed);
  servers.clear();
  sockets.clear();
});

describe("GitHubGateway REST request deadline", () => {
  it.each([
    ...reads,
    { name: "deleteWebhook", run: (gateway: GitHubGateway) => gateway.deleteWebhook(repository, 42) },
    { name: "label creation POST", run: (gateway: GitHubGateway) => gateway.ensureDifficultyLabels(repository, ["easy"]) },
  ])("aborts $name when headers arrive but no body bytes follow", async ({ name, run }) => {
    const socketClosed = deferred<void>();
    let stalledSocket: Socket | undefined;
    const apiUrl = await serve((request, response) => {
      if (name === "label creation POST" && request.method === "GET") {
        response.end("[]");
        return;
      }
      stalledSocket = request.socket;
      request.socket.once("close", () => socketClosed.resolve());
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
    });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl, timeoutMs: 300 });

    await expect(run(gateway)).rejects.toMatchObject({ message: "GitHub request timed out." });
    await socketClosed.promise;
    expect(stalledSocket?.destroyed).toBe(true);
  }, 3000);

  it.each(reads)("round-trips the successful body for $name", async ({ run, body, result }) => {
    const apiUrl = await serve((_request, response) => response.end(body));
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl });
    await expect(run(gateway)).resolves.toEqual(result);
  });

  it("preserves API error status, throttle metadata and body", async () => {
    const apiUrl = await serve((_request, response) => {
      response.writeHead(403, { "x-ratelimit-remaining": "0", "retry-after": "60" });
      response.end('{"message":"rate limit exceeded"}');
    });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl });
    const error = await gateway.getRepository(repository).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 403, rateLimited: true, retryAfterSeconds: 60, body: '{"message":"rate limit exceeded"}' });
  });

  it("preserves the API error and closes a stalled non-success body", async () => {
    const socketClosed = deferred<void>();
    let stalledSocket: Socket | undefined;
    const apiUrl = await serve((request, response) => {
      stalledSocket = request.socket;
      request.socket.once("close", () => socketClosed.resolve());
      response.writeHead(503);
      response.flushHeaders();
    });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl, timeoutMs: 300 });
    const error = await gateway.getRepository(repository).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ status: 503, body: null });
    await socketClosed.promise;
    expect(stalledSocket?.destroyed).toBe(true);
  }, 3000);

  it("preserves label pagination headers and drains creation responses", async () => {
    const requests: string[] = [];
    const apiUrl = await serve((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.url?.endsWith("page=1")) {
        response.setHeader("link", '</labels?page=2>; rel="next"');
        response.end('[{"name":"easy"}]');
      } else if (request.method === "GET") {
        response.end('[{"name":"hard"}]');
      } else {
        response.end('{"name":"medium"}');
      }
    });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl });
    await expect(gateway.ensureDifficultyLabels(repository, ["easy", "hard", "medium"])).resolves.toBeUndefined();
    expect(requests).toEqual([
      "GET /repos/octo/overflow/labels?per_page=100&page=1",
      "GET /repos/octo/overflow/labels?per_page=100&page=2",
      "POST /repos/octo/overflow/labels",
    ]);
  });

  it.each([
    { status: 404, body: "Not Found", expected: null },
    { status: 200, body: "{invalid", expected: "GitHub API response was invalid." },
  ])("preserves repository lookup semantics for $status / $body", async ({ status, body, expected }) => {
    const apiUrl = await serve((_request, response) => { response.writeHead(status); response.end(body); });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl });
    const outcome = await gateway.getRepositoryById(42).catch((error: Error) => error.message);
    expect(outcome).toBe(expected);
  });

  it.each(["headers", "body"])("maps a transport failure during %s to the existing message", async (stage) => {
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      fetch: async () => {
        if (stage === "headers") throw new Error("connection failed");
        return new Response(new ReadableStream({ start(controller) { controller.error(new Error("connection failed")); } }));
      },
    });
    await expect(gateway.getRepository(repository)).rejects.toMatchObject({ message: "GitHub request failed." });
  });

  it("bounds an injected fetch that never resolves and ignores abort", async () => {
    const gateway = new GitHubGateway({ accessToken: "test-token", timeoutMs: 30, fetch: () => new Promise(() => {}) });
    await expect(gateway.getRepository(repository)).rejects.toMatchObject({ message: "GitHub request timed out." });
  }, 3000);

  it("cancels a body delivered after an abort-ignoring fetch misses its deadline", async () => {
    const delivery = deferred<Response>();
    const cancelled = deferred<void>();
    const gateway = new GitHubGateway({ accessToken: "test-token", timeoutMs: 30, fetch: () => delivery.promise });
    await expect(gateway.getRepository(repository)).rejects.toMatchObject({ message: "GitHub request timed out." });
    delivery.resolve(new Response(new ReadableStream({ cancel() { cancelled.resolve(); } })));
    await cancelled.promise;
  }, 3000);

  it("keeps one absolute deadline across delayed headers and a trickling body", async () => {
    vi.useFakeTimers();
    let delivery: ReturnType<typeof setInterval>;
    let cancelled = false;
    const gateway = new GitHubGateway({
      accessToken: "test-token", timeoutMs: 1000,
      fetch: () => new Promise((resolve) => setTimeout(() => resolve(new Response(new ReadableStream({
        start(controller) { delivery = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 100); },
        cancel() { cancelled = true; clearInterval(delivery); },
      }))), 400)),
    });
    const outcome = gateway.getRepository(repository).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(outcome).resolves.toBe("GitHub request timed out.");
    expect(cancelled).toBe(true);
  }, 3000);
});
