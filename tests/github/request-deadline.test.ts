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
  it("closes the accepted connection when headers never arrive", async () => {
    const accepted = deferred<Socket>();
    const apiUrl = await serve((request) => accepted.resolve(request.socket));
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl, timeoutMs: 300 });
    const outcome = gateway.getRepository(repository).catch((error: unknown) => error);
    const stalledSocket = await accepted.promise;

    expect(await outcome).toMatchObject({ message: "GitHub request timed out." });
    await expect.poll(() => stalledSocket.destroyed, { timeout: 1000 }).toBe(true);
  }, 3000);

  it("does not abort a completed request after its old deadline", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    let requestSignal: AbortSignal | null | undefined;
    const gateway = new GitHubGateway({
      accessToken: "test-token", timeoutMs: 1000,
      fetch: async (_input, init) => {
        requestSignal = init?.signal;
        requestSignal?.addEventListener("abort", aborted);
        return new Response(JSON.stringify(repositoryBody));
      },
    });

    await expect(gateway.getRepository(repository)).resolves.toEqual(repositoryResult);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    await vi.advanceTimersByTimeAsync(1001);
    expect(aborted).not.toHaveBeenCalled();
    expect(requestSignal?.aborted).toBe(false);
  });

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

  it("preserves label pagination headers before creating missing labels", async () => {
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

  it("maps a header-stage transport failure to the request-failed message", async () => {
    const gateway = new GitHubGateway({
      accessToken: "test-token",
      fetch: async () => { throw new Error("connection failed"); },
    });
    await expect(gateway.getRepository(repository)).rejects.toMatchObject({ message: "GitHub request failed." });
  });

  it.each(reads)("reclassifies a mid-body transport failure as a failed request for $name", async ({ run }) => {
    const apiUrl = await serve((_request, response) => {
      response.writeHead(200, { "Content-Length": "1024", Connection: "close" });
      response.end('{"id":');
    });
    const gateway = new GitHubGateway({ accessToken: "test-token", apiUrl });
    await expect(run(gateway)).rejects.toMatchObject({ message: "GitHub request failed." });
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

  it.each([
    { status: 200, message: "GitHub request timed out." },
    { status: 503, message: "GitHub API request failed with status 503." },
  ])("bounds an uncooperative injected body reader for HTTP $status", async ({ status, message }) => {
    vi.useFakeTimers();
    // Unlike a native stream, this reader never settles read(), even after
    // cancel() or releaseLock(). Only the request's body race can bound it.
    const reader = {
      read: vi.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {})),
      cancel: vi.fn(() => new Promise<void>(() => {})),
      releaseLock: vi.fn(),
    };
    const response = {
      ok: status === 200,
      status,
      headers: new Headers(),
      body: { getReader: () => reader },
    } as unknown as Response;
    const gateway = new GitHubGateway({
      accessToken: "test-token", timeoutMs: 1000,
      fetch: async () => response,
    });
    let outcome: unknown = "pending";
    void gateway.getRepository(repository).then(
      (value) => { outcome = { resolved: value }; },
      (error: unknown) => { outcome = error; },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ message });
    if (status === 503) {
      expect(outcome).toBeInstanceOf(GitHubApiError);
      expect(outcome).toMatchObject({ status: 503, body: null });
    }
  });

  it("bounds a body whose read stalls and whose cancellation never settles", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const gateway = new GitHubGateway({
      accessToken: "test-token", timeoutMs: 1000,
      fetch: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; return new Promise<void>(() => {}); },
      })),
    });
    let outcome: unknown = "pending";
    void gateway.getRepository(repository).then(
      (value) => { outcome = { resolved: value }; },
      (error: unknown) => { outcome = error; },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ message: "GitHub request timed out." });
    expect(cancelled).toBe(true);
  }, 3000);

  describe.each([
    ...reads,
    { name: "first label page via ensureDifficultyLabels", run: (gateway: GitHubGateway) => gateway.ensureDifficultyLabels(repository, []), body: "[]", result: undefined },
    { name: "deleteWebhook", run: (gateway: GitHubGateway) => gateway.deleteWebhook(repository, 42), body: "", result: undefined },
    { name: "label creation POST", run: (gateway: GitHubGateway) => gateway.ensureDifficultyLabels(repository, ["easy"]), body: '{"name":"easy"}', result: undefined },
  ])("configured deadline for $name", ({ name, run, body, result }) => {
    function afterLabelPrerequisite(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
      return (input, init) => {
        if (name === "listLabelNames via ensureDifficultyLabels" && String(input).endsWith("page=1")) {
          // Finish page one so the timed response exercises pagination's next request.
          return Promise.resolve(new Response("[]", { headers: { link: '</labels?page=2>; rel="next"' } }));
        }
        if (name === "label creation POST" && init?.method !== "POST") {
          return Promise.resolve(new Response("[]"));
        }
        return fetch(input, init);
      };
    }

    it("stays pending at 999 ms and times out at 1000 ms despite delayed headers and trickling bytes", async () => {
      vi.useFakeTimers();
      let delivery: ReturnType<typeof setInterval>;
      let cancelled = false;
      const gateway = new GitHubGateway({
        accessToken: "test-token", timeoutMs: 1000,
        fetch: afterLabelPrerequisite(() => new Promise((resolve) => setTimeout(() => resolve(new Response(new ReadableStream({
          start(controller) { delivery = setInterval(() => controller.enqueue(new TextEncoder().encode(" ")), 100); },
          cancel() { cancelled = true; clearInterval(delivery); },
        }))), 400))),
      });
      let outcome: unknown = "pending";
      void run(gateway).then(
        (value) => { outcome = { resolved: value }; },
        (error: unknown) => { outcome = error; },
      );

      await vi.advanceTimersByTimeAsync(999);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(Error);
      expect(outcome).toMatchObject({ message: "GitHub request timed out." });
      expect(cancelled).toBe(true);
    }, 3000);

    it("resolves a body completed at 900 ms after headers at 400 ms within a 1000 ms budget", async () => {
      vi.useFakeTimers();
      let completion: ReturnType<typeof setTimeout>;
      const gateway = new GitHubGateway({
        accessToken: "test-token", timeoutMs: 1000,
        fetch: afterLabelPrerequisite(() => new Promise((resolve) => setTimeout(() => resolve(new Response(new ReadableStream({
          start(controller) {
            completion = setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            }, 500);
          },
          cancel() { clearTimeout(completion); },
        }))), 400))),
      });
      let outcome: unknown = "pending";
      void run(gateway).then(
        (value) => { outcome = { resolved: value }; },
        (error: unknown) => { outcome = error; },
      );

      await vi.advanceTimersByTimeAsync(899);
      expect(outcome).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toEqual({ resolved: result });
      await vi.advanceTimersByTimeAsync(100);
      expect(outcome).toEqual({ resolved: result });
    }, 3000);
  });
});
